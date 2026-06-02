const { Annotation, StateGraph, START, END } = require('@langchain/langgraph');
const { HumanMessage, SystemMessage, AIMessage, ToolMessage } = require('@langchain/core/messages');
const { ChatOpenAI } = require('@langchain/openai');

const { listRuns, listSessions, listErrors, getPatterns, getSessionAnalysis } = require('./db');
const { isMemoryEnabled, searchMemories, addMemory } = require('./memory');
const { getRecentHistory } = require('./coach-session');

const HISTORY_LIMIT = 20;
const SESSION_LIMIT = 24;
const ERROR_LIMIT = 24;
const CONTEXT_CHAR_LIMIT = 12000;
const TOOL_LOOP_MAX_ITERATIONS = 4;

class LlmConfigError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'LlmConfigError';
    this.statusCode = 400;
    this.hint = hint;
  }
}

class LlmRuntimeError extends Error {
  constructor(message, statusCode = 500, hint = '') {
    super(message);
    this.name = 'LlmRuntimeError';
    this.statusCode = statusCode;
    this.hint = hint;
  }
}

const GMAT_REFERENCE = `GMAT Focus reference (use these as authoritative when judging timing/score):
- Section scale: 60–90 per section. Total: 205–805. Each section ~45 min, 21 questions (Q/V), DI 20 questions.
- Per-question pacing targets: Quant ≈ 2:09, Verbal ≈ 1:53, DI ≈ 2:15 (excluding multi-part). Flag any topic where avg time exceeds target by >25%.
- "Hard" / 705+ scorer benchmarks: section accuracy ≥ 80% AND avg time within target.
- Mistake-tag taxonomy v2 — 23 consolidated tags (use exact labels when categorizing root causes):
  • Core Reasoning / Process: Misread (Passage / Question / Condition); Wrong Setup (Variable / Equation / Structure); Invalid Assumption; Incomplete Casework; Calculation Slip (Computation / Unit / Sign / Careless); Logic Breakdown (Wrong Inference or Relationship).
  • Data Handling / DI-Specific: Chart/Table Misread; Multi-Source: Missed Cross-Link; Two-Part: Pairing/Order Error; Composite / Multi-Select: Wrong Slot.
  • Verbal / Reading (RC traps first, then CR): RC Trap: Too Extreme; RC Trap: Out of Scope; RC Trap: Opposite Direction; RC Trap: Half-Right; RC Trap: Wrong Paragraph; CR: Missed Negation/Qualifier; CR: Scope Shift (Premise vs Conclusion); CR: Confused Author Tone; Pre-phrase Mismatch (Skipped Pre-phrasing).
  • Test Strategy / Process: Chose Too Early; Could Not Start / No Plan; Overinvested Time (>2x median); Re-read Loop (Got Stuck Re-reading).
- When you encounter older entries tagged with retired labels (e.g., Calculation Error, Misread Passage, Wrong Logical Relationship, Stuck in Algebra), translate them to the closest v2 tag in your reasoning, but preserve the original string when quoting historical data.`;

function parseOptionalRunId(value) {
  if (value === null || value === undefined || value === '') return null;
  const runId = Number(value);
  if (!Number.isInteger(runId) || runId <= 0) return null;
  return runId;
}

function clipText(value, maxLen = 3000) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function formatPercent(numerator, denominator) {
  if (!denominator || denominator <= 0) return '0.0%';
  return `${((numerator * 100) / denominator).toFixed(1)}%`;
}

function formatDurationSeconds(value) {
  const total = Math.max(0, Math.floor(safeNumber(value, 0)));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function normalizeChatHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((item) => {
      const role = String(item?.role || '').trim().toLowerCase();
      const content = clipText(item?.content || '', 2000);
      if (!content) return null;
      if (role !== 'assistant' && role !== 'user') return null;
      return { role, content };
    })
    .filter(Boolean)
    .slice(-HISTORY_LIMIT);
}

function historyToMessages(history) {
  return normalizeChatHistory(history).map((entry) =>
    entry.role === 'assistant' ? new AIMessage(entry.content) : new HumanMessage(entry.content)
  );
}

function aiContentToText(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content.trim();
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (!Array.isArray(content)) return '';

  return content
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk;
      if (!chunk || typeof chunk !== 'object') return '';
      if (typeof chunk.text === 'string') return chunk.text;
      if (typeof chunk.output_text === 'string') return chunk.output_text;
      if (typeof chunk.content === 'string') return chunk.content;
      if (Array.isArray(chunk.content)) return aiContentToText(chunk.content);
      if (Array.isArray(chunk.summary)) return aiContentToText(chunk.summary);
      if (chunk.summary && typeof chunk.summary === 'string') return chunk.summary;
      if (chunk.reasoning && typeof chunk.reasoning === 'string') return chunk.reasoning;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractModelText(response) {
  const candidates = [
    aiContentToText(response?.content),
    aiContentToText(response?.text),
    aiContentToText(response?.additional_kwargs?.content),
    aiContentToText(response?.additional_kwargs?.output_text),
    aiContentToText(response?.additional_kwargs?.reasoning_content),
    aiContentToText(response?.response_metadata?.output_text),
  ].filter(Boolean);

  if (candidates[0]) return candidates[0];

  if (response?.content && typeof response.content === 'object') {
    const fallback = JSON.stringify(response.content);
    if (fallback && fallback !== '[]' && fallback !== '{}') return fallback;
  }
  if (response?.additional_kwargs && typeof response.additional_kwargs === 'object') {
    const fallback = JSON.stringify(response.additional_kwargs);
    if (fallback && fallback !== '[]' && fallback !== '{}') return fallback;
  }
  return '';
}

function classifyLlmError(error) {
  const statusCode = Number(
    error?.statusCode || error?.status || error?.response?.status || error?.cause?.status || 500
  );
  const text = String(error?.message || '').toLowerCase();

  if (statusCode === 429 || text.includes('insufficient balance') || text.includes('rate limit') || text.includes('resource package')) {
    return new LlmRuntimeError(
      'AI provider returned 429 (insufficient balance or rate limit).',
      429,
      'Check provider quota/billing, or switch to a cheaper model (OPENAI_MODEL / ZAI_MODEL).'
    );
  }
  if (statusCode === 404 || text.includes('not found')) {
    return new LlmRuntimeError(
      'AI provider endpoint not found.',
      404,
      'Use OPENAI default endpoint, or set ZAI_API_BASE=https://api.z.ai/api/paas/v4/ for Z AI.'
    );
  }
  if (statusCode === 401 || text.includes('invalid api key') || text.includes('unauthorized')) {
    return new LlmRuntimeError(
      'AI provider authentication failed.',
      401,
      'Check OPENAI_API_KEY / ZAI_API_KEY (or LLM_API_KEY) in .env.'
    );
  }

  return new LlmRuntimeError(error?.message || 'AI request failed.', Number.isInteger(statusCode) ? statusCode : 500);
}

function normalizeProvider(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'zai') return 'zai';
  if (key === 'openai') return 'openai';
  return '';
}

function scopedEnvName(scope, key) {
  const normalizedScope = String(scope || '').trim().toUpperCase();
  if (!normalizedScope) return key;
  return `${normalizedScope}_${key}`;
}

function getEnv(key, fallbackKeys = []) {
  for (const candidate of [key, ...fallbackKeys].filter(Boolean)) {
    const value = process.env[candidate];
    if (value !== undefined) return value;
  }
  return undefined;
}

function getScopedModelEnv(scope, key, fallbackKeys = []) {
  const scopedKeys = [scopedEnvName(scope, key), scopedEnvName(scope, 'LLM_MODEL'), ...fallbackKeys].filter(Boolean);
  for (const candidate of scopedKeys) {
    const value = process.env[candidate];
    if (value !== undefined) return value;
  }
  return undefined;
}

function resolveProvider(_scope = '') {
  const explicit = normalizeProvider(getEnv('LLM_PROVIDER'));
  if (explicit) return explicit;
  if (String(getEnv('ZAI_API_KEY', ['LLM_API_KEY']) || '').trim()) return 'zai';
  if (String(getEnv('OPENAI_API_KEY', ['OPENAI_API_KEY', 'LLM_API_KEY']) || '').trim()) return 'openai';
  const endpointHint = String(
    getEnv('ZAI_API_BASE', ['ZAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_BASE_URL', 'LLM_BASE_URL']) || ''
  ).trim().toLowerCase();
  if (endpointHint.includes('api.z.ai')) return 'zai';
  return 'openai';
}

function normalizedBaseUrl(value, { scope = '', envKey = 'OPENAI_API_BASE' } = {}) {
  const text = String(value || '').trim();
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_error) {
    throw new LlmConfigError(
      `Invalid base URL for ${scope ? 'question classification' : 'AI provider'} config.`,
      `Set ${envKey} to a full URL like https://api.openai.com/v1 or leave it blank to use the default endpoint.`
    );
  }
  const normalized = parsed.toString();
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function resolveConfiguredMaxTokens() {
  const raw = Number(getEnv('LLM_MAX_TOKENS'));
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

function buildModel({ disableMaxTokens = false, scope = '' } = {}) {
  const provider = resolveProvider(scope);
  const temperature = Number(getEnv('LLM_TEMPERATURE') ?? 0.2);
  const maxTokens = disableMaxTokens ? null : resolveConfiguredMaxTokens();
  const shared = {
    temperature: Number.isFinite(temperature) ? temperature : 0.2,
    maxRetries: 1,
    useResponsesApi: false,
  };
  if (Number.isInteger(maxTokens) && maxTokens > 0) shared.maxTokens = maxTokens;

  if (provider === 'zai') {
    const apiKey = String(getEnv('ZAI_API_KEY', ['LLM_API_KEY']) || '').trim();
    if (!apiKey) throw new LlmConfigError('Missing API key for AI coach.', 'Set ZAI_API_KEY (or LLM_API_KEY) in .env.');
    const baseURL = normalizedBaseUrl(
      getEnv('ZAI_API_BASE', ['ZAI_BASE_URL', 'OPENAI_API_BASE', 'LLM_BASE_URL']) || 'https://api.z.ai/api/paas/v4/',
      { scope, envKey: 'ZAI_API_BASE' }
    );
    const model = String(getScopedModelEnv(scope, 'ZAI_MODEL', ['ZAI_MODEL', 'LLM_MODEL']) || 'glm-5').trim();
    return new ChatOpenAI({
      ...shared,
      model,
      apiKey,
      configuration: { baseURL, defaultHeaders: { 'Accept-Language': 'en-US,en' } },
    });
  }

  const apiKey = String(getEnv('OPENAI_API_KEY', ['LLM_API_KEY']) || '').trim();
  if (!apiKey) throw new LlmConfigError('Missing API key for AI coach.', 'Set OPENAI_API_KEY (or LLM_API_KEY) in .env.');
  const model = String(getScopedModelEnv(scope, 'OPENAI_MODEL', ['OPENAI_MODEL', 'LLM_MODEL']) || 'gpt-5.4').trim();
  const openaiBase = normalizedBaseUrl(
    getEnv('OPENAI_API_BASE', ['OPENAI_BASE_URL', 'LLM_BASE_URL']) || '',
    { scope, envKey: 'OPENAI_API_BASE' }
  );
  const configuration = openaiBase ? { baseURL: openaiBase } : undefined;
  return new ChatOpenAI({ ...shared, model, apiKey, configuration });
}

// ---------- Coach tools ----------

const COACH_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'get_session_detail',
      description: 'Fetch full per-question detail for one session (timing, topic, mistake tags, notes). Use when the user asks about a specific session date or session id.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'integer', description: 'Internal sessions.id integer' },
        },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_errors',
      description: 'Search wrong answers with optional filters. Use to drill into a topic, mistake tag, difficulty, or text match. Returns up to 25 rows.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: "e.g. 'Quant', 'Verbal', 'Data Insights' (exact match)" },
          difficulty: { type: 'string', description: "e.g. 'Hard', 'Medium'" },
          topic: { type: 'string', description: 'Substring match on canonical topic label' },
          mistakeTag: { type: 'string', description: 'Exact mistake tag from taxonomy' },
          confidence: { type: 'string', description: "Optional: 'low', 'medium', 'high'" },
          search: { type: 'string', description: 'Free-text substring match against stem/notes' },
          platform: { type: 'string', enum: ['gmatclub', 'starttest'] },
          limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_full_patterns',
      description: 'Fetch the full aggregated patterns object: bySubject, byTopic, byDifficulty, confidenceMismatch (full lists, not pre-clipped).',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'integer', description: 'Optional run scope; omit for all data' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_recent_sessions',
      description: 'List recent sessions with summary stats. Use for trend questions or to find a session before drilling in.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 40, default: 15 },
          platform: { type: 'string', enum: ['gmatclub', 'starttest'] },
          runId: { type: 'integer' },
        },
      },
    },
  },
];

async function runCoachTool(name, args) {
  const safeArgs = args && typeof args === 'object' ? args : {};
  if (name === 'get_session_detail') {
    const sessionId = Number(safeArgs.sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) return { error: 'sessionId required (integer)' };
    const data = await getSessionAnalysis(sessionId);
    if (!data) return { error: `session ${sessionId} not found` };
    const questions = Array.isArray(data.questions) ? data.questions.slice(0, 30) : [];
    return {
      session: data.session,
      questionCount: Array.isArray(data.questions) ? data.questions.length : 0,
      questions: questions.map((q) => ({
        qCode: q.q_code,
        topic: q.topic,
        difficulty: q.difficulty,
        correct: !!q.correct,
        timeSec: q.time_sec,
        myAnswer: q.my_answer,
        correctAnswer: q.correct_answer,
        mistakeType: q.mistake_type || '',
        notes: clipText(q.notes || '', 200),
      })),
    };
  }
  if (name === 'find_errors') {
    const limit = Math.min(Math.max(Number(safeArgs.limit) || 10, 1), 25);
    const rows = await listErrors({
      runId: parseOptionalRunId(safeArgs.runId),
      subject: String(safeArgs.subject || ''),
      difficulty: String(safeArgs.difficulty || ''),
      topic: String(safeArgs.topic || ''),
      confidence: String(safeArgs.confidence || ''),
      search: String(safeArgs.search || ''),
      mistakeTag: String(safeArgs.mistakeTag || ''),
      platform: safeArgs.platform || '',
      sortKey: 'session_date',
      sortOrder: 'desc',
      limit,
      offset: 0,
    });
    return {
      count: rows.length,
      errors: rows.map((row) => ({
        sessionId: row.session_id,
        date: row.session_date,
        qCode: row.q_code,
        subject: row.subject,
        difficulty: row.difficulty,
        topic: row.topic,
        timeSec: row.time_sec,
        correctedLater: !!row.corrected_later,
        mistakeType: row.mistake_type || '',
        notes: clipText(row.notes || '', 200),
      })),
    };
  }
  if (name === 'get_full_patterns') {
    const runId = parseOptionalRunId(safeArgs.runId);
    return getPatterns(runId);
  }
  if (name === 'list_recent_sessions') {
    const limit = Math.min(Math.max(Number(safeArgs.limit) || 15, 1), 40);
    const rows = await listSessions(parseOptionalRunId(safeArgs.runId), {
      limit,
      offset: 0,
      platform: safeArgs.platform || undefined,
    });
    return {
      count: rows.length,
      sessions: rows.map((row) => ({
        sessionId: row.id,
        date: row.session_date,
        source: row.source,
        subject: row.subject,
        total: row.attempt_total,
        correct: row.attempt_correct,
        wrong: row.attempt_wrong,
        accuracyPct: formatPercent(row.attempt_correct, row.attempt_total),
        avgTime: formatDurationSeconds(row.avg_time_sec),
      })),
    };
  }
  return { error: `unknown tool: ${name}` };
}

// ---------- Performance context ----------

async function buildPerformanceContext(runIdInput) {
  const runId = parseOptionalRunId(runIdInput);

  const [runs, sessions, patterns, errors] = await Promise.all([
    listRuns(30),
    listSessions(runId, { limit: SESSION_LIMIT, offset: 0 }),
    getPatterns(runId),
    listErrors({
      runId, subject: '', difficulty: '', topic: '', confidence: '', search: '',
      sortKey: 'session_date', sortOrder: 'desc', limit: ERROR_LIMIT, offset: 0,
    }),
  ]);

  const answered = sessions.reduce((sum, row) => sum + safeNumber(row.attempt_total, 0), 0);
  const correct = sessions.reduce((sum, row) => sum + safeNumber(row.attempt_correct, 0), 0);
  const wrong = sessions.reduce((sum, row) => sum + safeNumber(row.attempt_wrong, 0), 0);

  const weightedAvgTime = sessions.reduce((sum, row) => {
    return sum + safeNumber(row.attempt_total, 0) * safeNumber(row.avg_time_sec, 0);
  }, 0);
  const avgTimeSec = answered > 0 ? Math.round(weightedAvgTime / answered) : 0;

  const totalAnnotated = errors.filter(
    (row) => String(row.mistake_type || '').trim() || String(row.notes || '').trim()
  ).length;

  const topSubjects = Array.isArray(patterns?.bySubject) ? patterns.bySubject.slice(0, 6) : [];
  const topTopics = Array.isArray(patterns?.byTopic) ? patterns.byTopic.slice(0, 8) : [];
  const byDifficulty = Array.isArray(patterns?.byDifficulty) ? patterns.byDifficulty.slice(0, 4) : [];
  const confidenceMismatch = Array.isArray(patterns?.confidenceMismatch) ? patterns.confidenceMismatch.slice(0, 5) : [];

  const recentSessions = sessions.slice(0, 8).map((row) => ({
    sessionId: row.id,
    date: row.session_date || '',
    subject: row.subject || 'Unknown',
    total: safeNumber(row.attempt_total, 0),
    wrong: safeNumber(row.attempt_wrong, 0),
    accuracyPct: formatPercent(safeNumber(row.attempt_correct, 0), safeNumber(row.attempt_total, 0)),
    avgTime: formatDurationSeconds(row.avg_time_sec),
  }));

  const recentErrors = errors.slice(0, 12).map((row) => ({
    qCode: row.q_code || 'Unknown',
    subject: row.subject || 'Unknown',
    difficulty: row.difficulty || 'Unknown',
    topic: row.topic || 'Unknown',
    time: formatDurationSeconds(row.time_sec),
    correctedLater: Number(row.corrected_later || 0) === 1,
    mistakeType: row.mistake_type || '',
    notes: row.notes || '',
  }));

  const latestRun = runs[0] || null;
  const scopeLabel = runId ? `Run ${runId}` : 'All upserted data';

  const contextLines = [
    `Scope: ${scopeLabel}`,
    `Latest run id (global): ${latestRun?.id ?? 'N/A'}`,
    `Sessions in scope sample: ${sessions.length}`,
    `Answered questions in sample: ${answered}`,
    `Correct in sample: ${correct} | Wrong: ${wrong} | Accuracy: ${formatPercent(correct, answered)}`,
    `Avg time per question in sample: ${formatDurationSeconds(avgTimeSec)}`,
    `Annotated errors in sampled recent errors: ${totalAnnotated}/${errors.length}`,
    '',
    'Top weak subjects (mistake counts):',
    ...topSubjects.map((row) => `- ${row.subject || 'Unknown'}: ${safeNumber(row.mistakes, 0)}`),
    '',
    'Top weak topics (mistake counts):',
    ...topTopics.map((row) => `- ${row.topic || 'Unknown'}: ${safeNumber(row.mistakes, 0)}`),
    '',
    'Difficulty performance snapshot:',
    ...byDifficulty.map((row) =>
      `- ${row.difficulty || 'Unknown'}: total=${safeNumber(row.total, 0)}, correct=${safeNumber(row.correct, 0)}, wrong=${safeNumber(row.wrong, 0)}, accuracy=${safeNumber(row.accuracy_pct, 0)}%, avg=${formatDurationSeconds(row.avg_time_sec)}`
    ),
    '',
    'Confidence mismatch snapshot (wrong answers):',
    ...confidenceMismatch.map((row) => `- ${row.confidence || 'not selected'}: ${safeNumber(row.wrong_answers, 0)}`),
    '',
    'Recent sessions (sessionId | date | subject | q | wrong | acc | avg):',
    ...recentSessions.map((row) =>
      `- ${row.sessionId} | ${row.date || 'Unknown date'} | ${row.subject} | q=${row.total} | wrong=${row.wrong} | acc=${row.accuracyPct} | avg=${row.avgTime}`
    ),
    '',
    'Recent errors (for pattern examples):',
    ...recentErrors.map((row) => {
      const correctionFlag = row.correctedLater ? 'corrected later' : 'not corrected yet';
      const notePart = row.notes ? ` | note=${clipText(row.notes, 80)}` : '';
      const mistakeTags = (() => {
        const v = row.mistakeType || '';
        if (!v) return [];
        if (v.startsWith('[')) { try { return JSON.parse(v); } catch { /* ignore */ } }
        return [v];
      })();
      const mistakePart = mistakeTags.length ? ` | type=${mistakeTags.join(', ')}` : '';
      return `- ${row.qCode} | ${row.subject}/${row.difficulty} | ${row.topic} | t=${row.time} | ${correctionFlag}${mistakePart}${notePart}`;
    }),
  ];

  return {
    meta: {
      scopeLabel,
      runId,
      sampledSessions: sessions.length,
      sampledErrors: errors.length,
      accuracyPct: Number(((correct * 100) / (answered || 1)).toFixed(1)),
      answered,
      wrong,
      annotatedSampledErrors: totalAnnotated,
      topSubjects: topSubjects.map((r) => r.subject).filter(Boolean),
      topTopics: topTopics.map((r) => r.topic).filter(Boolean),
    },
    contextText: clipText(contextLines.join('\n'), CONTEXT_CHAR_LIMIT),
  };
}

// ---------- Graph state + nodes ----------

const CoachGraphState = Annotation.Root({
  mode: Annotation(),
  runId: Annotation(),
  focus: Annotation(),
  question: Annotation(),
  sessionId: Annotation(),
  history: Annotation(),
  contextText: Annotation(),
  contextMeta: Annotation(),
  memories: Annotation(),
  userPrompt: Annotation(),
  responseText: Annotation(),
});

function modeRouter(state) {
  return state.mode === 'chat' ? 'buildChatPrompt' : 'buildReviewPrompt';
}

function buildReviewPrompt(state) {
  const focus = clipText(state.focus || '', 500);
  return {
    userPrompt: [
      'Generate a concise GMAT performance review from the provided data context. Be specific, terse, and actionable.',
      'Output structure (use markdown headings, keep total under ~450 words):',
      '## Diagnosis',
      '- 3-5 bullets, each citing a concrete metric or topic from context.',
      '## Priority fixes',
      '- 2-4 ranked items. State why each matters for score.',
      '## 7-day plan',
      '- Daily list (Day 1-7), one line each: topic + time budget + drill type.',
      '## Next-session checklist',
      '- 4-5 short imperatives.',
      focus ? `Extra focus: ${focus}` : '',
      'If data is sparse, state what is missing in one line and still produce a plan.',
    ].filter(Boolean).join('\n'),
  };
}

function buildChatPrompt(state) {
  const question = clipText(state.question || '', 1200);
  return {
    userPrompt: [
      'Answer using the performance context above and the available tools when you need detail not in context.',
      'Default to short answers: 3-6 bullets or 1-2 short paragraphs. Cite specific topics, metrics, or session ids when relevant.',
      'If you need per-session detail, call get_session_detail. If drilling into a topic/mistake-tag, call find_errors. If you need full pattern aggregates, call get_full_patterns.',
      `User question: ${question}`,
    ].join('\n'),
  };
}

function systemPromptForMode(mode) {
  const baseRules = [
    'You are a GMAT coach analyzing this student\'s performance data.',
    'Be terse. Prefer bullet points over prose. No filler ("Certainly!", "Great question").',
    'Do not invent metrics. If a number is not in context or returned by a tool, say so.',
    'When you cite a session, include its sessionId. When you cite a topic, use the canonical label.',
  ];
  if (mode === 'chat') {
    return [
      ...baseRules,
      'Use tools sparingly — only call when the answer requires data not in the context block.',
      'After tool results return, produce the final answer; do not call more tools unless strictly needed.',
      '',
      GMAT_REFERENCE,
    ].join('\n');
  }
  return [
    ...baseRules,
    'Mode: performance review. Prioritize high-impact fixes; flag timing+accuracy tradeoffs explicitly.',
    '',
    GMAT_REFERENCE,
  ].join('\n');
}

async function loadContextNode(state) {
  const snapshot = await buildPerformanceContext(state.runId);
  return { contextText: snapshot.contextText, contextMeta: snapshot.meta };
}

async function loadSessionHistoryNode(state) {
  if (!state.sessionId) return { history: [] };
  try {
    const messages = await getRecentHistory(state.sessionId, HISTORY_LIMIT);
    return { history: messages };
  } catch (err) {
    console.warn('[coach] failed to load session history:', err.message);
    return { history: [] };
  }
}

function buildMemoryQuery(state) {
  if (state.mode === 'chat') return clipText(state.question || '', 500);
  const meta = state.contextMeta || {};
  const seedParts = [
    state.focus || '',
    'GMAT performance review',
    Array.isArray(meta.topSubjects) ? meta.topSubjects.slice(0, 3).join(' ') : '',
    Array.isArray(meta.topTopics) ? meta.topTopics.slice(0, 3).join(' ') : '',
  ].filter(Boolean);
  return clipText(seedParts.join(' | '), 400);
}

async function loadMemoriesNode(state) {
  if (!isMemoryEnabled()) return { memories: [] };
  const query = buildMemoryQuery(state);
  if (!query.trim()) return { memories: [] };
  const results = await searchMemories(query, { limit: 5 });
  const memoryTexts = results
    .map((r) => (typeof r === 'string' ? r : (r?.memory || r?.text || r?.content || '')))
    .map((t) => String(t).trim())
    .filter(Boolean);
  return { memories: memoryTexts };
}

async function saveMemoryNode(state) {
  if (!isMemoryEnabled()) return {};
  if (!state.responseText || state.responseText === 'No response generated.') return {};

  const mode = state.mode || 'chat';
  const userPart = mode === 'chat'
    ? state.question || ''
    : `Performance review${state.focus ? ` (focus: ${clipText(state.focus, 200)})` : ''}`;

  const messages = [
    { role: 'user', content: clipText(userPart, 400) },
    { role: 'assistant', content: clipText(state.responseText, 1000) },
  ];
  const metadata = {
    mode,
    runId: state.runId ? String(state.runId) : null,
    sessionId: state.sessionId || null,
    timestamp: new Date().toISOString(),
  };

  await addMemory(messages, metadata);
  return {};
}

function buildBaseMessages(state) {
  const memoryBlock = Array.isArray(state.memories) && state.memories.length > 0
    ? `Coaching memory from previous sessions:\n${state.memories.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
    : '';
  return [
    new SystemMessage(systemPromptForMode(state.mode)),
    new SystemMessage(`Performance context:\n${state.contextText}`),
    ...(memoryBlock ? [new SystemMessage(memoryBlock)] : []),
    ...historyToMessages(state.history),
    new HumanMessage(state.userPrompt),
  ];
}

function getToolCalls(response) {
  if (Array.isArray(response?.tool_calls) && response.tool_calls.length > 0) return response.tool_calls;
  const additional = response?.additional_kwargs?.tool_calls;
  if (Array.isArray(additional) && additional.length > 0) {
    return additional.map((call) => ({
      id: call.id,
      name: call.function?.name,
      args: (() => { try { return JSON.parse(call.function?.arguments || '{}'); } catch { return {}; } })(),
    }));
  }
  return [];
}

async function callModelWithTools(state) {
  const baseModel = buildModel();
  const useTools = state.mode === 'chat';
  const model = useTools ? baseModel.bindTools(COACH_TOOL_SPECS) : baseModel;
  const messages = buildBaseMessages(state);

  let iterations = 0;
  let lastResponse = null;

  while (iterations < TOOL_LOOP_MAX_ITERATIONS) {
    const response = await model.invoke(messages);
    lastResponse = response;
    messages.push(response);

    const toolCalls = useTools ? getToolCalls(response) : [];
    if (toolCalls.length === 0) break;

    for (const call of toolCalls) {
      let resultPayload;
      try {
        const result = await runCoachTool(call.name, call.args || {});
        resultPayload = JSON.stringify(result);
      } catch (err) {
        resultPayload = JSON.stringify({ error: err.message || 'tool failed' });
      }
      messages.push(new ToolMessage({
        tool_call_id: call.id,
        name: call.name,
        content: clipText(resultPayload, 6000),
      }));
    }
    iterations += 1;
  }

  return { response: lastResponse, messages };
}

async function llmResponseNode(state) {
  try {
    let { response, messages } = await callModelWithTools(state);
    let text = extractModelText(response);

    const hasToolCallShape =
      Boolean(response?.additional_kwargs?.function_call) ||
      (Array.isArray(response?.additional_kwargs?.tool_calls) && response.additional_kwargs.tool_calls.length > 0) ||
      (Array.isArray(response?.tool_calls) && response.tool_calls.length > 0);

    if (!text && hasToolCallShape) {
      const baseModel = buildModel();
      const retryMessages = [
        ...messages,
        new SystemMessage('Do not call any tools or functions. Respond with plain text only.'),
      ];
      response = await baseModel.invoke(retryMessages);
      text = extractModelText(response);
    }

    const completionTokens = Number(response?.response_metadata?.tokenUsage?.completionTokens || 0);
    const configuredMaxTokens = resolveConfiguredMaxTokens();
    const likelyCapped = Number.isInteger(configuredMaxTokens) && configuredMaxTokens > 0
      && completionTokens >= Math.max(1, configuredMaxTokens - 2);

    if (!text && likelyCapped) {
      const retryModel = buildModel({ disableMaxTokens: true });
      response = await retryModel.invoke([
        ...messages,
        new SystemMessage('Provide concise plain-text output only. Keep your answer under 450 words.'),
      ]);
      text = extractModelText(response);
    }

    if (!text) text = 'No response generated.';

    if (text === 'No response generated.' && String(process.env.LLM_DEBUG || '').trim() === '1') {
      console.warn('[llm-coach-agent] empty model response', {
        contentType: typeof response?.content,
        contentIsArray: Array.isArray(response?.content),
        contentPreview: String(response?.content || '').slice(0, 120),
        promptTokens: Number(response?.response_metadata?.tokenUsage?.promptTokens || 0),
        completionTokens: Number(response?.response_metadata?.tokenUsage?.completionTokens || 0),
        configuredMaxTokens,
      });
    }

    return { responseText: text };
  } catch (error) {
    throw classifyLlmError(error);
  }
}

let compiledGraph = null;

function getGraph() {
  if (compiledGraph) return compiledGraph;

  compiledGraph = new StateGraph(CoachGraphState)
    .addNode('loadContext', loadContextNode)
    .addNode('loadSessionHistory', loadSessionHistoryNode)
    .addNode('buildReviewPrompt', buildReviewPrompt)
    .addNode('buildChatPrompt', buildChatPrompt)
    .addNode('loadMemories', loadMemoriesNode)
    .addNode('callModel', llmResponseNode)
    .addNode('saveMemory', saveMemoryNode)
    .addEdge(START, 'loadContext')
    .addEdge('loadContext', 'loadSessionHistory')
    .addConditionalEdges('loadSessionHistory', modeRouter, {
      buildReviewPrompt: 'buildReviewPrompt',
      buildChatPrompt: 'buildChatPrompt',
    })
    .addEdge('buildReviewPrompt', 'loadMemories')
    .addEdge('buildChatPrompt', 'loadMemories')
    .addEdge('loadMemories', 'callModel')
    .addEdge('callModel', 'saveMemory')
    .addEdge('saveMemory', END)
    .compile();

  return compiledGraph;
}

async function runCoachGraph({ mode, runId, focus, question, sessionId }) {
  const graph = getGraph();
  const result = await graph.invoke({
    mode,
    runId: parseOptionalRunId(runId),
    focus: String(focus || '').trim(),
    question: String(question || '').trim(),
    sessionId: sessionId || null,
    history: [],
    contextText: '',
    contextMeta: null,
    memories: [],
    userPrompt: '',
    responseText: '',
  });
  return {
    text: String(result.responseText || '').trim(),
    contextMeta: result.contextMeta || null,
  };
}

async function generatePerformanceReview({ runId = null, focus = '', sessionId = null } = {}) {
  return runCoachGraph({ mode: 'review', runId, focus, question: '', sessionId });
}

async function answerCoachQuestion({ runId = null, question = '', sessionId = null } = {}) {
  const cleanQuestion = String(question || '').trim();
  if (!cleanQuestion) {
    throw new LlmConfigError('Question is required for chat.', 'Provide a non-empty question.');
  }
  return runCoachGraph({ mode: 'chat', runId, focus: '', question: cleanQuestion, sessionId });
}

module.exports = {
  LlmConfigError,
  buildModel,
  extractModelText,
  classifyLlmError,
  generatePerformanceReview,
  answerCoachQuestion,
};
