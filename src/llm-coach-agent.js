const { Annotation, StateGraph, START, END } = require('@langchain/langgraph');
const { HumanMessage, SystemMessage, AIMessage } = require('@langchain/core/messages');
const { ChatOpenAI } = require('@langchain/openai');

const { listRuns, listSessions, listErrors, getPatterns } = require('./db');

const HISTORY_LIMIT = 8;
const SESSION_LIMIT = 24;
const ERROR_LIMIT = 24;
const CONTEXT_CHAR_LIMIT = 12000;

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
    if (fallback && fallback !== '[]' && fallback !== '{}') {
      return fallback;
    }
  }

  if (response?.additional_kwargs && typeof response.additional_kwargs === 'object') {
    const fallback = JSON.stringify(response.additional_kwargs);
    if (fallback && fallback !== '[]' && fallback !== '{}') {
      return fallback;
    }
  }

  return '';
}

function classifyLlmError(error) {
  const statusCode = Number(
    error?.statusCode || error?.status || error?.response?.status || error?.cause?.status || 500
  );
  const text = String(error?.message || '').toLowerCase();

  if (
    statusCode === 429 ||
    text.includes('insufficient balance') ||
    text.includes('rate limit') ||
    text.includes('resource package')
  ) {
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

  return new LlmRuntimeError(
    error?.message || 'AI request failed.',
    Number.isInteger(statusCode) ? statusCode : 500
  );
}

function normalizeProvider(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'zai') return 'zai';
  if (key === 'openai') return 'openai';
  return '';
}

function resolveProvider() {
  const explicit = normalizeProvider(process.env.LLM_PROVIDER);
  if (explicit) return explicit;

  if (String(process.env.ZAI_API_KEY || '').trim()) return 'zai';
  if (String(process.env.OPENAI_API_KEY || '').trim()) return 'openai';

  const endpointHint = String(
    process.env.ZAI_API_BASE ||
      process.env.ZAI_BASE_URL ||
      process.env.OPENAI_API_BASE ||
      process.env.OPENAI_BASE_URL ||
      process.env.LLM_BASE_URL ||
      ''
  )
    .trim()
    .toLowerCase();
  if (endpointHint.includes('api.z.ai')) return 'zai';

  return 'openai';
}

function normalizedBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.endsWith('/') ? text : `${text}/`;
}

function resolveConfiguredMaxTokens() {
  const raw = Number(process.env.LLM_MAX_TOKENS);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

function buildModel({ disableMaxTokens = false } = {}) {
  const provider = resolveProvider();
  const temperature = Number(process.env.LLM_TEMPERATURE ?? 0.2);
  const maxTokens = disableMaxTokens ? null : resolveConfiguredMaxTokens();
  const shared = {
    temperature: Number.isFinite(temperature) ? temperature : 0.2,
    maxRetries: 1,
    useResponsesApi: false,
  };
  if (Number.isInteger(maxTokens) && maxTokens > 0) {
    shared.maxTokens = maxTokens;
  }

  if (provider === 'zai') {
    const apiKey = String(process.env.ZAI_API_KEY || process.env.LLM_API_KEY || '').trim();
    if (!apiKey) {
      throw new LlmConfigError(
        'Missing API key for AI coach.',
        'Set ZAI_API_KEY (or LLM_API_KEY) in .env.'
      );
    }

    const baseURL = normalizedBaseUrl(
      process.env.ZAI_API_BASE ||
        process.env.ZAI_BASE_URL ||
        process.env.OPENAI_API_BASE ||
        process.env.LLM_BASE_URL ||
        'https://api.z.ai/api/paas/v4/'
    );
    const model = String(process.env.ZAI_MODEL || process.env.LLM_MODEL || 'glm-5').trim();

    return new ChatOpenAI({
      ...shared,
      model,
      apiKey,
      configuration: {
        baseURL,
        defaultHeaders: {
          'Accept-Language': 'en-US,en',
        },
      },
    });
  }

  const apiKey = String(process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '').trim();
  if (!apiKey) {
    throw new LlmConfigError(
      'Missing API key for AI coach.',
      'Set OPENAI_API_KEY (or LLM_API_KEY) in .env.'
    );
  }
  const model = String(process.env.OPENAI_MODEL || process.env.LLM_MODEL || 'gpt-4o-mini').trim();
  const openaiBase = normalizedBaseUrl(
    process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || ''
  );
  const configuration = openaiBase ? { baseURL: openaiBase } : undefined;

  return new ChatOpenAI({
    ...shared,
    model,
    apiKey,
    configuration,
  });
}

async function buildPerformanceContext(runIdInput) {
  const runId = parseOptionalRunId(runIdInput);

  const [runs, sessions, patterns, errors] = await Promise.all([
    listRuns(30),
    listSessions(runId, { limit: SESSION_LIMIT, offset: 0 }),
    getPatterns(runId),
    listErrors({
      runId,
      subject: '',
      difficulty: '',
      topic: '',
      confidence: '',
      search: '',
      sortKey: 'session_date',
      sortOrder: 'desc',
      limit: ERROR_LIMIT,
      offset: 0,
    }),
  ]);

  const answered = sessions.reduce((sum, row) => sum + safeNumber(row.attempt_total, 0), 0);
  const correct = sessions.reduce((sum, row) => sum + safeNumber(row.attempt_correct, 0), 0);
  const wrong = sessions.reduce((sum, row) => sum + safeNumber(row.attempt_wrong, 0), 0);

  const weightedAvgTime = sessions.reduce((sum, row) => {
    const attempts = safeNumber(row.attempt_total, 0);
    const avgTime = safeNumber(row.avg_time_sec, 0);
    return sum + attempts * avgTime;
  }, 0);
  const avgTimeSec = answered > 0 ? Math.round(weightedAvgTime / answered) : 0;

  const totalAnnotated = errors.filter(
    (row) => String(row.mistake_type || '').trim() || String(row.notes || '').trim()
  ).length;

  const topSubjects = Array.isArray(patterns?.bySubject) ? patterns.bySubject.slice(0, 6) : [];
  const topTopics = Array.isArray(patterns?.byTopic) ? patterns.byTopic.slice(0, 8) : [];
  const byDifficulty = Array.isArray(patterns?.byDifficulty) ? patterns.byDifficulty.slice(0, 4) : [];
  const confidenceMismatch = Array.isArray(patterns?.confidenceMismatch)
    ? patterns.confidenceMismatch.slice(0, 5)
    : [];

  const recentSessions = sessions.slice(0, 8).map((row) => {
    const qTotal = safeNumber(row.attempt_total, 0);
    const qWrong = safeNumber(row.attempt_wrong, 0);
    const qCorrect = safeNumber(row.attempt_correct, 0);
    return {
      date: row.session_date || '',
      subject: row.subject || 'Unknown',
      total: qTotal,
      wrong: qWrong,
      accuracyPct: formatPercent(qCorrect, qTotal),
      avgTime: formatDurationSeconds(row.avg_time_sec),
    };
  });

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
    `Correct in sample: ${correct}`,
    `Wrong in sample: ${wrong}`,
    `Accuracy in sample: ${formatPercent(correct, answered)}`,
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
    ...byDifficulty.map(
      (row) =>
        `- ${row.difficulty || 'Unknown'}: total=${safeNumber(row.total, 0)}, correct=${safeNumber(
          row.correct,
          0
        )}, wrong=${safeNumber(row.wrong, 0)}, accuracy=${safeNumber(row.accuracy_pct, 0)}%, avg=${formatDurationSeconds(
          row.avg_time_sec
        )}`
    ),
    '',
    'Confidence mismatch snapshot (wrong answers):',
    ...confidenceMismatch.map(
      (row) => `- ${row.confidence || 'not selected'}: ${safeNumber(row.wrong_answers, 0)}`
    ),
    '',
    'Recent sessions:',
    ...recentSessions.map(
      (row) =>
        `- ${row.date || 'Unknown date'} | ${row.subject} | q=${row.total} | wrong=${row.wrong} | acc=${row.accuracyPct} | avg=${row.avgTime}`
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
    },
    contextText: clipText(contextLines.join('\n'), CONTEXT_CHAR_LIMIT),
  };
}

const CoachGraphState = Annotation.Root({
  mode: Annotation(),
  runId: Annotation(),
  focus: Annotation(),
  question: Annotation(),
  history: Annotation(),
  contextText: Annotation(),
  contextMeta: Annotation(),
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
      'Create a GMAT performance review from the provided data context.',
      'Output structure:',
      '1) Diagnosis (3-6 bullets with concrete evidence from data)',
      '2) Priority fixes (ranked, with why each matters for score)',
      '3) 7-day drill plan (daily tasks with topic and suggested time budget)',
      '4) Next-session checklist (5 concise items)',
      focus ? `Extra focus requested by user: ${focus}` : '',
      'If data is sparse, explicitly say what is missing and still provide a practical plan.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function buildChatPrompt(state) {
  const question = clipText(state.question || '', 1200);
  return {
    userPrompt: [
      'Answer the user question using the GMAT performance context provided earlier in this run.',
      'Keep advice practical and tied to observed error patterns and timing behavior.',
      'If the question asks for unsupported information, say what is missing and provide best-effort guidance.',
      `User question: ${question}`,
    ].join('\n'),
  };
}

function systemPromptForMode(mode) {
  if (mode === 'chat') {
    return [
      'You are a GMAT coach helping improve score via data-driven recommendations.',
      'Be specific with topic names, timing targets, and practice sequence.',
      'Do not invent metrics that are not in context.',
    ].join(' ');
  }

  return [
    'You are a GMAT performance reviewer.',
    'Analyze progress and error patterns, then provide actionable steps to improve GMAT score.',
    'Prioritize high-impact actions and highlight timing + accuracy tradeoffs.',
    'Do not fabricate facts. Use only data in context.',
  ].join(' ');
}

async function loadContextNode(state) {
  const snapshot = await buildPerformanceContext(state.runId);
  return {
    contextText: snapshot.contextText,
    contextMeta: snapshot.meta,
  };
}

async function llmResponseNode(state) {
  const model = buildModel();
  const messages = [
    new SystemMessage(systemPromptForMode(state.mode)),
    new SystemMessage(`Performance context:\n${state.contextText}`),
    ...historyToMessages(state.history),
    new HumanMessage(state.userPrompt),
  ];

  try {
    let response = await model.invoke(messages);

    let text = extractModelText(response);
    const hasToolCallShape =
      Boolean(response?.additional_kwargs?.function_call) ||
      (Array.isArray(response?.additional_kwargs?.tool_calls) &&
        response.additional_kwargs.tool_calls.length > 0) ||
      (Array.isArray(response?.tool_calls) && response.tool_calls.length > 0);

    // Some models can emit an empty content + tool-call payload even when no tools are configured.
    // Retry once with an explicit no-tool instruction to force plain text output.
    if (!text && hasToolCallShape) {
      response = await model.invoke(
        [
          ...messages,
          new SystemMessage(
            'Do not call any tools or functions. Respond with plain text only.'
          ),
        ]
      );
      text = extractModelText(response);
    }

    const completionTokens = Number(response?.response_metadata?.tokenUsage?.completionTokens || 0);
    const configuredMaxTokens = resolveConfiguredMaxTokens();
    const likelyCapped =
      Number.isInteger(configuredMaxTokens) &&
      configuredMaxTokens > 0 &&
      completionTokens >= Math.max(1, configuredMaxTokens - 2);

    if (!text && likelyCapped) {
      const retryModel = buildModel({ disableMaxTokens: true });
      response = await retryModel.invoke([
        ...messages,
        new SystemMessage(
          'Provide concise plain-text output only. Keep your answer under 450 words.'
        ),
      ]);
      text = extractModelText(response);
    }

    if (!text) {
      text = 'No response generated.';
    }

    if (text === 'No response generated.' && String(process.env.LLM_DEBUG || '').trim() === '1') {
      // eslint-disable-next-line no-console
      console.warn('[llm-coach-agent] empty model response', {
        contentType: typeof response?.content,
        contentIsArray: Array.isArray(response?.content),
        contentPreview: String(response?.content || '').slice(0, 120),
        promptTokens: Number(response?.response_metadata?.tokenUsage?.promptTokens || 0),
        completionTokens: Number(response?.response_metadata?.tokenUsage?.completionTokens || 0),
        configuredMaxTokens: resolveConfiguredMaxTokens(),
        functionCall: response?.additional_kwargs?.function_call || null,
        toolCallsInAdditionalKwargs: Array.isArray(response?.additional_kwargs?.tool_calls)
          ? response.additional_kwargs.tool_calls.length
          : null,
        toolCalls: Array.isArray(response?.tool_calls) ? response.tool_calls.length : null,
        responseMetadataKeys: Object.keys(response?.response_metadata || {}),
        additionalKwargKeys: Object.keys(response?.additional_kwargs || {}),
      });
    }

    return {
      responseText: text,
    };
  } catch (error) {
    throw classifyLlmError(error);
  }
}

let compiledGraph = null;

function getGraph() {
  if (compiledGraph) return compiledGraph;

  compiledGraph = new StateGraph(CoachGraphState)
    .addNode('loadContext', loadContextNode)
    .addNode('buildReviewPrompt', buildReviewPrompt)
    .addNode('buildChatPrompt', buildChatPrompt)
    .addNode('callModel', llmResponseNode)
    .addEdge(START, 'loadContext')
    .addConditionalEdges('loadContext', modeRouter, {
      buildReviewPrompt: 'buildReviewPrompt',
      buildChatPrompt: 'buildChatPrompt',
    })
    .addEdge('buildReviewPrompt', 'callModel')
    .addEdge('buildChatPrompt', 'callModel')
    .addEdge('callModel', END)
    .compile();

  return compiledGraph;
}

async function runCoachGraph({ mode, runId, focus, question, history }) {
  const graph = getGraph();

  const result = await graph.invoke({
    mode,
    runId: parseOptionalRunId(runId),
    focus: String(focus || '').trim(),
    question: String(question || '').trim(),
    history: normalizeChatHistory(history),
    contextText: '',
    contextMeta: null,
    userPrompt: '',
    responseText: '',
  });

  return {
    text: String(result.responseText || '').trim(),
    contextMeta: result.contextMeta || null,
  };
}

async function generatePerformanceReview({ runId = null, focus = '' } = {}) {
  return runCoachGraph({
    mode: 'review',
    runId,
    focus,
    question: '',
    history: [],
  });
}

async function answerCoachQuestion({ runId = null, question = '', history = [] } = {}) {
  const cleanQuestion = String(question || '').trim();
  if (!cleanQuestion) {
    throw new LlmConfigError('Question is required for chat.', 'Provide a non-empty question.');
  }

  return runCoachGraph({
    mode: 'chat',
    runId,
    focus: '',
    question: cleanQuestion,
    history,
  });
}

module.exports = {
  LlmConfigError,
  generatePerformanceReview,
  answerCoachQuestion,
};
