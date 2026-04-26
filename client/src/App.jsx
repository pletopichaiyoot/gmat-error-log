import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from './components/ui/card';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { Select } from './components/ui/select';

const DEFAULT_CDP_URL = 'http://localhost:9222';

const MISTAKE_TYPES = {
  'Core Reasoning / Process': [
    'Misread Condition',
    'Wrong Variable Setup',
    'Failed to Translate',
    'Missed Constraint',
    'Invalid Assumption',
    'Incomplete Casework',
    'Wrong Order/Pairing',
    'Calculation Error',
    'Unit/Scale Error',
    'Sign/Direction Error',
    'Conceptual Gap',
    'Logic Breakdown',
    'Careless / Sloppy Error',
  ],
  'Data Handling / DI-Specific': [
    'Data Extraction Error',
    'Chart/Table Misread',
    'Two-Part: Order Reversal',
    'Two-Part: Pairing Logic Error',
    'Composite: Wrong Slot',
    'Multi-Select: Partial Answer',
    'Table Analysis: Filter Miss',
    'Table Analysis: Final Step Slip',
    'Graphics: Axis/Label Misread',
    'Graphics: Trend Misread',
    'MSR: Missed Cross-Source Link',
  ],
  'Verbal / Reading': [
    'Misread Passage',
    'Misread Question',
    'Missed Negation/Qualifier',
    'Out of Scope Inference',
    'Scope Shift',
    'Missed Author Tone',
    'Wrong Logical Relationship',
    'Confused Answer Choices',
  ],
  'Test Strategy / Process': [
    'Eliminated Correct Choice',
    'Chose Too Early',
    'Could Not Start / No Plan',
    'Overinvested Time',
    'Rushed Guess',
    'Switched from Correct Path',
    'Stuck in Algebra',
    'Re-read Too Much',
    'Unfamiliar Format',
  ],
};

const ALL_MISTAKE_TAGS = Object.values(MISTAKE_TYPES).flat();

function parseMistakeTags(value) {
  if (!value) return [];
  if (typeof value === 'string' && value.startsWith('[')) {
    try {
      return JSON.parse(value);
    } catch {
      // fall through
    }
  }
  return [value];
}

function formatDate(value) {
  if (!value) return '-';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleDateString();
}

function formatMaybe(value) {
  return value === null || value === undefined || value === '' ? '-' : value;
}

function formatDurationSeconds(value) {
  if (value === null || value === undefined || value === '') return '-';

  const totalSeconds = Number(value);
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '-';

  const roundedSeconds = Math.floor(totalSeconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatPercent(value) {
  if (value === null || value === undefined || value === '') return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return `${num}%`;
}

function formatDifficultyStat(total, accuracy, avgTimeSec) {
  const count = Number(total);
  if (!Number.isFinite(count) || count <= 0) return '0 (- / -)';
  return `${count} (${formatPercent(accuracy)} / ${formatDurationSeconds(avgTimeSec)})`;
}

function getSessionPlannedTotal(session) {
  const categories = Number(session?.total_q_categories);
  const api = Number(session?.total_q_api);
  const candidates = [categories, api].filter((value) => Number.isFinite(value) && value > 0);
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

function getSessionQuestionCount(session) {
  const answered = getSessionAnsweredCount(session);
  if (Number.isFinite(answered) && answered >= 0) return answered;
  return getSessionPlannedTotal(session);
}

function getSessionAnsweredCount(session) {
  const attempts = Number(session?.attempt_total);
  if (Number.isFinite(attempts) && attempts > 0) return attempts;

  const correct = Number(session?.correct_count);
  const wrong = Number(session?.error_count);
  const safeCorrect = Number.isFinite(correct) && correct >= 0 ? correct : 0;
  const safeWrong = Number.isFinite(wrong) && wrong >= 0 ? wrong : 0;
  const total = safeCorrect + safeWrong;
  if (total > 0) return total;

  return null;
}

function getSessionCorrectCount(session) {
  const attemptsCorrect = Number(session?.attempt_correct);
  if (Number.isFinite(attemptsCorrect) && attemptsCorrect >= 0) return attemptsCorrect;

  const correct = Number(session?.correct_count);
  if (Number.isFinite(correct) && correct >= 0) return correct;

  return null;
}

function getSessionErrorCount(session) {
  const attemptsWrong = Number(session?.attempt_wrong);
  if (Number.isFinite(attemptsWrong) && attemptsWrong >= 0) return attemptsWrong;

  const errors = Number(session?.error_count);
  if (Number.isFinite(errors) && errors >= 0) return errors;

  return null;
}

function getSessionUnansweredCount(session) {
  const total = getSessionPlannedTotal(session);
  if (!Number.isFinite(total) || total < 0) return null;

  const answered = getSessionAnsweredCount(session);
  if (!Number.isFinite(answered) || answered < 0) return total;

  return Math.max(0, total - answered);
}

function getSessionAnsweredAccuracy(session) {
  const answered = getSessionAnsweredCount(session);
  const correct = getSessionCorrectCount(session);
  if (Number.isFinite(answered) && answered > 0 && Number.isFinite(correct) && correct >= 0) {
    return Number(((correct * 100) / answered).toFixed(1));
  }

  const fallback = Number(session?.accuracy_pct);
  if (Number.isFinite(fallback)) return fallback;
  return null;
}

function getSessionCompletionRate(session) {
  const total = getSessionPlannedTotal(session);
  const answered = getSessionAnsweredCount(session);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(answered) || answered < 0) return null;
  const boundedAnswered = Math.min(answered, total);
  return Number(((boundedAnswered * 100) / total).toFixed(1));
}

function formatNotePreview(value, maxLength = 42) {
  if (!value) return '-';
  const text = String(value).trim();
  if (!text) return '-';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function normalizeQuestionText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAnswerChoices(value) {
  if (Array.isArray(value)) return value;
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseResponseDetails(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getResponseSlots(row) {
  const details = parseResponseDetails(row?.response_details);
  return Array.isArray(details?.slots) ? details.slots : [];
}

function formatResponseFormat(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'single_select') return 'Single Select';
  if (text === 'composite') return 'Composite';
  return value;
}

function formatSlotType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'choice-grid') return 'Choice Grid';
  if (text === 'table-cell') return 'Table Cell';
  if (text === 'single_select') return 'Single Select';
  return text
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function findResponseOption(slot, value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const options = Array.isArray(slot?.options) ? slot.options : [];
  return options.find((option) => String(option?.id || '').trim() === normalized) || null;
}

function formatResponseValue(slot, value) {
  const matched = findResponseOption(slot, value);
  return normalizeQuestionText(matched?.text || matched?.label || value || '');
}

function summarizeStructuredResponse(row, key = 'user_value') {
  const slots = getResponseSlots(row);
  if (!slots.length) return '';
  const parts = slots
    .map((slot, index) => {
      const valueText = formatResponseValue(slot, slot?.[key]);
      if (!valueText) return '';
      const prompt = normalizeQuestionText(slot?.prompt || '') || `Part ${index + 1}`;
      return `${prompt}: ${valueText}`;
    })
    .filter(Boolean);
  const summary = parts.join(' | ');
  if (summary.length <= 140) return summary;
  return `${summary.slice(0, 139)}…`;
}

function hasScrapedQuestionContent(row) {
  return (
    Boolean(normalizeQuestionText(row?.question_stem)) ||
    parseAnswerChoices(row?.answer_choices).length > 0 ||
    getResponseSlots(row).length > 0
  );
}

function formatQuestionActionLabel(row) {
  return hasScrapedQuestionContent(row) ? 'Review' : 'Open';
}

function formatTopicSource(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === 'llm') return 'LLM';
  if (text === 'heuristic') return 'Heuristic';
  return text;
}

function formatContentDomain(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'non_math') return 'Non-math';
  if (text === 'math') return 'Math';
  return value;
}

function normalizedSubjectCode(row) {
  const inferredCategory = normalizedCategoryCode(row);
  const inferredCategoryUpper = String(inferredCategory || '').trim().toUpperCase();
  if (inferredCategoryUpper === 'PS') return 'Q';
  if (['CR', 'RC'].includes(inferredCategoryUpper)) return 'V';
  if (['DS', 'MSR', 'TPA', 'GI', 'TA', 'DI', 'UNKNOWN DI'].includes(inferredCategoryUpper)) return 'DI';

  const raw = String(row?.subject_code || '').trim().toUpperCase();
  if (raw) return raw;
  const fallback = mapSubjectFamily(row?.subject || row?.subject_sub || row?.subject_sub_raw || '');
  if (fallback === 'Quant') return 'Q';
  if (fallback === 'Verbal') return 'V';
  if (fallback === 'DI') return 'DI';
  return fallback || '-';
}

function normalizedCategoryCode(row) {
  const raw = String(row?.category_code || row?.subject_sub_raw || row?.subject_sub || '').trim();
  const upper = raw.toUpperCase();
  if (['QUANT', 'Q', 'PS'].includes(upper)) return 'PS';
  if (['CR', 'RC', 'DS', 'MSR', 'TPA', 'GI', 'TA'].includes(upper)) return upper;

  const catId = Number(row?.cat_id);
  if (Number.isInteger(catId)) {
    if ([1337013, 1336833, 1336853].includes(catId)) return 'RC';
    if ([1337023, 1336843, 1336863].includes(catId)) return 'CR';
    if ([1336733, 1336743].includes(catId)) return 'DS';
    if (catId === 1336753) return 'MSR';
    if (catId === 1336763) return 'TA';
    if (catId === 1336773) return 'GI';
    if (catId === 1336783) return 'TPA';
    if ([1336803, 1336813].includes(catId)) return 'PS';
  }

  const topic = String(row?.subcategory || row?.topic || '').trim().toUpperCase();
  if (topic === 'DATA SUFFICIENCY') return 'DS';
  if (topic === 'MULTI-SOURCE REASONING' || topic === 'MSR MATH RELATED' || topic === 'MSR NON-MATH RELATED') return 'MSR';
  if (topic === 'TABLE ANALYSIS' || topic === 'G&T TABLES') return 'TA';
  if (topic === 'GRAPHICS INTERPRETATION' || topic === 'G&T GRAPHS' || topic === 'G&T MATH RELATED' || topic === 'G&T NON-MATH RELATED') return 'GI';
  if (topic === 'TWO-PART ANALYSIS' || topic === 'TPA MATH RELATED' || topic === 'TPA NON-MATH RELATED') return 'TPA';

  if (!raw) return '-';
  if (upper === 'DI') return 'Unknown DI';
  return raw;
}

function normalizeVerbalSubcategoryDisplay(value, categoryCode) {
  const text = String(value || '').trim();
  const normalized = text.toLowerCase();
  const category = String(categoryCode || '').trim().toUpperCase();

  if (!text) return '';

  if (category === 'CR') {
    if (/^(support|strengthen)$/i.test(text) || /strengthen|support/.test(normalized)) return 'Support';
    if (/^(attack|weaken|flaw)$/i.test(text) || /weaken|flaw/.test(normalized)) return 'Attack';
    if (/^(assumption|evaluate)$/i.test(text) || /assumption|evaluate|relevant to know/.test(normalized)) return 'Assumption';
    if (/^(inference|complete)$/i.test(text) || /inference|must be true|best supported|complete/.test(normalized)) return 'Inference';
    if (/^(resolve|explain)$/i.test(text) || /resolve|explain|paradox|discrepancy/.test(normalized)) return 'Resolve';
    if (
      /^(argument structure|boldface|method|parallel)$/i.test(text) ||
      /boldface|method|technique|strategy|parallel|argument structure/.test(normalized)
    ) {
      return 'Argument Structure';
    }
  }

  if (category === 'RC') {
    if (
      /^(main idea \/ purpose|main idea|purpose)$/i.test(text) ||
      /main idea|main point|primary purpose|central idea|purpose/.test(normalized)
    ) {
      return 'Main Idea / Purpose';
    }
    if (/^detail$/i.test(text) || /detail|according to the passage/.test(normalized)) return 'Detail';
    if (/^inference$/i.test(text) || /inference|must be true|best supported/.test(normalized)) return 'Inference';
    if (
      /^(structure \/ function|organization)$/i.test(text) ||
      /organization|structure of the passage|serves to|function of|structure \/ function/.test(normalized)
    ) {
      return 'Structure / Function';
    }
    if (/^(author view|author attitude)$/i.test(text) || /author('|’)s attitude|tone|author view/.test(normalized)) {
      return 'Author View';
    }
    if (/^application$/i.test(text) || /application|apply.*principle|analogous/.test(normalized)) return 'Application';
  }

  return text;
}

function normalizeQuantSubcategoryDisplay(value, categoryCode) {
  const text = String(value || '').trim();
  const normalized = text.toLowerCase();
  const category = String(categoryCode || '').trim().toUpperCase();

  if (!text) return '';
  if (!['PS', 'DS'].includes(category)) return '';

  if (category === 'DS' && /data sufficiency/.test(normalized)) return 'Unclear Topic';
  if (/unclear topic|poor quality|bad question|ambiguous/.test(normalized)) return 'Unclear Topic';
  if (/overlapping sets|venn|set theory/.test(normalized)) return 'Overlapping Sets';
  if (/statistics|mean|median|standard deviation|variance/.test(normalized)) return 'Statistics';
  if (/combin|permut|probab|counting/.test(normalized)) return 'Counting & Probability';
  if (/distance|speed|rate|work|time/.test(normalized)) return 'Rates, Work & Motion';
  if (/functions?|sequence|inequal|absolute value|custom character/.test(normalized)) return 'Functions, Sequences & Inequalities';
  if (/word problem|age problem|digit problem|mixture|problem solving/.test(normalized)) return 'General Word Problems';
  if (/percent|interest|fraction|ratio|proportion|arithmetic|decimal|average|fdp|remainder|multiple|factor/.test(normalized)) {
    return 'Arithmetic, FDP & Ratios';
  }
  if (/geometry|triangle|circle|area|volume|coordinate/.test(normalized)) return 'Geometry';
  if (/number properties|divis|integer|odd|even|prime/.test(normalized)) return 'Number Properties';
  if (/algebra|equation|quadratic|linear/.test(normalized)) return 'Algebra & Equations';

  return text;
}

function normalizeDiSubcategoryDisplay(value, categoryCode, contentDomain) {
  const text = String(value || '').trim();
  const normalized = text.toLowerCase();
  const category = String(categoryCode || '').trim().toUpperCase();
  const domain = String(contentDomain || '').trim().toLowerCase();

  if (!text) return '';

  if (category === 'GI') {
    if (/graphs|graphics interpretation|graph|chart|plot|axis/.test(normalized)) return 'Graphs';
    if (domain === 'math') return 'Math-Based Interpretation';
    if (domain === 'non_math') return 'Non-Math Interpretation';
    if (/non[- ]?math|verbal|reading|inference|author|purpose/.test(normalized)) return 'Non-Math Interpretation';
    if (/math[- ]?based|math[- ]?related|algebra|arithmetic|rate|probab|geometry|number properties|statistics/.test(normalized)) {
      return 'Math-Based Interpretation';
    }
  }

  if (category === 'TA') {
    if (/tables|table analysis|table/.test(normalized)) return 'Tables';
    if (domain === 'math') return 'Math-Based Analysis';
    if (domain === 'non_math') return 'Non-Math Analysis';
    if (/non[- ]?math|verbal|reading|inference|author|purpose/.test(normalized)) return 'Non-Math Analysis';
    if (/math[- ]?based|math[- ]?related|algebra|arithmetic|rate|probab|geometry|number properties|statistics/.test(normalized)) {
      return 'Math-Based Analysis';
    }
  }

  if (category === 'MSR' || category === 'TPA') {
    if (domain === 'math') return 'Math-Based Reasoning';
    if (domain === 'non_math') return 'Non-Math Reasoning';
    if (category === 'MSR' && /multi-source reasoning/.test(normalized)) return 'Unknown';
    if (category === 'TPA' && /two-part analysis/.test(normalized)) return 'Unknown';
    if (/non[- ]?math|verbal|reading|inference|author|purpose/.test(normalized)) return 'Non-Math Reasoning';
    if (/math[- ]?based|math[- ]?related|algebra|arithmetic|rate|probab|geometry|statistics/.test(normalized)) {
      return 'Math-Based Reasoning';
    }
  }

  return text;
}

// StartTest stores subcategory as a short abbreviation ("VEO", "ARI", "COR")
// while the human-readable name lives in `topic`. Prefer `topic` whenever
// `subcategory` looks abbreviation-shaped (all-caps, ≤5 letters, no spaces).
function pickReadableSubcategory(row) {
  const sub = String(row?.subcategory || '').trim();
  const topic = String(row?.topic || '').trim();
  const looksAbbrev = sub.length > 0 && sub.length <= 5 && /^[A-Z0-9]+$/.test(sub);
  if (looksAbbrev && topic) return topic;
  return sub || topic || '';
}

function normalizedSubcategory(row) {
  const category = normalizedCategoryCode(row);
  const raw = pickReadableSubcategory(row);
  if (!raw) return '-';
  const contentDomain = String(row?.content_domain || '').trim();
  return (
    normalizeVerbalSubcategoryDisplay(raw, category) ||
    normalizeQuantSubcategoryDisplay(raw, category) ||
    normalizeDiSubcategoryDisplay(raw, category, contentDomain) ||
    raw
  );
}

function normalizeSubjectCodeValue(value) {
  const upper = String(value || '').trim().toUpperCase();
  if (!upper) return '';
  if (['Q', 'QUANT', 'PS'].includes(upper)) return 'Q';
  if (['V', 'VERBAL', 'CR', 'RC'].includes(upper)) return 'V';
  if (['DI', 'DS', 'MSR', 'TPA', 'GI', 'TA'].includes(upper)) return 'DI';
  return upper;
}

function normalizeSubjectFamilyDisplay(value) {
  const normalized = normalizeSubjectCodeValue(value);
  if (normalized === 'Q') return 'Quant';
  if (normalized === 'V') return 'Verbal';
  if (normalized === 'DI') return 'Data Insights';
  return String(value || '').trim() || 'Other';
}

function truncateTableText(value, maxLength = 44) {
  const text = normalizeQuestionText(value);
  if (!text) return '-';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function isStructuredResponseRow(row) {
  return String(row?.response_format || '').trim().toLowerCase() === 'composite' || getResponseSlots(row).length > 0;
}

function getCompactResponseValue(row, key = 'my_answer') {
  if (isStructuredResponseRow(row)) {
    const partCount = getResponseSlots(row).length;
    if (partCount > 0) return `${partCount}-part structured`;
    return 'Structured';
  }
  return truncateTableText(row?.[key], 38);
}

function getCompactResponseDisplay(row) {
  if (isStructuredResponseRow(row)) {
    return getCompactResponseValue(row, 'my_answer');
  }

  const mine = getCompactResponseValue(row, 'my_answer');
  const correct = getCompactResponseValue(row, 'correct_answer');
  if (mine === '-' && correct === '-') return '-';
  if (mine === '-') return `Correct: ${correct}`;
  if (correct === '-') return `Mine: ${mine}`;
  if (mine === correct) return mine;
  return `${mine} -> ${correct}`;
}

function SubjectCell({ row }) {
  const subjectCode = normalizedSubjectCode(row);
  return (
    <div className="section-cell">
      <span className="section-chip">{normalizeSubjectFamilyDisplay(subjectCode)}</span>
    </div>
  );
}

function getSourcePlatform(sourceLabel) {
  const raw = String(sourceLabel || '').trim();
  if (!raw) return null;
  if (/gmat\s*club/i.test(raw)) return 'gmatclub';
  return 'starttest';
}

function SourceBadge({ source }) {
  const platform = getSourcePlatform(source);
  if (!platform) return <span className="muted">-</span>;
  const label = platform === 'gmatclub' ? 'GMAT Club' : 'Official Guide';
  return (
    <span className={`source-chip source-${platform}`} title={source || ''}>
      {label}
    </span>
  );
}

function ResponseCell({ row }) {
  return (
    <div className="response-summary-cell">
      <strong>{getCompactResponseDisplay(row)}</strong>
    </div>
  );
}

function mapSubjectFamily(subject) {
  const raw = String(subject || '').trim();
  const upper = raw.toUpperCase();
  if (['CR', 'RC', 'VERBAL'].includes(upper)) return 'Verbal';
  if (['PS', 'QUANT'].includes(upper)) return 'Quant';
  if (['DS', 'DI', 'TA', 'GI', 'MSR', 'TPA'].includes(upper)) return 'DI';
  return 'Other';
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  let data = {};
  let rawBody = '';
  try {
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      rawBody = await response.text();
      if (rawBody) {
        try {
          data = JSON.parse(rawBody);
        } catch (_parseError) {
          data = {};
        }
      }
    }
  } catch (_error) {
    data = {};
  }

  if (!response.ok) {
    const fallbackMessage = rawBody
      ? `Request failed (${response.status}): ${String(rawBody).replace(/\s+/g, ' ').trim().slice(0, 220)}`
      : `Request failed (${response.status})`;
    const error = new Error(data.error || fallbackMessage);
    error.status = response.status;
    error.hint = data.hint || '';
    error.details = data.details || rawBody || '';
    error.debug = data.debug || null;
    throw error;
  }
  return data;
}

function formatRequestError(error) {
  const parts = [error?.message || 'Request failed', error?.hint || ''].filter(Boolean);
  return parts.join(' ');
}

const AI_COACH_QUICK_PROMPTS = [
  'What are my top 3 weak areas right now?',
  'Give me a 45-minute drill for today.',
  'How should I improve timing without hurting accuracy?',
  'Which mistakes should I fix first for score gain?',
];

function buildCoachGreeting(scopeLabel) {
  return {
    role: 'assistant',
    content: `I’m your GMAT coach for ${scopeLabel}. Ask about weak topics, timing, drill plans, or score-improvement strategy.`,
  };
}

function App() {
  const [status, setStatus] = useState({ message: 'Loading...', isError: false });
  const [sources, setSources] = useState([]);
  const [selectedSource, setSelectedSource] = useState('');
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [scrapeWindow, setScrapeWindow] = useState('today');
  const [customSince, setCustomSince] = useState('');
  const [sessions, setSessions] = useState([]);
  const [errors, setErrors] = useState([]);
  const [patterns, setPatterns] = useState({
    bySubject: [],
    byDifficulty: [],
    confidenceMismatch: [],
    subjectProgress: [],
    categoryBreakdown: [],
    subtopicBreakdown: [],
  });
  const [filters, setFilters] = useState({ subject: '', difficulty: '', topic: '', confidence: '', search: '', mistakeTag: '', platform: '' });
  const [syncCenterOpen, setSyncCenterOpen] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [isOpeningProduct, setIsOpeningProduct] = useState(false);
  const [isScraping, setIsScraping] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);
  const [lastEnrichResult, setLastEnrichResult] = useState(null);
  const [syncDebug, setSyncDebug] = useState(null);
  const [patternDrilldown, setPatternDrilldown] = useState({
    open: false,
    loading: false,
    error: '',
    title: '',
    criteria: { subject: '', difficulty: '', topic: '', confidence: '' },
    rows: [],
  });
  const [sessionAnalysis, setSessionAnalysis] = useState({
    open: false,
    loading: false,
    error: '',
    data: null,
  });
  const [annotation, setAnnotation] = useState({
    open: false,
    saving: false,
    error: '',
    row: null,
    mistakeTags: [],
    notes: '',
  });
  const [questionReview, setQuestionReview] = useState({
    open: false,
    row: null,
  });
  const [openingQuestionKey, setOpeningQuestionKey] = useState('');
  const [sessionSubjectFilter, setSessionSubjectFilter] = useState('');
  const [sessionPlatformFilter, setSessionPlatformFilter] = useState('');
  const [sessionSort, setSessionSort] = useState({ key: 'session_date', order: 'desc' });
  const [sessionAnalysisSort, setSessionAnalysisSort] = useState({ key: 'time_sec', order: 'desc' });
  const [errorSort, setErrorSort] = useState({ key: 'session_date', order: 'desc' });
  const [categoryBreakdownSort, setCategoryBreakdownSort] = useState({ key: 'subject_family', order: 'asc' });
  const [subcategoryBreakdownSort, setSubcategoryBreakdownSort] = useState({ key: 'total_questions', order: 'desc' });
  const [sessionDateRange, setSessionDateRange] = useState({ start: '', end: '' });
  const [expandedCategoryKey, setExpandedCategoryKey] = useState('');
  const [aiReview, setAiReview] = useState('');
  const [isGeneratingAiReview, setIsGeneratingAiReview] = useState(false);
  const [aiFocus, setAiFocus] = useState('');
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiMessages, setAiMessages] = useState([]);
  const [isAskingAi, setIsAskingAi] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [coachTab, setCoachTab] = useState('chat');
  const [chatSessionId, setChatSessionId] = useState(null);
  const [chatSessions, setChatSessions] = useState([]);
  const [showSessionList, setShowSessionList] = useState(false);
  const aiChatEndRef = useRef(null);

  const [showDifficultyCols, setShowDifficultyCols] = useState(false);

  // Collapsible sections state
  const [collapsedSections, setCollapsedSections] = useState({
    topicDashboard: false,
    categoryBreakdown: false,
    performanceBySession: false,
    errorLog: false,
  });

  const toggleSection = (section) => {
    setCollapsedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  // Pagination state
  const [sessionPagination, setSessionPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
  const [errorPagination, setErrorPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 0 });

  const summary = useMemo(() => {
    if (!runs.length) {
      return { id: '-', total_sessions: 0, total_questions: 0, total_errors: 0 };
    }
    if (selectedRunId) {
      const run = runs.find((row) => String(row.id) === String(selectedRunId));
      return run || { id: '-', total_sessions: 0, total_questions: 0, total_errors: 0 };
    }
    return {
      id: 'All',
      total_sessions: runs.reduce((sum, row) => sum + (row.total_sessions || 0), 0),
      total_questions: runs.reduce((sum, row) => sum + (row.total_questions || 0), 0),
      total_errors: runs.reduce((sum, row) => sum + (row.total_errors || 0), 0),
    };
  }, [runs, selectedRunId]);

  const sourceAppUrlByLabel = useMemo(() => {
    const map = new Map();
    for (const source of sources) {
      const label = String(source?.label || '').trim().toLowerCase();
      const appUrl = String(source?.appUrl || '').trim();
      if (label && appUrl) map.set(label, appUrl);
    }
    return map;
  }, [sources]);

  const aiRunId = useMemo(() => {
    if (!selectedRunId) return null;
    const parsed = Number(selectedRunId);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, [selectedRunId]);

  const aiScopeLabel = aiRunId ? `Run ${aiRunId}` : 'All runs';

  async function loadCoachSessions() {
    try {
      const data = await fetchJson('/api/ai/sessions?limit=30');
      setChatSessions(data.sessions || []);
      return data.sessions || [];
    } catch {
      return [];
    }
  }

  async function loadSessionMessages(sessionId) {
    try {
      const data = await fetchJson(`/api/ai/sessions/${sessionId}`);
      const msgs = (data.messages || []).map((m) => ({ role: m.role, content: m.content }));
      setAiMessages([buildCoachGreeting(aiScopeLabel), ...msgs]);
      setChatSessionId(sessionId);
    } catch {
      setChatSessionId(null);
      setAiMessages([buildCoachGreeting(aiScopeLabel)]);
    }
  }

  async function startNewSession() {
    try {
      const data = await fetchJson('/api/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: aiRunId }),
      });
      setChatSessionId(data.session?.id || null);
      setAiMessages([buildCoachGreeting(aiScopeLabel)]);
      setAiQuestion('');
      loadCoachSessions();
    } catch {
      setChatSessionId(null);
      setAiMessages([buildCoachGreeting(aiScopeLabel)]);
    }
  }

  async function handleSelectSession(sessionId) {
    await loadSessionMessages(sessionId);
    setShowSessionList(false);
  }

  async function handleDeleteSession(sessionId) {
    try {
      await fetchJson(`/api/ai/sessions/${sessionId}`, { method: 'DELETE' });
      setChatSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (chatSessionId === sessionId) {
        startNewSession();
      }
    } catch {
      // ignore
    }
  }

  async function loadSources() {
    const data = await fetchJson('/api/sources');
    const rows = data.sources || [];
    setSources(rows);
    if (!selectedSource && rows[0]?.id) {
      setSelectedSource(rows[0].id);
    }
  }

  async function loadRuns() {
    const data = await fetchJson('/api/runs');
    setRuns(data.runs || []);
  }

  async function loadDashboard(runId = selectedRunId) {
    // Initial load: fetch first page of sessions and first page of errors
    await Promise.all([
      loadSessions(1, runId),
      loadErrors(1, runId),
      (async () => {
        const runQuery = runId ? `?runId=${runId}` : '';
        const patternsRes = await fetchJson(`/api/patterns${runQuery}`);
        setPatterns({
          bySubject: patternsRes.bySubject || [],
          byDifficulty: patternsRes.byDifficulty || [],
          confidenceMismatch: patternsRes.confidenceMismatch || [],
          subjectProgress: patternsRes.subjectProgress || [],
          categoryBreakdown: patternsRes.categoryBreakdown || [],
          subtopicBreakdown: patternsRes.subtopicBreakdown || [],
        });
      })(),
    ]);
  }

  async function loadSessions(page, runId = selectedRunId, platform = sessionPlatformFilter) {
    const params = new URLSearchParams();
    if (runId) params.set('runId', runId);
    params.set('page', page);
    params.set('pageSize', sessionPagination.pageSize);
    if (platform) params.set('platform', platform);
    const data = await fetchJson(`/api/sessions?${params.toString()}`);
    setSessions(data.sessions || []);
    setSessionPagination({
      page: data.page,
      pageSize: data.pageSize,
      total: data.total,
      totalPages: data.totalPages,
    });
  }

  async function loadErrors(page, runId = selectedRunId, customFilters = filters, customSort = errorSort) {
    const params = new URLSearchParams();
    if (runId) params.set('runId', runId);
    params.set('page', page);
    params.set('pageSize', errorPagination.pageSize);
    if (customFilters.subject) params.set('subject', customFilters.subject);
    if (customFilters.difficulty) params.set('difficulty', customFilters.difficulty);
    if (customFilters.topic) params.set('topic', customFilters.topic);
    if (customFilters.confidence) params.set('confidence', customFilters.confidence);
    if (customFilters.search) params.set('search', customFilters.search);
    if (customFilters.mistakeTag) params.set('mistakeTag', customFilters.mistakeTag);
    if (customFilters.platform) params.set('platform', customFilters.platform);
    params.set('sortKey', customSort.key);
    params.set('sortOrder', customSort.order);

    const data = await fetchJson(`/api/errors?${params.toString()}`);
    const rows = Array.isArray(data.errors) ? data.errors : [];
    setErrors(rows);
    setErrorPagination({
      page: data.page,
      pageSize: data.pageSize,
      total: data.total,
      totalPages: data.totalPages,
    });
    return rows;
  }

  useEffect(() => {
    let active = true;
    async function boot() {
      try {
        await loadSources();
        await loadRuns();
        await loadDashboard('');
        if (active) {
          setStatus({ message: 'Ready. Start by opening Chrome and running scrape.', isError: false });
        }
      } catch (error) {
        if (active) {
          setStatus({ message: error.message, isError: true });
        }
      }
    }
    boot();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!sessionAnalysis.open && !patternDrilldown.open && !syncCenterOpen && !annotation.open && !questionReview.open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [sessionAnalysis.open, patternDrilldown.open, syncCenterOpen, annotation.open, questionReview.open]);

  useEffect(() => {
    function handleEscape(event) {
      if (event.key !== 'Escape') return;
      if (annotation.open) { handleCloseAnnotation(); return; }
      if (questionReview.open) { handleCloseQuestionReview(); return; }
      if (patternDrilldown.open) { setPatternDrilldown((prev) => ({ ...prev, open: false })); return; }
      if (sessionAnalysis.open) { handleCloseSessionAnalysis(); return; }
      if (syncCenterOpen) { setSyncCenterOpen(false); return; }
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [annotation.open, questionReview.open, patternDrilldown.open, sessionAnalysis.open, syncCenterOpen]);

  useEffect(() => {
    setAiReview('');
    setAiQuestion('');
    setAiMessages([buildCoachGreeting(aiScopeLabel)]);
    setChatSessionId(null);
    // Load most recent session or create one
    loadCoachSessions().then((sessions) => {
      if (sessions.length > 0) {
        loadSessionMessages(sessions[0].id);
      }
    });
  }, [aiScopeLabel]);

  useEffect(() => {
    aiChatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [aiMessages, isAskingAi]);

  // Auto-apply error log filters on change (debounced for search input)
  useEffect(() => {
    const id = setTimeout(() => {
      loadErrorsByFilters(filters).catch(() => {});
    }, filters.search ? 350 : 0);
    return () => clearTimeout(id);
  }, [filters.subject, filters.difficulty, filters.confidence, filters.search, filters.mistakeTag, filters.topic, filters.platform]);

  // Reload sessions list when the source-platform filter changes
  useEffect(() => {
    loadSessions(1, selectedRunId, sessionPlatformFilter).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPlatformFilter]);

  async function handleOpenChrome() {
    if (!selectedSource) return;
    setIsOpening(true);
    setStatus({ message: 'Opening Chrome with remote debugging...', isError: false });
    try {
      const result = await fetchJson('/api/open-chrome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cdpUrl: DEFAULT_CDP_URL,
          source: selectedSource,
        }),
      });
      setStatus({
        message: `Chrome launched on port ${result.port} for ${result.source}. Log in and run scrape.`,
        isError: false,
      });
      setSyncDebug({
        action: 'open-chrome',
        ok: true,
        at: new Date().toISOString(),
        source: result.source,
        appUrl: result.appUrl,
        port: result.port,
        profileDir: result.profileDir,
      });
    } catch (error) {
      setStatus({ message: formatRequestError(error), isError: true });
      setSyncDebug({
        action: 'open-chrome',
        ok: false,
        at: new Date().toISOString(),
        error: error?.message || 'Open Chrome failed',
        hint: error?.hint || '',
        details: error?.details || '',
      });
    } finally {
      setIsOpening(false);
    }
  }

  // Navigate the user's already-logged-in Chrome tab to the selected GMAT
  // product's home page. Used before Run Scrape so the scraper finds the
  // right product's session table without having to switch products itself.
  async function handleOpenProduct() {
    if (!selectedSource) return;
    setIsOpeningProduct(true);
    setStatus({ message: `Navigating your GMAT tab to "${selectedSource}"...`, isError: false });
    try {
      const result = await fetchJson('/api/open-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cdpUrl: DEFAULT_CDP_URL, source: selectedSource }),
      });
      const mismatch = result.matches === false;
      setStatus({
        message: mismatch
          ? `Tab did not switch to "${result.expectedHeading}" (tab shows "${result.activeHeading}"). Check your GMAT account owns this book.`
          : `GMAT tab is on "${result.activeHeading || result.expectedHeading || result.source}". Ready to scrape.`,
        isError: mismatch,
      });
      setSyncDebug({
        action: 'open-product',
        ok: true,
        at: new Date().toISOString(),
        source: result.source,
        expectedHeading: result.expectedHeading,
        activeHeading: result.activeHeading,
        matches: result.matches,
        tabUrl: result.tabUrl,
        debug: result.debug || null,
      });
    } catch (error) {
      setStatus({ message: formatRequestError(error), isError: true });
      setSyncDebug({
        action: 'open-product',
        ok: false,
        at: new Date().toISOString(),
        error: error?.message || 'Open product failed',
        hint: error?.hint || '',
        details: error?.details || '',
        debug: error?.debug || null,
      });
    } finally {
      setIsOpeningProduct(false);
    }
  }

  // Phase 2 (per-session deep enrichment). Long-running (~3–5 min for 20 items).
  // Hits each item's review page sequentially with human-like jitter; saves
  // stem/choices/passage/precise time/user-answer to the existing rows.
  async function handleEnrichSession(sessionId) {
    if (!sessionId || isEnriching) return;
    setIsEnriching(true);
    setLastEnrichResult(null);
    setStatus({
      message: 'Phase 2 enrichment running. This may take a few minutes — keep your GMAT tab on the matching product home and don\'t click around in it.',
      isError: false,
    });
    try {
      const result = await fetchJson(`/api/sessions/${sessionId}/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cdpUrl: DEFAULT_CDP_URL }),
      });
      const summary = result.aborted
        ? `Phase 2 aborted at ${result.dbUpdated}/${result.qhTotal} items: ${result.abortReason}. Saved partial data.`
        : `Phase 2 complete: ${result.dbUpdated}/${result.qhTotal} items enriched.`;
      setStatus({ message: summary, isError: !!result.aborted });
      setLastEnrichResult(result);
      // Refresh the session analysis modal so newly-enriched fields show up.
      if (sessionAnalysis.data?.session?.id === sessionId) {
        await handleOpenSessionAnalysis(sessionAnalysis.data.session);
      }
    } catch (error) {
      setStatus({ message: formatRequestError(error), isError: true });
      setLastEnrichResult({
        ok: false,
        error: error?.message || 'Enrich failed',
        hint: error?.hint || '',
        details: error?.details || '',
        debug: error?.debug || null,
      });
    } finally {
      setIsEnriching(false);
    }
  }

  async function handleScrape() {
    if (!selectedSource) return;
    setIsScraping(true);
    setStatus({ message: 'Scrape running. Keep GMAT tab open until complete...', isError: false });
    try {
      const result = await fetchJson('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: selectedSource,
          cdpUrl: DEFAULT_CDP_URL,
          scrapeWindow,
          customSince: scrapeWindow === 'custom' ? customSince : '',
        }),
      });
      setSelectedRunId('');
      await loadRuns();
      await loadDashboard('');
      const diagnostics = result?.debug?.diagnostics || null;
      const warningText = result.warning ? ` ${result.warning}` : '';
      const diagnosticsText = diagnostics
        ? ` sessions=${diagnostics.sessions}, questions=${diagnostics.questions}, errors=${diagnostics.errors}.`
        : '';
      setStatus({
        message: `Run ${result.run.id} complete (${result.source}, ${result.scrapeWindowUsed}, since ${result.sinceUsed} ICT/UTC+7).${diagnosticsText}${warningText}`,
        isError: Boolean(result.warning),
      });
      setSyncDebug({
        action: 'scrape',
        ok: true,
        at: new Date().toISOString(),
        source: result.source,
        sinceUsed: result.sinceUsed,
        scrapeWindowUsed: result.scrapeWindowUsed,
        runId: result?.run?.id,
        tabUrl: result.tabUrl,
        warning: result.warning || '',
        debug: result.debug || null,
      });
    } catch (error) {
      setStatus({ message: formatRequestError(error), isError: true });
      setSyncDebug({
        action: 'scrape',
        ok: false,
        at: new Date().toISOString(),
        error: error?.message || 'Scrape failed',
        hint: error?.hint || '',
        details: error?.details || '',
        debug: error?.debug || null,
      });
      // Keep full context in browser devtools as well.
      // eslint-disable-next-line no-console
      console.error('Scrape request failed', error);
    } finally {
      setIsScraping(false);
    }
  }

  async function handleRunChange(event) {
    const runId = event.target.value;
    setSelectedRunId(runId);
    try {
      await loadDashboard(runId);
    } catch (error) {
      setStatus({ message: error.message, isError: true });
    }
  }

  async function loadErrorsByFilters(customFilters = filters) {
    return loadErrors(1, selectedRunId, customFilters);
  }

  async function handleApplyFilter(event) {
    event.preventDefault();
    try {
      await loadErrorsByFilters(filters);
    } catch (error) {
      setStatus({ message: error.message, isError: true });
    }
  }

  async function handleOpenPatternDrilldown(type, value, extra = {}) {
    const criteria = { subject: '', difficulty: '', topic: '', confidence: '' };
    if (type === 'topic') criteria.topic = value;
    if (type === 'difficulty') criteria.difficulty = value;
    if (type === 'confidence') criteria.confidence = value;
    if (type === 'subject') criteria.subject = value;
    if (extra.subject) criteria.subject = extra.subject;

    setPatternDrilldown({
      open: true,
      loading: true,
      error: '',
      title: `${type[0].toUpperCase()}${type.slice(1)}: ${value}`,
      criteria,
      rows: [],
    });

    try {
      const rows = await loadErrorsByFilters(criteria);
      setPatternDrilldown({
        open: true,
        loading: false,
        error: '',
        title: `${type[0].toUpperCase()}${type.slice(1)}: ${value}`,
        criteria,
        rows,
      });
    } catch (error) {
      setPatternDrilldown({
        open: true,
        loading: false,
        error: error.message,
        title: `${type[0].toUpperCase()}${type.slice(1)}: ${value}`,
        criteria,
        rows: [],
      });
    }
  }

  const subjectCards = useMemo(() => {
    const groups = new Map();
    for (const row of patterns.subjectProgress || []) {
      const family = normalizeSubjectFamilyDisplay(row.subject_family || row.subject_sub);
      if (!groups.has(family)) {
        groups.set(family, {
          family,
          total: 0,
          correct: 0,
          wrong: 0,
          weightedTime: 0,
          subs: [],
        });
      }
      const group = groups.get(family);
      const total = Number(row.total || 0);
      const correct = Number(row.correct || 0);
      const wrong = Number(row.wrong || 0);
      const avgTime = Number(row.avg_time_sec || 0);

      group.total += total;
      group.correct += correct;
      group.wrong += wrong;
      group.weightedTime += avgTime * total;
      group.subs.push({
        subject_sub: row.subject_sub,
        total,
        correct,
        wrong,
        accuracy_pct: Number(row.accuracy_pct || 0),
      });
    }

    const order = ['Verbal', 'Quant', 'Data Insights', 'Other'];
    return Array.from(groups.values())
      .sort((a, b) => order.indexOf(a.family) - order.indexOf(b.family))
      .map((group) => ({
        ...group,
        accuracy_pct: group.total ? Number(((group.correct * 100) / group.total).toFixed(1)) : 0,
        avg_time_sec: group.total ? Math.round(group.weightedTime / group.total) : 0,
        subs: group.subs.sort((a, b) => b.total - a.total),
      }));
  }, [patterns.subjectProgress]);

  const categoryRows = useMemo(() => {
    const groups = new Map();
    for (const row of patterns.categoryBreakdown || []) {
      const subjectFamily = normalizeSubjectFamilyDisplay(row.subject_family);
      const category = normalizedCategoryCode(row);
      const key = `${subjectFamily}|${category}`;
      if (!groups.has(key)) {
        groups.set(key, {
          subject_family: subjectFamily,
          subject_sub: category,
          total_questions: 0,
          correct_count: 0,
          incorrect_count: 0,
          weighted_avg_time_sec: 0,
          hard_total: 0,
          hard_correct_estimate: 0,
          hard_weighted_avg_time_sec: 0,
          medium_total: 0,
          medium_correct_estimate: 0,
          medium_weighted_avg_time_sec: 0,
          easy_total: 0,
          easy_correct_estimate: 0,
          easy_weighted_avg_time_sec: 0,
        });
      }

      const group = groups.get(key);
      const total = Number(row.total_questions || 0);
      const correct = Number(row.correct_count || 0);
      const incorrect = Number(row.incorrect_count || 0);
      const avgTime = Number(row.avg_time_sec || 0);
      const hardTotal = Number(row.hard_total || 0);
      const hardAccuracyPct = Number(row.hard_accuracy_pct || 0);
      const hardAvgTime = Number(row.hard_avg_time_sec || 0);
      const mediumTotal = Number(row.medium_total || 0);
      const mediumAccuracyPct = Number(row.medium_accuracy_pct || 0);
      const mediumAvgTime = Number(row.medium_avg_time_sec || 0);
      const easyTotal = Number(row.easy_total || 0);
      const easyAccuracyPct = Number(row.easy_accuracy_pct || 0);
      const easyAvgTime = Number(row.easy_avg_time_sec || 0);

      group.total_questions += total;
      group.correct_count += correct;
      group.incorrect_count += incorrect;
      group.weighted_avg_time_sec += avgTime * total;

      group.hard_total += hardTotal;
      group.hard_correct_estimate += (hardAccuracyPct / 100) * hardTotal;
      group.hard_weighted_avg_time_sec += hardAvgTime * hardTotal;

      group.medium_total += mediumTotal;
      group.medium_correct_estimate += (mediumAccuracyPct / 100) * mediumTotal;
      group.medium_weighted_avg_time_sec += mediumAvgTime * mediumTotal;

      group.easy_total += easyTotal;
      group.easy_correct_estimate += (easyAccuracyPct / 100) * easyTotal;
      group.easy_weighted_avg_time_sec += easyAvgTime * easyTotal;
    }

    const order = ['Verbal', 'Quant', 'Data Insights', 'Other'];
    return Array.from(groups.values())
      .map((group) => ({
        subject_family: group.subject_family,
        subject_sub: group.subject_sub,
        total_questions: group.total_questions,
        correct_count: group.correct_count,
        incorrect_count: group.incorrect_count,
        accuracy_pct: group.total_questions ? Number(((group.correct_count * 100) / group.total_questions).toFixed(1)) : 0,
        avg_time_sec: group.total_questions ? Math.round(group.weighted_avg_time_sec / group.total_questions) : 0,
        hard_total: group.hard_total,
        hard_accuracy_pct: group.hard_total ? Number(((group.hard_correct_estimate * 100) / group.hard_total).toFixed(1)) : 0,
        hard_avg_time_sec: group.hard_total ? Math.round(group.hard_weighted_avg_time_sec / group.hard_total) : 0,
        medium_total: group.medium_total,
        medium_accuracy_pct: group.medium_total ? Number(((group.medium_correct_estimate * 100) / group.medium_total).toFixed(1)) : 0,
        medium_avg_time_sec: group.medium_total ? Math.round(group.medium_weighted_avg_time_sec / group.medium_total) : 0,
        easy_total: group.easy_total,
        easy_accuracy_pct: group.easy_total ? Number(((group.easy_correct_estimate * 100) / group.easy_total).toFixed(1)) : 0,
        easy_avg_time_sec: group.easy_total ? Math.round(group.easy_weighted_avg_time_sec / group.easy_total) : 0,
      }))
      .sort((a, b) => {
        const familyDiff = order.indexOf(a.subject_family) - order.indexOf(b.subject_family);
        if (familyDiff !== 0) return familyDiff;
        return String(a.subject_sub || '').localeCompare(String(b.subject_sub || ''));
      });
  }, [patterns.categoryBreakdown]);
  const subcategoryRowsByCategory = useMemo(() => {
    const groups = new Map();
    for (const row of patterns.subtopicBreakdown || []) {
      const subjectFamily = normalizeSubjectFamilyDisplay(row.subject_family);
      const category = normalizedCategoryCode(row);
      const key = `${subjectFamily}|${category}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return groups;
  }, [patterns.subtopicBreakdown]);

  const sortedCategoryRows = useMemo(() => {
    const rows = [...categoryRows];
    const { key, order } = categoryBreakdownSort;

    rows.sort((a, b) => {
      let cmp = 0;
      switch (key) {
        case 'subject_family':
          cmp = compareBasicSortValues(normalizeSubjectFamilyDisplay(a.subject_family), normalizeSubjectFamilyDisplay(b.subject_family), order);
          break;
        case 'category':
          cmp = compareBasicSortValues(normalizedCategoryCode(a), normalizedCategoryCode(b), order);
          break;
        case 'total_questions':
        case 'correct_count':
        case 'incorrect_count':
        case 'accuracy_pct':
        case 'avg_time_sec':
          cmp = compareBasicSortValues(a?.[key] || 0, b?.[key] || 0, order);
          break;
        case 'hard':
        case 'medium':
        case 'easy':
          cmp = compareDifficultyBucket(a, b, key, order);
          break;
        case 'status':
          cmp = compareBasicSortValues(statusLabelFromAccuracy(a.accuracy_pct), statusLabelFromAccuracy(b.accuracy_pct), order);
          break;
        default:
          cmp = 0;
      }

      if (cmp !== 0) return cmp;
      const familyCmp = compareBasicSortValues(normalizeSubjectFamilyDisplay(a.subject_family), normalizeSubjectFamilyDisplay(b.subject_family), 'asc');
      if (familyCmp !== 0) return familyCmp;
      return compareBasicSortValues(normalizedCategoryCode(a), normalizedCategoryCode(b), 'asc');
    });

    return rows;
  }, [categoryRows, categoryBreakdownSort]);

  const sortedSubcategoryRowsByCategory = useMemo(() => {
    const groups = new Map();
    const { key, order } = subcategoryBreakdownSort;

    for (const [groupKey, rows] of subcategoryRowsByCategory.entries()) {
      const sortedRows = [...rows].sort((a, b) => {
        let cmp = 0;
        switch (key) {
          case 'subtopic':
            cmp = compareBasicSortValues(a?.subtopic || '', b?.subtopic || '', order);
            break;
          case 'total_questions':
          case 'correct_count':
          case 'incorrect_count':
          case 'accuracy_pct':
          case 'avg_time_sec':
            cmp = compareBasicSortValues(a?.[key] || 0, b?.[key] || 0, order);
            break;
          case 'hard':
          case 'medium':
          case 'easy':
            cmp = compareDifficultyBucket(a, b, key, order);
            break;
          case 'status':
            cmp = compareBasicSortValues(statusLabelFromAccuracy(a.accuracy_pct), statusLabelFromAccuracy(b.accuracy_pct), order);
            break;
          default:
            cmp = 0;
        }

        if (cmp !== 0) return cmp;
        return compareBasicSortValues(a?.subtopic || '', b?.subtopic || '', 'asc');
      });

      groups.set(groupKey, sortedRows);
    }

    return groups;
  }, [subcategoryRowsByCategory, subcategoryBreakdownSort]);

  const overallMastery = useMemo(() => {
    const total = subjectCards.reduce((sum, card) => sum + Number(card.total || 0), 0);
    const correct = subjectCards.reduce((sum, card) => sum + Number(card.correct || 0), 0);
    if (!total) return 0;
    return Number(((correct * 100) / total).toFixed(1));
  }, [subjectCards]);

  const wrongCategoryRows = useMemo(() => {
    const counts = new Map();
    for (const row of sessionAnalysis.data?.slowWrongQuestions || []) {
      const category = normalizedCategoryCode(row);
      counts.set(category, (counts.get(category) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([category, mistakes]) => ({ category, mistakes }))
      .sort((a, b) => b.mistakes - a.mistakes || a.category.localeCompare(b.category));
  }, [sessionAnalysis.data?.slowWrongQuestions]);

  const totalWrongCategoryMistakes = useMemo(
    () => wrongCategoryRows.reduce((sum, row) => sum + Number(row?.mistakes || 0), 0),
    [wrongCategoryRows]
  );

  const sortedSessionAnalysisWrongQuestions = useMemo(() => {
    const rows = [...(sessionAnalysis.data?.slowWrongQuestions || [])];
    const { key, order } = sessionAnalysisSort;
    const difficultyRank = {
      unknown: 0,
      easy: 1,
      medium: 2,
      hard: 3,
    };

    rows.sort((a, b) => {
      let valA = a?.[key];
      let valB = b?.[key];

      if (key === 'difficulty') {
        valA = difficultyRank[String(valA || 'unknown').toLowerCase()] || 0;
        valB = difficultyRank[String(valB || 'unknown').toLowerCase()] || 0;
      } else if (key === 'time_sec') {
        valA = Number.isFinite(Number(valA)) ? Number(valA) : -1;
        valB = Number.isFinite(Number(valB)) ? Number(valB) : -1;
      } else if (key === 'q_code') {
        valA = String(valA || '');
        valB = String(valB || '');
      } else {
        valA = String(valA || '').toLowerCase();
        valB = String(valB || '').toLowerCase();
      }

      if (typeof valA === 'number' && typeof valB === 'number') {
        if (valA < valB) return order === 'asc' ? -1 : 1;
        if (valA > valB) return order === 'asc' ? 1 : -1;
      } else {
        const cmp = String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
        if (cmp !== 0) return order === 'asc' ? cmp : -cmp;
      }

      return (Number(a?.id || 0) - Number(b?.id || 0)) * (order === 'asc' ? 1 : -1);
    });

    return rows;
  }, [sessionAnalysis.data?.slowWrongQuestions, sessionAnalysisSort]);

  const processedSessions = useMemo(() => {
    let list = sessions.map((session) => ({
      ...session,
      question_count_display: getSessionQuestionCount(session),
      answered_count_display: getSessionAnsweredCount(session),
      unanswered_count_display: getSessionUnansweredCount(session),
      error_count_display: getSessionErrorCount(session),
      answered_accuracy_pct: getSessionAnsweredAccuracy(session),
      completion_rate_pct: getSessionCompletionRate(session),
    }));

    // Filter by subject
    if (sessionSubjectFilter) {
      list = list.filter((s) => normalizeSubjectCodeValue(s.subject) === sessionSubjectFilter);
    }

    // Filter by date range
    if (sessionDateRange.start) {
      const start = new Date(sessionDateRange.start).getTime();
      list = list.filter((s) => new Date(s.session_date).getTime() >= start);
    }
    if (sessionDateRange.end) {
      const end = new Date(sessionDateRange.end).getTime();
      list = list.filter((s) => new Date(s.session_date).getTime() <= end);
    }

    // Sort
    const { key, order } = sessionSort;
    list.sort((a, b) => {
      let valA = a[key] ?? '';
      let valB = b[key] ?? '';

      if (key === 'session_date') {
        valA = new Date(valA).getTime();
        valB = new Date(valB).getTime();
      } else if (typeof valA === 'string') {
        valA = valA.toLowerCase();
        valB = valB.toLowerCase();
      }

      if (valA < valB) return order === 'asc' ? -1 : 1;
      if (valA > valB) return order === 'asc' ? 1 : -1;
      return 0;
    });

    return list;
  }, [sessions, sessionSubjectFilter, sessionDateRange, sessionSort]);

  function handleSessionSort(key) {
    setSessionSort((prev) => ({
      key,
      order: prev.key === key && prev.order === 'desc' ? 'asc' : 'desc',
    }));
  }

  function handleSessionAnalysisSort(key) {
    setSessionAnalysisSort((prev) => ({
      key,
      order: prev.key === key && prev.order === 'desc' ? 'asc' : 'desc',
    }));
  }

  function handleErrorSort(key) {
    const newSort = {
      key,
      order: errorSort.key === key && errorSort.order === 'desc' ? 'asc' : 'desc',
    };
    setErrorSort(newSort);
    loadErrors(1, selectedRunId, filters, newSort);
  }

  function handleCategoryBreakdownSort(key) {
    setCategoryBreakdownSort((prev) => ({
      key,
      order: prev.key === key && prev.order === 'desc' ? 'asc' : 'desc',
    }));
  }

  function handleSubcategoryBreakdownSort(key) {
    setSubcategoryBreakdownSort((prev) => ({
      key,
      order: prev.key === key && prev.order === 'desc' ? 'asc' : 'desc',
    }));
  }

  function sortIndicator(sortState, key) {
    return sortState.key === key ? (sortState.order === 'asc' ? '↑' : '↓') : '';
  }

  function compareBasicSortValues(valA, valB, order = 'asc') {
    const bothNumbers = Number.isFinite(Number(valA)) && Number.isFinite(Number(valB));
    if (bothNumbers) {
      const numA = Number(valA);
      const numB = Number(valB);
      if (numA < numB) return order === 'asc' ? -1 : 1;
      if (numA > numB) return order === 'asc' ? 1 : -1;
      return 0;
    }

    const cmp = String(valA ?? '').localeCompare(String(valB ?? ''), undefined, { numeric: true, sensitivity: 'base' });
    return order === 'asc' ? cmp : -cmp;
  }

  function compareDifficultyBucket(a, b, bucket, order = 'asc') {
    const totalCmp = compareBasicSortValues(a?.[`${bucket}_total`] || 0, b?.[`${bucket}_total`] || 0, order);
    if (totalCmp !== 0) return totalCmp;

    const accuracyCmp = compareBasicSortValues(a?.[`${bucket}_accuracy_pct`] || 0, b?.[`${bucket}_accuracy_pct`] || 0, order);
    if (accuracyCmp !== 0) return accuracyCmp;

    return compareBasicSortValues(a?.[`${bucket}_avg_time_sec`] || 0, b?.[`${bucket}_avg_time_sec`] || 0, order);
  }

  function statusLabelFromAccuracy(accuracyPct) {
    const score = Number(accuracyPct || 0);
    if (score >= 80) return 'Strong';
    if (score >= 65) return 'Improving';
    return 'Needs Focus';
  }

  function statusVariantFromAccuracy(accuracyPct) {
    const label = statusLabelFromAccuracy(accuracyPct);
    if (label === 'Strong') return 'success';
    if (label === 'Improving') return 'info';
    return 'warning';
  }

  function categoryDrilldownKey(row) {
    return `${normalizeSubjectFamilyDisplay(row?.subject_family)}|${normalizedCategoryCode(row)}`;
  }

  function toggleCategoryDrilldown(row) {
    const nextKey = categoryDrilldownKey(row);
    setExpandedCategoryKey((prev) => (prev === nextKey ? '' : nextKey));
  }

  function handleClosePatternDrilldown() {
    setPatternDrilldown({
      open: false,
      loading: false,
      error: '',
      title: '',
      criteria: { subject: '', difficulty: '', topic: '', confidence: '' },
      rows: [],
    });
  }

  async function handleApplyPatternToErrorLog() {
    const merged = { ...filters, ...patternDrilldown.criteria };
    setFilters(merged);
    try {
      await loadErrorsByFilters(merged);
      handleClosePatternDrilldown();
    } catch (error) {
      setStatus({ message: error.message, isError: true });
    }
  }

  async function handleOpenSessionAnalysis(row) {
    if (!row?.id) return;
    setSessionAnalysis({
      open: true,
      loading: true,
      error: '',
      data: null,
    });

    try {
      const result = await fetchJson(`/api/sessions/${row.id}/analysis`);
      const analysis = result.analysis || null;
      const nextAnalysis = analysis
        ? {
            ...analysis,
            slowWrongQuestions: Array.isArray(analysis.slowWrongQuestions)
              ? analysis.slowWrongQuestions
                  .map((item) => ({
                    ...item,
                    session_external_id: item?.session_external_id || analysis?.session?.session_external_id || '',
                    session_date: item?.session_date || analysis?.session?.session_date || '',
                    subject: item?.subject || analysis?.session?.subject || '',
                  }))
              : [],
          }
        : null;
      setSessionAnalysis({
        open: true,
        loading: false,
        error: '',
        data: nextAnalysis,
      });
    } catch (error) {
      setSessionAnalysis({
        open: true,
        loading: false,
        error: error.message,
        data: null,
      });
    }
  }

  function handleCloseSessionAnalysis() {
    setSessionAnalysis({
      open: false,
      loading: false,
      error: '',
      data: null,
    });
  }

  function handleOpenAnnotation(row) {
    if (!row?.id) return;
    setAnnotation({
      open: true,
      saving: false,
      error: '',
      row,
      mistakeTags: parseMistakeTags(row.mistake_type),
      notes: row.notes || '',
    });
  }

  function handleCloseAnnotation() {
    setAnnotation({
      open: false,
      saving: false,
      error: '',
      row: null,
      mistakeTags: [],
      notes: '',
    });
  }

  function handleToggleMistakeTag(tag) {
    setAnnotation((prev) => ({
      ...prev,
      mistakeTags: prev.mistakeTags.includes(tag)
        ? prev.mistakeTags.filter((t) => t !== tag)
        : [...prev.mistakeTags, tag],
    }));
  }

  function handleOpenQuestionReview(row) {
    if (!row) return;
    setQuestionReview({
      open: true,
      row: {
        ...row,
        answer_choices: parseAnswerChoices(row?.answer_choices),
        response_details: parseResponseDetails(row?.response_details),
      },
    });
  }

  function handleCloseQuestionReview() {
    setQuestionReview({
      open: false,
      row: null,
    });
  }

  function applyAnnotationLocally(updated) {
    if (!updated?.id) return;
    setErrors((prev) =>
      prev.map((row) =>
        row.id === updated.id
          ? { ...row, mistake_type: updated.mistake_type || '', notes: updated.notes || '' }
          : row
      )
    );

    setPatternDrilldown((prev) => ({
      ...prev,
      rows: (prev.rows || []).map((row) =>
        row.id === updated.id
          ? { ...row, mistake_type: updated.mistake_type || '', notes: updated.notes || '' }
          : row
      ),
    }));

    setSessionAnalysis((prev) => {
      if (!prev?.data?.slowWrongQuestions) return prev;
      return {
        ...prev,
        data: {
          ...prev.data,
          slowWrongQuestions: prev.data.slowWrongQuestions.map((row) =>
            row.id === updated.id
              ? { ...row, mistake_type: updated.mistake_type || '', notes: updated.notes || '' }
              : row
          ),
        },
      };
    });
  }

  async function handleSaveAnnotation() {
    if (!annotation.row?.id || annotation.saving) return;
    setAnnotation((prev) => ({ ...prev, saving: true, error: '' }));
    try {
      const result = await fetchJson(`/api/errors/${annotation.row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mistakeType: annotation.mistakeTags.length ? JSON.stringify(annotation.mistakeTags) : '',
          notes: annotation.notes,
        }),
      });
      applyAnnotationLocally(result.error);
      handleCloseAnnotation();
      setStatus({ message: `Saved notes for Q ${annotation.row.q_code || annotation.row.id}.`, isError: false });
    } catch (error) {
      setAnnotation((prev) => ({ ...prev, saving: false, error: error.message }));
    }
  }

  function canonicalQuestionUrl(row) {
    const rawUrl = String(row?.question_url || '').trim();
    const sessionId = String(row?.session_external_id || '').trim();
    const catId = String(row?.cat_id || '').trim();
    const qId = String(row?.q_id || '').trim();
    const sourceLabel = String(row?.source || '').trim().toLowerCase();
    const reviewHash = `#custom-quiz/${sessionId}/review/categories/${catId}/${qId}`;

    if (sessionId && catId && qId) {
      if (rawUrl) {
        try {
          const parsed = new URL(rawUrl);
          if (parsed.pathname && parsed.pathname !== '/') {
            return `${parsed.origin}${parsed.pathname}${reviewHash}`;
          }
          const sourceAppUrl = sourceAppUrlByLabel.get(sourceLabel);
          if (sourceAppUrl) {
            const sourceParsed = new URL(sourceAppUrl);
            return `${sourceParsed.origin}${sourceParsed.pathname}${reviewHash}`;
          }
          return `${parsed.origin}${parsed.pathname}${reviewHash}`;
        } catch (_error) {
          const originPath = rawUrl.replace(/[#?].*$/, '');
          if (originPath) return `${originPath}${reviewHash}`;
        }
      }
      const sourceAppUrl = sourceAppUrlByLabel.get(sourceLabel);
      if (sourceAppUrl) {
        try {
          const parsed = new URL(sourceAppUrl);
          return `${parsed.origin}${parsed.pathname}${reviewHash}`;
        } catch (_error) {
          // Fallback below.
        }
      }
      return `https://gmatofficialpractice.mba.com/${reviewHash}`;
    }
    return rawUrl;
  }

  function questionOpenKey(row, scope = '') {
    if (!row) return scope || 'unknown';
    if (row.id) return `${scope}-${row.id}`;
    return `${scope}-${row.session_external_id || 'session'}-${row.q_code || 'q'}-${row.time_sec || 't'}`;
  }

  async function handleOpenQuestionInGmat(row, scope = '') {
    const questionUrl = canonicalQuestionUrl(row);
    if (!questionUrl) return;
    const key = questionOpenKey(row, scope);
    setOpeningQuestionKey(key);
    try {
      const result = await fetchJson('/api/open-question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionUrl,
          cdpUrl: DEFAULT_CDP_URL,
          source: row?.source || '',
        }),
      });
      setStatus({ message: `Opened question in Chrome CDP: ${result.openedUrl || questionUrl}`, isError: false });
    } catch (error) {
      setStatus({ message: formatRequestError(error), isError: true });
    } finally {
      setOpeningQuestionKey((prev) => (prev === key ? '' : prev));
    }
  }

  function handleQuestionAction(row, scope = '') {
    if (hasScrapedQuestionContent(row)) {
      handleOpenQuestionReview(row);
      return;
    }
    handleOpenQuestionInGmat(row, scope);
  }

  async function handleGenerateAiReview() {
    if (isGeneratingAiReview) return;
    setIsGeneratingAiReview(true);
    try {
      const result = await fetchJson('/api/ai/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: aiRunId,
          focus: aiFocus,
        }),
      });

      const reviewText = String(result.review || '').trim();
      setAiReview(reviewText || 'No review generated.');
      setStatus({ message: `AI review ready for ${aiScopeLabel}.`, isError: false });
    } catch (error) {
      setStatus({ message: formatRequestError(error), isError: true });
    } finally {
      setIsGeneratingAiReview(false);
    }
  }

  function handleResetAiChat() {
    startNewSession();
  }

  function handleAiComposerKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleAskAi();
    }
  }

  async function handleAskAi(questionOverride = '') {
    if (isAskingAi) return;
    const question = String(questionOverride || aiQuestion || '').trim();
    if (!question) return;

    const nextUserMessage = { role: 'user', content: question };
    setAiMessages((prev) => [...prev, nextUserMessage]);
    setAiQuestion('');
    setIsAskingAi(true);

    try {
      const result = await fetchJson('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: aiRunId,
          question,
          sessionId: chatSessionId,
        }),
      });

      // Store session ID from response (auto-created if none was sent)
      if (result.sessionId && result.sessionId !== chatSessionId) {
        setChatSessionId(result.sessionId);
        loadCoachSessions();
      }

      const answer = String(result.answer || '').trim() || 'No answer generated.';
      setAiMessages((prev) => [...prev, { role: 'assistant', content: answer }]);
    } catch (error) {
      setStatus({ message: formatRequestError(error), isError: true });
      setAiMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Error: ${formatRequestError(error)}`,
        },
      ]);
    } finally {
      setIsAskingAi(false);
    }
  }

  return (
    <main className="page-shell">
      <header className="top-bar">
        <div className="top-bar-left">
          <h1 className="top-bar-title">GMAT Analytics</h1>
          {status.message && (
            <span className={`top-bar-status${status.isError ? ' error' : ''}`}>{status.message}</span>
          )}
        </div>
        <div className="top-bar-actions">
          <Button size="sm" type="button" onClick={() => setSyncCenterOpen(true)}>
            Sync Practice
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a
              href="https://gmat.targettestprep.com/gmat_focus_score_chart_and_calculator"
              target="_blank"
              rel="noopener noreferrer"
            >
              Score Calculator
            </a>
          </Button>
        </div>
      </header>

      {/* Section nav */}
      <nav className="section-nav" aria-label="Jump to section">
        <a href="#dashboard" className="section-nav-link">Dashboard</a>
        <a href="#categories" className="section-nav-link">Categories</a>
        <a href="#sessions" className="section-nav-link">Sessions</a>
        <a href="#errors" className="section-nav-link">Error Log</a>
      </nav>

      {/* Floating AI Coach FAB */}
      <button
        type="button"
        className={`coach-fab ${coachOpen ? 'coach-fab--open' : ''}`}
        onClick={() => setCoachOpen((v) => !v)}
        aria-label={coachOpen ? 'Close AI Coach' : 'Open AI Coach'}
      >
        {coachOpen ? '\u2715' : '\uD83E\uDD16'}
      </button>

      {/* AI Coach floating panel */}
      <div className={`coach-panel ${coachOpen ? 'coach-panel--open' : ''}`} role="dialog" aria-label="AI Coach" aria-modal={coachOpen} inert={coachOpen ? undefined : ''}>
        <div className="coach-panel-header">
          <div className="coach-panel-title">
            <span className="coach-panel-badge">AI Coach</span>
            <span className="coach-panel-scope">{aiScopeLabel}</span>
          </div>
          <div className="coach-panel-actions">
            <button
              type="button"
              className="coach-sessions-toggle"
              onClick={() => { setShowSessionList((v) => !v); if (!showSessionList) loadCoachSessions(); }}
              aria-label="Session history"
              title="Session history"
            >
              {'\u2630'}
            </button>
            <button type="button" className="coach-panel-close" onClick={() => setCoachOpen(false)} aria-label="Close">
              {'\u2715'}
            </button>
          </div>
        </div>

        {showSessionList && (
          <div className="coach-session-list">
            <div className="coach-session-list-header">
              <strong>Sessions</strong>
              <button type="button" className="coach-new-session-btn" onClick={() => { startNewSession(); setShowSessionList(false); }}>
                + New Chat
              </button>
            </div>
            <div className="coach-session-list-items">
              {chatSessions.length === 0 && <p className="muted" style={{ padding: '8px 12px', fontSize: '0.8rem' }}>No sessions yet.</p>}
              {chatSessions.map((s) => (
                <div
                  key={s.id}
                  className={`coach-session-item ${s.id === chatSessionId ? 'coach-session-item--active' : ''}`}
                >
                  <button
                    type="button"
                    className="coach-session-item-btn"
                    onClick={() => handleSelectSession(s.id)}
                    title={s.title || 'Untitled session'}
                  >
                    <span className="coach-session-item-title">{s.title || 'Untitled session'}</span>
                    <span className="coach-session-item-meta">
                      {s.message_count || 0} msgs &middot; {s.updated_at ? new Date(s.updated_at + 'Z').toLocaleDateString() : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="coach-session-item-delete"
                    onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
                    aria-label="Delete session"
                    title="Delete session"
                  >
                    {'\u2715'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <nav className="coach-tabs">
          <button
            type="button"
            className={`coach-tab ${coachTab === 'chat' ? 'coach-tab--active' : ''}`}
            onClick={() => setCoachTab('chat')}
          >
            Chat
          </button>
          <button
            type="button"
            className={`coach-tab ${coachTab === 'review' ? 'coach-tab--active' : ''}`}
            onClick={() => setCoachTab('review')}
          >
            Review
          </button>
        </nav>

        <div className="coach-panel-body">
          {coachTab === 'chat' && (
            <>
              <div className="coach-chat-log" role="log" aria-live="polite">
                {aiMessages.map((message, idx) => (
                  <article key={`ai-${idx}`} className={`ai-message ${message.role === 'assistant' ? 'assistant' : 'user'}`}>
                    <strong>{message.role === 'assistant' ? 'Coach' : 'You'}</strong>
                    <p>{message.content}</p>
                  </article>
                ))}
                {isAskingAi && (
                  <article className="ai-message assistant typing">
                    <strong>Coach</strong>
                    <p>Thinking...</p>
                  </article>
                )}
                <div ref={aiChatEndRef} />
              </div>
              <div className="coach-quick-prompts">
                {AI_COACH_QUICK_PROMPTS.map((prompt) => (
                  <button key={prompt} type="button" className="ai-chip" onClick={() => handleAskAi(prompt)}>
                    {prompt}
                  </button>
                ))}
              </div>
            </>
          )}

          {coachTab === 'review' && (
            <div className="coach-review-body">
              <label>
                Review focus (optional)
                <Textarea
                  rows={2}
                  value={aiFocus}
                  placeholder="Example: Focus on Data Insights timing and low-confidence misses."
                  onChange={(event) => setAiFocus(event.target.value)}
                />
              </label>
              <Button type="button" className="btn-primary" onClick={handleGenerateAiReview} disabled={isGeneratingAiReview}>
                {isGeneratingAiReview ? 'Generating...' : 'Generate Review'}
              </Button>
              <div className="coach-review-output">
                {aiReview ? <pre>{aiReview}</pre> : <p className="muted">Generate a review to get personalized recommendations.</p>}
              </div>
            </div>
          )}
        </div>

        <div className="coach-panel-footer">
          {coachTab === 'chat' && (
            <div className="coach-composer">
              <Textarea
                rows={1}
                value={aiQuestion}
                placeholder="Ask your coach..."
                onChange={(event) => setAiQuestion(event.target.value)}
                onKeyDown={handleAiComposerKeyDown}
              />
              <button
                type="button"
                className="coach-send-btn"
                onClick={() => handleAskAi()}
                disabled={isAskingAi || !String(aiQuestion || '').trim()}
                aria-label="Send"
              >
                {isAskingAi ? '...' : '\u2191'}
              </button>
            </div>
          )}
          {coachTab === 'chat' && (
            <button type="button" className="coach-reset-link" onClick={handleResetAiChat}>
              New Chat
            </button>
          )}
        </div>
      </div>

      {coachOpen && <div className="coach-backdrop" onClick={() => setCoachOpen(false)} />}

      <Card id="dashboard" className="card topic-dashboard">
        <div className="section-header">
          <h2>Performance by Subject</h2>
          <button
            type="button"
            className="collapse-toggle"
            onClick={() => toggleSection('topicDashboard')}
            aria-expanded={!collapsedSections.topicDashboard}
            aria-label="Toggle Topic Dashboard section"
          >
            {collapsedSections.topicDashboard ? '\u002B' : '\u2212'}
          </button>
        </div>

        {!collapsedSections.topicDashboard && (
          <div className="dashboard-strip">
            {!subjectCards.length && <p className="muted">Sync a practice session to see subject performance here.</p>}
            {subjectCards.length > 0 && (
              <div className="dashboard-overall">
                <span className="dashboard-overall-label">Overall</span>
                <strong className="dashboard-overall-value">{formatPercent(overallMastery)}</strong>
              </div>
            )}
            {subjectCards.map((card) => {
              const accuracy = Math.max(0, Math.min(100, Number(card.accuracy_pct || 0)));
              return (
                <article key={card.family} className="dashboard-subject">
                  <div className="dashboard-subject-head">
                    <span className="dashboard-subject-name">{normalizeSubjectFamilyDisplay(card.family)}</span>
                    <strong className="dashboard-subject-pct">{formatPercent(accuracy)}</strong>
                  </div>
                  <div className="dashboard-subject-bar">
                    <div className="dashboard-subject-fill" style={{ width: `${accuracy}%` }} />
                  </div>
                  <span className="dashboard-subject-meta">{card.correct}/{card.total} · {formatDurationSeconds(card.avg_time_sec)} avg</span>
                </article>
              );
            })}
          </div>
        )}
      </Card>

      <Card id="categories" className="card">
        <div className="section-header">
          <h2>Category Breakdown</h2>
          <div className="section-header-actions">
            <button
              type="button"
              className={`difficulty-toggle ${showDifficultyCols ? 'difficulty-toggle--active' : ''}`}
              onClick={() => setShowDifficultyCols((v) => !v)}
            >
              {showDifficultyCols ? 'Hide' : 'Show'} Difficulty
            </button>
            <button
              type="button"
              className="collapse-toggle"
              onClick={() => toggleSection('categoryBreakdown')}
              aria-expanded={!collapsedSections.categoryBreakdown}
              aria-label="Toggle Category Detailed Breakdown section"
            >
              {collapsedSections.categoryBreakdown ? '\u002B' : '\u2212'}
            </button>
          </div>
        </div>
        {!collapsedSections.categoryBreakdown && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('subject_family')}>Subject {sortIndicator(categoryBreakdownSort, 'subject_family')}</th>
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('category')}>Category {sortIndicator(categoryBreakdownSort, 'category')}</th>
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('total_questions')}>Total {sortIndicator(categoryBreakdownSort, 'total_questions')}</th>
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('correct_count')}>Correct {sortIndicator(categoryBreakdownSort, 'correct_count')}</th>
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('incorrect_count')}>Wrong {sortIndicator(categoryBreakdownSort, 'incorrect_count')}</th>
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('accuracy_pct')}>Accuracy {sortIndicator(categoryBreakdownSort, 'accuracy_pct')}</th>
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('avg_time_sec')}>Avg Time {sortIndicator(categoryBreakdownSort, 'avg_time_sec')}</th>
                  {showDifficultyCols && <th className="sortable" onClick={() => handleCategoryBreakdownSort('hard')}>Hard {sortIndicator(categoryBreakdownSort, 'hard')}</th>}
                  {showDifficultyCols && <th className="sortable" onClick={() => handleCategoryBreakdownSort('medium')}>Medium {sortIndicator(categoryBreakdownSort, 'medium')}</th>}
                  {showDifficultyCols && <th className="sortable" onClick={() => handleCategoryBreakdownSort('easy')}>Easy {sortIndicator(categoryBreakdownSort, 'easy')}</th>}
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('status')}>Status {sortIndicator(categoryBreakdownSort, 'status')}</th>
                  <th>Drilldown</th>
                </tr>
              </thead>
              <tbody>
                {!categoryRows.length && (
                  <tr>
                    <td colSpan={showDifficultyCols ? 12 : 9}>Sync practice sessions to see category-level breakdowns.</td>
                  </tr>
                )}
                {sortedCategoryRows.map((row) => {
                  const statusLabel = statusLabelFromAccuracy(row.accuracy_pct);
                  const drilldownKey = categoryDrilldownKey(row);
                  const subcategoryRows = sortedSubcategoryRowsByCategory.get(drilldownKey) || [];
                  const isExpanded = expandedCategoryKey === drilldownKey;
                  return (
                    <Fragment key={drilldownKey}>
                      <tr>
                        <td className="section-col"><SubjectCell row={row} /></td>
                        <td>{formatMaybe(normalizedCategoryCode(row))}</td>
                        <td>{formatMaybe(row.total_questions)}</td>
                        <td>{formatMaybe(row.correct_count)}</td>
                        <td>{formatMaybe(row.incorrect_count)}</td>
                        <td>{formatPercent(row.accuracy_pct)}</td>
                        <td>{formatDurationSeconds(row.avg_time_sec)}</td>
                        {showDifficultyCols && <td>{formatDifficultyStat(row.hard_total, row.hard_accuracy_pct, row.hard_avg_time_sec)}</td>}
                        {showDifficultyCols && <td>{formatDifficultyStat(row.medium_total, row.medium_accuracy_pct, row.medium_avg_time_sec)}</td>}
                        {showDifficultyCols && <td>{formatDifficultyStat(row.easy_total, row.easy_accuracy_pct, row.easy_avg_time_sec)}</td>}
                        <td>
                          <Badge
                            variant={statusVariantFromAccuracy(row.accuracy_pct)}
                            className={`status-pill ${String(statusLabel).toLowerCase().replace(/\s+/g, '-')}`}
                          >
                            {statusLabel}
                          </Badge>
                        </td>
                        <td className="category-drilldown-cell">
                          {subcategoryRows.length ? (
                            <Button
                              variant="outline"
                              size="sm"
                              type="button"
                              className="readmore-btn"
                              onClick={() => toggleCategoryDrilldown(row)}
                            >
                              {isExpanded ? 'Hide' : `View ${subcategoryRows.length}`}
                            </Button>
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="category-drilldown-row">
                          <td colSpan={showDifficultyCols ? 12 : 9}>
                            <div className="subcategory-drilldown-panel">
                              <div className="subcategory-drilldown-head">
                                <strong>
                                  {formatMaybe(normalizeSubjectFamilyDisplay(row.subject_family))} / {formatMaybe(normalizedCategoryCode(row))}
                                </strong>
                                <span className="muted">{subcategoryRows.length} subcategories</span>
                              </div>
                              <div className="table-wrap subcategory-drilldown-wrap">
                                <table className="subcategory-drilldown-table">
                                  <thead>
                                    <tr>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('subtopic')}>
                                        Subcategory {sortIndicator(subcategoryBreakdownSort, 'subtopic')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('total_questions')}>
                                        Total {sortIndicator(subcategoryBreakdownSort, 'total_questions')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('correct_count')}>
                                        Correct {sortIndicator(subcategoryBreakdownSort, 'correct_count')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('incorrect_count')}>
                                        Incorrect {sortIndicator(subcategoryBreakdownSort, 'incorrect_count')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('accuracy_pct')}>
                                        Accuracy {sortIndicator(subcategoryBreakdownSort, 'accuracy_pct')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('avg_time_sec')}>
                                        Avg Time {sortIndicator(subcategoryBreakdownSort, 'avg_time_sec')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('hard')}>
                                        Hard (Q / Acc / Avg) {sortIndicator(subcategoryBreakdownSort, 'hard')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('medium')}>
                                        Medium (Q / Acc / Avg) {sortIndicator(subcategoryBreakdownSort, 'medium')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('easy')}>
                                        Easy (Q / Acc / Avg) {sortIndicator(subcategoryBreakdownSort, 'easy')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('status')}>
                                        Status {sortIndicator(subcategoryBreakdownSort, 'status')}
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {subcategoryRows.map((subRow) => {
                                      const subStatus = statusLabelFromAccuracy(subRow.accuracy_pct);
                                      return (
                                        <tr key={`${drilldownKey}|${subRow.subtopic}`}>
                                          <td>{formatMaybe(subRow.subtopic)}</td>
                                          <td>{formatMaybe(subRow.total_questions)}</td>
                                          <td>{formatMaybe(subRow.correct_count)}</td>
                                          <td>{formatMaybe(subRow.incorrect_count)}</td>
                                          <td>{formatPercent(subRow.accuracy_pct)}</td>
                                          <td>{formatDurationSeconds(subRow.avg_time_sec)}</td>
                                          <td>{formatDifficultyStat(subRow.hard_total, subRow.hard_accuracy_pct, subRow.hard_avg_time_sec)}</td>
                                          <td>{formatDifficultyStat(subRow.medium_total, subRow.medium_accuracy_pct, subRow.medium_avg_time_sec)}</td>
                                          <td>{formatDifficultyStat(subRow.easy_total, subRow.easy_accuracy_pct, subRow.easy_avg_time_sec)}</td>
                                          <td>
                                            <Badge
                                              variant={statusVariantFromAccuracy(subRow.accuracy_pct)}
                                              className={`status-pill ${String(subStatus).toLowerCase().replace(/\s+/g, '-')}`}
                                            >
                                              {subStatus}
                                            </Badge>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card id="sessions" className="card">
        <div className="section-header-filters">
          <h2>Performance by Session</h2>
          <div className="filter-row session-filters">
            <Select
              className="filter-select"
              value={sessionPlatformFilter}
              onChange={(e) => setSessionPlatformFilter(e.target.value)}
            >
              <option value="">All sources</option>
              <option value="starttest">Official Guide</option>
              <option value="gmatclub">GMAT Club</option>
            </Select>
            <Select
              className="filter-select"
              value={sessionSubjectFilter}
              onChange={(e) => setSessionSubjectFilter(e.target.value)}
            >
              <option value="">All Subjects</option>
              <option value="Q">Quant</option>
              <option value="V">Verbal</option>
              <option value="DI">Data Insights</option>
            </Select>
            <div className="date-filter-group">
              <Input
                type="date"
                placeholder="Start Date"
                value={sessionDateRange.start}
                onChange={(e) => setSessionDateRange((prev) => ({ ...prev, start: e.target.value }))}
              />
              <span>to</span>
              <Input
                type="date"
                placeholder="End Date"
                value={sessionDateRange.end}
                onChange={(e) => setSessionDateRange((prev) => ({ ...prev, end: e.target.value }))}
              />
            </div>
            {(sessionSubjectFilter || sessionPlatformFilter || sessionDateRange.start || sessionDateRange.end) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSessionSubjectFilter('');
                  setSessionPlatformFilter('');
                  setSessionDateRange({ start: '', end: '' });
                }}
              >
                Clear
              </Button>
            )}
            <button
              type="button"
              className="collapse-toggle"
              onClick={() => toggleSection('performanceBySession')}
              aria-expanded={!collapsedSections.performanceBySession}
              aria-label="Toggle Performance by Session section"
            >
              {collapsedSections.performanceBySession ? '\u002B' : '\u2212'}
            </button>
          </div>
        </div>
        {!collapsedSections.performanceBySession && (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => handleSessionSort('session_date')}>Date {sortIndicator(sessionSort, 'session_date')}</th>
                    <th className="sortable" onClick={() => handleSessionSort('source')}>Source {sortIndicator(sessionSort, 'source')}</th>
                    <th className="sortable" onClick={() => handleSessionSort('subject')}>Subject {sortIndicator(sessionSort, 'subject')}</th>
                    <th className="sortable" onClick={() => handleSessionSort('question_count_display')}>Questions {sortIndicator(sessionSort, 'question_count_display')}</th>
                    <th className="sortable" onClick={() => handleSessionSort('error_count_display')}>Errors {sortIndicator(sessionSort, 'error_count_display')}</th>
                    <th className="sortable" onClick={() => handleSessionSort('answered_accuracy_pct')}>Accuracy % {sortIndicator(sessionSort, 'answered_accuracy_pct')}</th>
                    <th className="sortable" onClick={() => handleSessionSort('avg_time_sec')}>Avg Time {sortIndicator(sessionSort, 'avg_time_sec')}</th>
                    <th>Hard (Q / Acc / Avg)</th>
                    <th>Medium (Q / Acc / Avg)</th>
                    <th>Easy (Q / Acc / Avg)</th>
                    <th>Session Analysis</th>
                  </tr>
                </thead>
                <tbody>
                  {processedSessions.length === 0 && (
                    <tr>
                      <td colSpan="11">No sessions yet. Use "Sync GMAT Practice" above to import your first session.</td>
                    </tr>
                  )}
                  {processedSessions.map((row) => (
                    <tr key={`${row.session_external_id}-${row.run_id}`}>
                      <td>{formatDate(row.session_date)}</td>
                      <td><SourceBadge source={row.source} /></td>
                      <td className="section-col"><SubjectCell row={row} /></td>
                      <td>{formatMaybe(row.question_count_display)}</td>
                      <td>{formatMaybe(row.error_count_display)}</td>
                      <td>{formatPercent(row.answered_accuracy_pct)}</td>
                      <td>{formatDurationSeconds(row.avg_time_sec)}</td>
                      <td>{formatDifficultyStat(row.hard_total, row.hard_accuracy_pct, row.hard_avg_time_sec)}</td>
                      <td>{formatDifficultyStat(row.medium_total, row.medium_accuracy_pct, row.medium_avg_time_sec)}</td>
                      <td>{formatDifficultyStat(row.easy_total, row.easy_accuracy_pct, row.easy_avg_time_sec)}</td>
                      <td>
                        <Button
                          variant="outline"
                          size="sm"
                          className="readmore-btn"
                          type="button"
                          onClick={() => handleOpenSessionAnalysis(row)}
                        >
                          Read more
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination-controls">
              <Button
                variant="outline"
                size="sm"
                disabled={sessionPagination.page <= 1}
                onClick={() => loadSessions(sessionPagination.page - 1)}
              >
                Previous
              </Button>
              <span className="pagination-info">
                Page {sessionPagination.page} of {sessionPagination.totalPages || 1} ({sessionPagination.total} total sessions)
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={sessionPagination.page >= sessionPagination.totalPages}
                onClick={() => loadSessions(sessionPagination.page + 1)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </Card>

      <Card id="errors" className="card">
        <div className="section-header">
          <h2>Error Log</h2>
          <button
            type="button"
            className="collapse-toggle"
            onClick={() => toggleSection('errorLog')}
            aria-expanded={!collapsedSections.errorLog}
            aria-label="Toggle Error Log section"
          >
            {collapsedSections.errorLog ? '\u002B' : '\u2212'}
          </button>
        </div>
        {!collapsedSections.errorLog && (
          <>
            <div className="filter-row">
                <Select
                  value={filters.platform}
                  onChange={(event) => setFilters((prev) => ({ ...prev, platform: event.target.value }))}
                >
                  <option value="">All sources</option>
                  <option value="starttest">Official Guide</option>
                  <option value="gmatclub">GMAT Club</option>
                </Select>
                <Select
                  value={filters.subject}
                  onChange={(event) => setFilters((prev) => ({ ...prev, subject: event.target.value }))}
                >
                  <option value="">All subjects</option>
                  <option value="Q">Quant</option>
                  <option value="V">Verbal</option>
                  <option value="DI">Data Insights</option>
                </Select>
                <Select
                  value={filters.difficulty}
                  onChange={(event) => setFilters((prev) => ({ ...prev, difficulty: event.target.value }))}
                >
                  <option value="">All difficulty</option>
                  <option value="Hard">Hard</option>
                  <option value="Medium">Medium</option>
                  <option value="Easy">Easy</option>
                  <option value="Unknown">Unknown</option>
                </Select>
                <Select
                  value={filters.confidence}
                  onChange={(event) => setFilters((prev) => ({ ...prev, confidence: event.target.value }))}
                >
                  <option value="">All confidence</option>
                  <option value="high">high</option>
                  <option value="medium">medium</option>
                  <option value="low">low</option>
                  <option value="not selected">not selected</option>
                </Select>
                <Input
                  placeholder="Search subcategory, Q Code, or stem..."
                  value={filters.search}
                  onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
                />
                <Select
                  value={filters.mistakeTag}
                  onChange={(event) => setFilters((prev) => ({ ...prev, mistakeTag: event.target.value }))}
                >
                  <option value="">All mistake tags</option>
                  {ALL_MISTAKE_TAGS.map((tag) => (
                    <option key={tag} value={tag}>{tag}</option>
                  ))}
                </Select>
                {(filters.subject || filters.difficulty || filters.confidence || filters.search || filters.mistakeTag || filters.platform) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setFilters({ subject: '', difficulty: '', topic: '', confidence: '', search: '', mistakeTag: '', platform: '' })}
                  >
                    Clear
                  </Button>
                )}
            </div>

            <div className="table-wrap error-log-table-wrap">
              <table className="review-table error-log-table">
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => handleErrorSort('session_date')}>Date {sortIndicator(errorSort, 'session_date')}</th>
                    <th className="sortable" onClick={() => handleErrorSort('source')}>Source {sortIndicator(errorSort, 'source')}</th>
                    <th className="sortable section-col" onClick={() => handleErrorSort('subject')}>Subject {sortIndicator(errorSort, 'subject')}</th>
                    <th className="category-col">Category</th>
                    <th className="sortable topic-col" onClick={() => handleErrorSort('topic')}>Subcategory {sortIndicator(errorSort, 'topic')}</th>
                    <th className="sortable" onClick={() => handleErrorSort('difficulty')}>Difficulty {sortIndicator(errorSort, 'difficulty')}</th>
                    <th className="sortable" onClick={() => handleErrorSort('q_code')}>Q Code {sortIndicator(errorSort, 'q_code')}</th>
                    <th className="response-col">Response</th>
                    <th>Redo</th>
                    <th className="sortable" onClick={() => handleErrorSort('time_sec')}>Time (min:sec) {sortIndicator(errorSort, 'time_sec')}</th>
                    <th className="sortable" onClick={() => handleErrorSort('mistake_type')}>Mistake Type {sortIndicator(errorSort, 'mistake_type')}</th>
                    <th className="notes-col">Notes</th>
                    <th className="action-col annotate-col">Annotate</th>
                    <th className="action-col open-col">Review</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.length === 0 && (
                    <tr>
                      <td colSpan="14">No errors match the current filters. Try adjusting or clearing the filters above.</td>
                    </tr>
                  )}
                  {errors.map((row) => (
                    <tr key={row.id}>
                      <td>{formatDate(row.session_date)}</td>
                      <td><SourceBadge source={row.source} /></td>
                      <td className="section-col"><SubjectCell row={row} /></td>
                      <td className="category-col">{formatMaybe(normalizedCategoryCode(row))}</td>
                      <td className="topic-col">{formatMaybe(normalizedSubcategory(row))}</td>
                      <td>{formatMaybe(row.difficulty)}</td>
                      <td>{formatMaybe(row.q_code)}</td>
                      <td className="response-col"><ResponseCell row={row} /></td>
                      <td className="redo-col">
                        {Number(row.corrected_later || 0) === 1 ? (
                          <Badge variant="success" className="redo-pill">
                            Corrected
                          </Badge>
                        ) : (
                          <span className="muted">Not yet</span>
                        )}
                      </td>
                      <td>{formatDurationSeconds(row.time_sec)}</td>
                      <td className="mistake-tags-cell">
                        {parseMistakeTags(row.mistake_type).length > 0
                          ? parseMistakeTags(row.mistake_type).map((tag) => (
                              <span key={tag} className="mistake-tag-pill">{tag}</span>
                            ))
                          : <span className="muted">-</span>}
                      </td>
                      <td className="notes-cell notes-col" title={row.notes || ''}>
                        {formatNotePreview(row.notes)}
                      </td>
                      <td className="action-col annotate-col">
                        <Button
                          variant="outline"
                          size="sm"
                          className="readmore-btn"
                          type="button"
                          onClick={() => handleOpenAnnotation(row)}
                        >
                          Annotate
                        </Button>
                      </td>
                      <td className="action-col open-col">
                        {hasScrapedQuestionContent(row) || row.question_url ? (
                          <Button
                            variant="outline"
                            size="sm"
                            type="button"
                            className="readmore-btn"
                            onClick={() => handleQuestionAction(row, 'error-log')}
                            disabled={openingQuestionKey === questionOpenKey(row, 'error-log')}
                          >
                            {openingQuestionKey === questionOpenKey(row, 'error-log')
                              ? 'Opening...'
                              : formatQuestionActionLabel(row)}
                          </Button>
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination-controls">
              <Button
                variant="outline"
                size="sm"
                disabled={errorPagination.page <= 1}
                onClick={() => loadErrors(errorPagination.page - 1)}
              >
                Previous
              </Button>
              <span className="pagination-info">
                Page {errorPagination.page} of {errorPagination.totalPages || 1} ({errorPagination.total} total errors)
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={errorPagination.page >= errorPagination.totalPages}
                onClick={() => loadErrors(errorPagination.page + 1)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </Card>

      {syncCenterOpen && (
        <div
          className="analysis-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Sync GMAT Practice"
          onClick={() => setSyncCenterOpen(false)}
        >
          <div className="analysis-dialog sync-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="analysis-shell">
              <div className="analysis-header">
                <h2>Sync GMAT Practice</h2>
                <Button variant="outline" type="button" onClick={() => setSyncCenterOpen(false)}>
                  Close
                </Button>
              </div>

              <section className="analysis-block">
                <h3>1) Trigger Scrape</h3>
                <div className="form-grid">
                  <label>
                    Source
                    <Select value={selectedSource} onChange={(e) => setSelectedSource(e.target.value)}>
                      {sources.map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.label}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label>
                    Scrape Period
                    <Select value={scrapeWindow} onChange={(e) => setScrapeWindow(e.target.value)}>
                      <option value="today">Today (default, with safety buffer)</option>
                      <option value="last3">Last 3 days</option>
                      <option value="last7">Last 7 days</option>
                      <option value="full">Full update</option>
                      <option value="custom">Specific period</option>
                    </Select>
                  </label>
                  {scrapeWindow === 'custom' && (
                    <label>
                      Specific Period (since, ICT UTC+7)
                      <Input
                        type="datetime-local"
                        value={customSince}
                        onChange={(event) => setCustomSince(event.target.value)}
                      />
                    </label>
                  )}
                  <div className="action-row">
                    <Button
                      variant="outline"
                      type="button"
                      disabled={isOpening || !selectedSource}
                      onClick={handleOpenChrome}
                    >
                      {isOpening ? 'Opening...' : 'Open Chrome (CDP)'}
                    </Button>
                    {sources.find((s) => s.id === selectedSource)?.platform === 'starttest' && (
                      <Button
                        variant="outline"
                        type="button"
                        disabled={isOpeningProduct || !selectedSource}
                        onClick={handleOpenProduct}
                        title="Switch your GMAT Chrome tab to the selected product's home page"
                      >
                        {isOpeningProduct ? 'Switching...' : 'Open in GMAT'}
                      </Button>
                    )}
                    <Button
                      type="button"
                      disabled={isScraping || !selectedSource || (scrapeWindow === 'custom' && !customSince)}
                      onClick={handleScrape}
                    >
                      {isScraping ? 'Scraping...' : 'Run Scrape + Save to DB'}
                    </Button>
                  </div>
                </div>
                {syncDebug && (
                  <div className="sync-debug">
                    <div className="sync-debug-head">
                      <h3>Last Sync Debug</h3>
                      <Button variant="outline" type="button" onClick={() => setSyncDebug(null)}>
                        Clear
                      </Button>
                    </div>
                    <pre>{JSON.stringify(syncDebug, null, 2)}</pre>
                  </div>
                )}
              </section>

              <section className="analysis-block">
                <h3>2) Review Run</h3>
                <div className="run-header">
                  <label>
                    Run
                    <Select value={selectedRunId} onChange={handleRunChange}>
                      <option value="">All runs (upserted dataset)</option>
                      {runs.map((run) => (
                        <option key={run.id} value={run.id}>
                          {`Run ${run.id} | ${new Date(run.extracted_at).toLocaleString()}`}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
                <div className="summary-grid">
                  <div className="summary-item">
                    <span>Run ID</span>
                    <strong>{summary.id}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Sessions</span>
                    <strong>{summary.total_sessions || 0}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Questions</span>
                    <strong>{summary.total_questions || 0}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Errors</span>
                    <strong>{summary.total_errors || 0}</strong>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}

      {patternDrilldown.open && (
        <div
          className="analysis-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Pattern Drilldown"
          onClick={handleClosePatternDrilldown}
        >
          <div className="analysis-dialog session-analysis-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="analysis-shell">
              <div className="analysis-header">
                <h2>{patternDrilldown.title}</h2>
                <div className="analysis-actions">
                  <Button variant="outline" type="button" onClick={handleApplyPatternToErrorLog}>
                    Apply to Error Log
                  </Button>
                  <Button variant="outline" type="button" onClick={handleClosePatternDrilldown}>
                    Close
                  </Button>
                </div>
              </div>

              {patternDrilldown.loading && <p className="muted">Loading matching errors...</p>}
              {patternDrilldown.error && <p className="error">{patternDrilldown.error}</p>}

              {!patternDrilldown.loading && !patternDrilldown.error && (
                <>
                  <p className="muted">{`${patternDrilldown.rows.length} matching errors`}</p>
                  <div className="table-wrap">
                    <table className="review-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Session</th>
                          <th className="section-col">Subject</th>
                          <th className="category-col">Category</th>
                          <th>Subcategory</th>
                          <th>Difficulty</th>
                          <th>Q Code</th>
                          <th className="response-col">Response</th>
                          <th>Confidence</th>
                          <th>Redo</th>
                          <th>Open</th>
                          <th>Time</th>
                          <th>Mistake Type</th>
                          <th>Notes</th>
                          <th>Annotate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!patternDrilldown.rows.length && (
                          <tr>
                            <td colSpan="15">No rows match this pattern.</td>
                          </tr>
                        )}
                        {patternDrilldown.rows.map((row) => (
                          <tr key={row.id}>
                            <td>{formatDate(row.session_date)}</td>
                            <td>{formatMaybe(row.session_external_id)}</td>
                            <td className="section-col"><SubjectCell row={row} /></td>
                            <td className="category-col">{formatMaybe(normalizedCategoryCode(row))}</td>
                            <td>{formatMaybe(normalizedSubcategory(row))}</td>
                            <td>{formatMaybe(row.difficulty)}</td>
                            <td>{formatMaybe(row.q_code)}</td>
                            <td className="response-col"><ResponseCell row={row} /></td>
                            <td>{formatMaybe(row.confidence)}</td>
                            <td>
                              {Number(row.corrected_later || 0) === 1 ? (
                                <Badge variant="success" className="redo-pill">
                                  Corrected
                                </Badge>
                              ) : (
                                <span className="muted">Not yet</span>
                              )}
                            </td>
                            <td>
                              {hasScrapedQuestionContent(row) || row.question_url ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  type="button"
                                  className="readmore-btn"
                                  onClick={() => handleQuestionAction(row, 'drilldown')}
                                  disabled={openingQuestionKey === questionOpenKey(row, 'drilldown')}
                                >
                                  {openingQuestionKey === questionOpenKey(row, 'drilldown')
                                    ? 'Opening...'
                                    : formatQuestionActionLabel(row)}
                                </Button>
                              ) : (
                                <span className="muted">-</span>
                              )}
                            </td>
                            <td>{formatDurationSeconds(row.time_sec)}</td>
                            <td>{formatMaybe(row.mistake_type)}</td>
                            <td className="notes-cell" title={row.notes || ''}>
                              {formatNotePreview(row.notes)}
                            </td>
                            <td>
                              <Button
                                variant="outline"
                                size="sm"
                                className="readmore-btn"
                                type="button"
                                onClick={() => handleOpenAnnotation(row)}
                              >
                                Annotate
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {sessionAnalysis.open && (
        <div
          className="analysis-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Session Analysis"
          onClick={handleCloseSessionAnalysis}
        >
          <div className="analysis-dialog session-analysis-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="analysis-shell">
            <div className="analysis-header">
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <h2 style={{ margin: 0 }}>Session Analysis</h2>
                {sessionAnalysis.data?.session?.source && (
                  <SourceBadge source={sessionAnalysis.data.session.source} />
                )}
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {sessionAnalysis.data?.session && sources.some((s) => s.label === sessionAnalysis.data.session.source && (s.platform === 'starttest' || s.platform === 'gmatclub')) && (
                  <Button
                    variant="outline"
                    type="button"
                    disabled={isEnriching}
                    onClick={() => handleEnrichSession(sessionAnalysis.data.session.id)}
                    title="Phase 2: deep-enrich this session by visiting each question's page. Long-running; keep the matching tab open."
                  >
                    {isEnriching ? 'Enriching…' : 'Enrich Phase 2'}
                  </Button>
                )}
                <Button variant="outline" type="button" onClick={handleCloseSessionAnalysis}>
                  Close
                </Button>
              </div>
            </div>
            {lastEnrichResult && sessionAnalysis.data?.session && (
              <div className={`status ${lastEnrichResult.ok === false || lastEnrichResult.aborted ? 'error' : ''}`} style={{ marginBottom: '8px', fontSize: '0.85rem' }}>
                {lastEnrichResult.ok === false
                  ? `Phase 2 failed: ${lastEnrichResult.error}`
                  : lastEnrichResult.aborted
                    ? `Phase 2 aborted: ${lastEnrichResult.dbUpdated}/${lastEnrichResult.qhTotal} saved (${lastEnrichResult.abortReason})`
                    : `Phase 2: ${lastEnrichResult.dbUpdated}/${lastEnrichResult.qhTotal} items enriched.`}
              </div>
            )}

            {sessionAnalysis.loading && <p className="muted loading-pulse">Loading session data...</p>}
            {sessionAnalysis.error && <p className="status error">{sessionAnalysis.error}</p>}

            {!sessionAnalysis.loading && !sessionAnalysis.error && sessionAnalysis.data?.session && (
              <>
                <div className="session-stats-primary">
                  <div className="session-stat-hero">
                    <span>Accuracy</span>
                    <strong>{formatPercent(getSessionAnsweredAccuracy(sessionAnalysis.data.session))}</strong>
                  </div>
                  <div className="session-stat-hero">
                    <span>Questions</span>
                    <strong>{formatMaybe(getSessionQuestionCount(sessionAnalysis.data.session))}</strong>
                  </div>
                  <div className="session-stat-hero">
                    <span>Avg Time</span>
                    <strong>{formatDurationSeconds(sessionAnalysis.data.session.avg_time_sec)}</strong>
                  </div>
                </div>
                <div className="session-stats-secondary">
                  <span>{formatDate(sessionAnalysis.data.session.session_date)}</span>
                  <span>{formatMaybe(normalizeSubjectCodeValue(sessionAnalysis.data.session.subject))}</span>
                  <span>Completion {formatPercent(getSessionCompletionRate(sessionAnalysis.data.session))}</span>
                  <span>Unanswered {formatMaybe(getSessionUnansweredCount(sessionAnalysis.data.session))}</span>
                  <span>Correct avg {formatDurationSeconds(sessionAnalysis.data.session.avg_correct_time_sec)}</span>
                  <span>Wrong avg {formatDurationSeconds(sessionAnalysis.data.session.avg_incorrect_time_sec)}</span>
                  <span>ID {formatMaybe(sessionAnalysis.data.session.session_external_id)}</span>
                </div>

                <div className="analysis-block">
                  <h3>Difficulty Breakdown</h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Difficulty</th>
                          <th>Q</th>
                          <th>Correct</th>
                          <th>Wrong</th>
                          <th>Accuracy</th>
                          <th>Avg Time</th>
                          <th>Avg Correct Time</th>
                          <th>Avg Incorrect Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!sessionAnalysis.data.byDifficulty?.length && (
                          <tr>
                            <td colSpan="8">No question-level data for this session.</td>
                          </tr>
                        )}
                        {(sessionAnalysis.data.byDifficulty || []).map((row) => (
                          <tr key={row.difficulty}>
                            <td>{formatMaybe(row.difficulty)}</td>
                            <td>{formatMaybe(row.total)}</td>
                            <td>{formatMaybe(row.correct)}</td>
                            <td>{formatMaybe(row.wrong)}</td>
                            <td>{formatPercent(row.accuracy_pct)}</td>
                            <td>{formatDurationSeconds(row.avg_time_sec)}</td>
                            <td>{formatDurationSeconds(row.avg_correct_time_sec)}</td>
                            <td>{formatDurationSeconds(row.avg_incorrect_time_sec)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="pattern-grid">
                  <div>
                    <h3>Wrong Categories</h3>
                    <ul className="metric-list">
                      {!wrongCategoryRows.length && <li className="metric-empty">No wrong-category data</li>}
                      {wrongCategoryRows.map((row) => (
                        <li key={row.category}>
                          <span className="metric-label">{row.category}</span>
                          <span className="metric-values">
                            <strong>{row.mistakes}</strong>
                            <small>
                              {totalWrongCategoryMistakes
                                ? `${((Number(row.mistakes || 0) * 100) / totalWrongCategoryMistakes).toFixed(1)}%`
                                : '0.0%'}
                            </small>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <h3>Confidence Performance</h3>
                    <ul className="metric-list">
                      {!sessionAnalysis.data.confidencePerformance?.length && <li className="metric-empty">No confidence data</li>}
                      {(sessionAnalysis.data.confidencePerformance || []).map((row) => (
                        <li key={row.confidence}>
                          <span className="metric-label">{row.confidence}</span>
                          <span className="metric-values">
                            <strong>{`${row.wrong}/${row.total} wrong`}</strong>
                            <small>{`Acc ${formatPercent(row.accuracy_pct)}`}</small>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="analysis-block">
                  <h3>{`All Wrong Questions (${sortedSessionAnalysisWrongQuestions.length})`}</h3>
                  <div className="table-wrap session-analysis-questions-wrap">
                    <table className="review-table session-analysis-questions-table">
                      <thead>
                        <tr>
                          <th className="section-col">Subject</th>
                          <th className="category-col">Category</th>
                          <th className="sortable topic-col" onClick={() => handleSessionAnalysisSort('topic')}>Subcategory {sortIndicator(sessionAnalysisSort, 'topic')}</th>
                          <th className="sortable" onClick={() => handleSessionAnalysisSort('difficulty')}>Difficulty {sortIndicator(sessionAnalysisSort, 'difficulty')}</th>
                          <th className="sortable" onClick={() => handleSessionAnalysisSort('q_code')}>Q Code {sortIndicator(sessionAnalysisSort, 'q_code')}</th>
                          <th className="response-col">Response</th>
                          <th className="sortable" onClick={() => handleSessionAnalysisSort('time_sec')}>Time {sortIndicator(sessionAnalysisSort, 'time_sec')}</th>
                          <th className="sortable" onClick={() => handleSessionAnalysisSort('mistake_type')}>Mistake Type {sortIndicator(sessionAnalysisSort, 'mistake_type')}</th>
                          <th className="sortable notes-col" onClick={() => handleSessionAnalysisSort('notes')}>Notes {sortIndicator(sessionAnalysisSort, 'notes')}</th>
                          <th className="action-col annotate-col">Annotate</th>
                          <th className="action-col open-col">Open</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!sessionAnalysis.data.slowWrongQuestions?.length && (
                          <tr>
                            <td colSpan="11">All questions were answered correctly in this session.</td>
                          </tr>
                        )}
                        {sortedSessionAnalysisWrongQuestions.map((row, idx) => (
                          <tr key={`${row.q_code || 'q'}-${idx}`}>
                            <td className="section-col"><SubjectCell row={row} /></td>
                            <td className="category-col">{formatMaybe(normalizedCategoryCode(row))}</td>
                            <td className="topic-col">{formatMaybe(normalizedSubcategory(row))}</td>
                            <td>{formatMaybe(row.difficulty)}</td>
                            <td>{formatMaybe(row.q_code)}</td>
                            <td className="response-col"><ResponseCell row={row} /></td>
                            <td>{formatDurationSeconds(row.time_sec)}</td>
                            <td>{formatMaybe(row.mistake_type)}</td>
                            <td className="notes-cell notes-col" title={row.notes || ''}>
                              {formatNotePreview(row.notes)}
                            </td>
                            <td className="action-col annotate-col">
                              <Button
                                variant="outline"
                                size="sm"
                                className="readmore-btn"
                                type="button"
                                onClick={() => handleOpenAnnotation(row)}
                              >
                                Annotate
                              </Button>
                            </td>
                            <td className="action-col open-col">
                              {hasScrapedQuestionContent(row) || row.question_url ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  type="button"
                                  className="readmore-btn"
                                  onClick={() => handleQuestionAction(row, 'session-analysis')}
                                  disabled={openingQuestionKey === questionOpenKey(row, 'session-analysis')}
                                >
                                  {openingQuestionKey === questionOpenKey(row, 'session-analysis')
                                    ? 'Opening...'
                                    : formatQuestionActionLabel(row)}
                                </Button>
                              ) : (
                                <span className="muted">-</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
          </div>
        </div>
      )}

      {questionReview.open && questionReview.row && (
        <div
          className="analysis-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Question Review"
          onClick={handleCloseQuestionReview}
        >
          <div className="analysis-dialog question-review-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="analysis-shell question-review-shell">
              <div className="analysis-header">
                <h2>{questionReview.row.q_code ? `Question ${questionReview.row.q_code}` : 'Question Review'}</h2>
                <div className="analysis-actions">
                  {canonicalQuestionUrl(questionReview.row) ? (
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => handleOpenQuestionInGmat(questionReview.row, 'question-review')}
                      disabled={openingQuestionKey === questionOpenKey(questionReview.row, 'question-review')}
                    >
                      {openingQuestionKey === questionOpenKey(questionReview.row, 'question-review') ? 'Opening...' : 'Open in GMAT'}
                    </Button>
                  ) : null}
                  <Button variant="outline" type="button" onClick={handleCloseQuestionReview}>
                    Close
                  </Button>
                </div>
              </div>

              <div className="question-review-hero">
                <div className="question-review-meta">
                  <span className="question-review-chip chip-subject">{formatMaybe(normalizeSubjectFamilyDisplay(normalizedSubjectCode(questionReview.row)))}</span>
                  <span className="question-review-chip chip-subject">{formatMaybe(normalizedCategoryCode(questionReview.row))}</span>
                  <span className={`question-review-chip chip-difficulty-${String(questionReview.row.difficulty || '').toLowerCase()}`}>{formatMaybe(questionReview.row.difficulty)}</span>
                  <span className="question-review-chip">{formatMaybe(normalizedSubcategory(questionReview.row))}</span>
                  {formatResponseFormat(questionReview.row.response_format) && (
                    <span className="question-review-chip">{formatResponseFormat(questionReview.row.response_format)}</span>
                  )}
                  {formatContentDomain(questionReview.row.content_domain) && (
                    <span className="question-review-chip">{formatContentDomain(questionReview.row.content_domain)}</span>
                  )}
                  {formatTopicSource(questionReview.row.topic_source) && (
                    <span className="question-review-chip muted-chip">{formatTopicSource(questionReview.row.topic_source)}</span>
                  )}
                </div>
                {getResponseSlots(questionReview.row).length > 0 ? (
                  <div className="di-answer-summary">
                    <div className="di-answer-summary-row di-answer-summary-header">
                      <span>Part</span>
                      <span>Your Answer</span>
                      <span>Correct</span>
                    </div>
                    {getResponseSlots(questionReview.row).map((slot, index) => {
                      const userVal = formatResponseValue(slot, slot?.user_value);
                      const correctVal = formatResponseValue(slot, slot?.correct_value);
                      const isMatch = userVal && correctVal && userVal === correctVal;
                      return (
                        <div key={slot?.slot_id || `row-${index}`} className={`di-answer-summary-row${isMatch ? ' di-row-correct' : userVal ? ' di-row-wrong' : ''}`}>
                          <span className="di-part-label">{normalizeQuestionText(slot?.prompt || '') || `Part ${index + 1}`}</span>
                          <span className="di-answer-yours">{userVal || '—'}</span>
                          <span className="di-answer-correct">{correctVal || '—'}</span>
                        </div>
                      );
                    })}
                    <div className="di-answer-summary-footer">
                      <div><span>Time</span><strong>{formatDurationSeconds(questionReview.row.time_sec)}</strong></div>
                      <div><span>Confidence</span><strong>{formatMaybe(questionReview.row.confidence)}</strong></div>
                    </div>
                  </div>
                ) : (
                  <div className="question-review-stats">
                    <div>
                      <span>Your Answer</span>
                      <strong>{formatMaybe(questionReview.row.my_answer || summarizeStructuredResponse(questionReview.row, 'user_value'))}</strong>
                    </div>
                    <div>
                      <span>Correct</span>
                      <strong>{formatMaybe(questionReview.row.correct_answer || summarizeStructuredResponse(questionReview.row, 'correct_value'))}</strong>
                    </div>
                    <div>
                      <span>Time</span>
                      <strong>{formatDurationSeconds(questionReview.row.time_sec)}</strong>
                    </div>
                    <div>
                      <span>Confidence</span>
                      <strong>{formatMaybe(questionReview.row.confidence)}</strong>
                    </div>
                  </div>
                )}
              </div>

              <section className="question-review-section">
                <h3>Question Stem</h3>
                <div className="question-stem-card">
                  <p>{normalizeQuestionText(questionReview.row.question_stem) || 'No locally scraped stem yet.'}</p>
                </div>
              </section>

              <section className="question-review-layout">
                <div className="question-review-section">
                  <h3>
                    {getResponseSlots(questionReview.row).length
                      ? 'Response Structure'
                      : 'Answer Choices'}
                  </h3>
                  {getResponseSlots(questionReview.row).length ? (
                    <div className="response-slot-list">
                      {getResponseSlots(questionReview.row).map((slot, index) => {
                        const prompt = normalizeQuestionText(slot?.prompt || '') || `Part ${index + 1}`;
                        const slotOptions = Array.isArray(slot?.options) ? slot.options : [];
                        const userValue = formatResponseValue(slot, slot?.user_value);
                        const correctValue = formatResponseValue(slot, slot?.correct_value);
                        const slotType = String(slot?.slot_type || '').toLowerCase();
                        const isDropdown = slotType === 'dropdown';
                        const isChoiceGrid = slotType === 'choice-grid';
                        return (
                          <article key={slot?.slot_id || `slot-${index}`} className={`response-slot-card${isDropdown ? ' slot-dropdown' : ''}${isChoiceGrid ? ' slot-choice-grid' : ''}`}>
                            <div className="response-slot-head">
                              <div>
                                <strong>{prompt}</strong>
                                {formatSlotType(slot?.slot_type) && (
                                  <span className="response-slot-type">{formatSlotType(slot?.slot_type)}</span>
                                )}
                              </div>
                              {(isDropdown && (userValue || correctValue)) ? (
                                <div className="slot-dropdown-answers">
                                  {userValue && <span className="slot-answer-yours">You: {userValue}</span>}
                                  {correctValue && correctValue !== userValue && <span className="slot-answer-correct">Correct: {correctValue}</span>}
                                  {userValue && correctValue && userValue === correctValue && <span className="slot-answer-correct">Correct</span>}
                                </div>
                              ) : (
                                <div className="response-slot-summary">
                                  {userValue && <span>Your response: {userValue}</span>}
                                  {correctValue && <span>Correct response: {correctValue}</span>}
                                </div>
                              )}
                            </div>

                            {slotOptions.length ? (
                              <div className={`response-slot-options${isChoiceGrid ? ' slot-options-compact' : ''}`}>
                                {slotOptions.map((option, optionIndex) => {
                                  const label = String(option?.label || '').trim();
                                  const text = normalizeQuestionText(option?.text || '') || '-';
                                  const isMine = String(slot?.user_value || '').trim() === String(option?.id || '').trim();
                                  const isCorrect = String(slot?.correct_value || '').trim() === String(option?.id || '').trim();
                                  return (
                                    <article
                                      key={`${slot?.slot_id || index}-${option?.id || optionIndex}`}
                                      className={`answer-choice-card response-option-card${isMine ? ' mine' : ''}${isCorrect ? ' correct' : ''}`}
                                    >
                                      <div className="answer-choice-head">
                                        <strong>{label || text}</strong>
                                        <div className="answer-choice-flags">
                                          {isMine && <span className="question-mini-chip">Your pick</span>}
                                          {isCorrect && <span className="question-mini-chip success-chip">Correct</span>}
                                        </div>
                                      </div>
                                      {label && text !== label && <p>{text}</p>}
                                    </article>
                                  );
                                })}
                              </div>
                            ) : (
                              <p className="muted">No option-level scrape for this DI slot.</p>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  ) : parseAnswerChoices(questionReview.row.answer_choices).length ? (
                    (() => {
                      const choices = parseAnswerChoices(questionReview.row.answer_choices);
                      const fmt = String(questionReview.row.response_format || '').toLowerCase();
                      const myAns = String(questionReview.row.my_answer || '').trim();
                      const corrAns = String(questionReview.row.correct_answer || '').trim();
                      // Trust per-choice flags only when at least one option is
                      // actually marked. The two flags are evaluated
                      // independently — some StartTest rows capture which
                      // option the user picked but not which one is correct,
                      // and we want to fall back per-flag in that case.
                      const anyMine = choices.some((c) => c?.isUserSelected === true);
                      const anyCorrectFlagged = choices.some((c) => c?.isCorrect === true);
                      const Legend = (
                        <div className="answer-choice-legend">
                          <span className="legend-item"><span className="legend-dot legend-dot-correct" />Correct answer</span>
                          <span className="legend-item"><span className="legend-dot legend-dot-right" />Your pick · right</span>
                          <span className="legend-item"><span className="legend-dot legend-dot-wrong" />Your pick · wrong</span>
                        </div>
                      );

                      if (fmt === 'matrix' && Array.isArray(choices[0]?.options)) {
                        const headers = Array.isArray(choices[0]?.headers) ? choices[0].headers : [];
                        const colCount = headers.length || (choices[0]?.options?.length ?? 0);
                        return (
                          <div className="answer-matrix-wrap">
                            {Legend}
                            <div
                              className="answer-matrix-grid"
                              style={{ gridTemplateColumns: `minmax(0,1fr) repeat(${colCount}, minmax(80px, max-content))` }}
                            >
                              <div className="amg-corner" />
                              {Array.from({ length: colCount }).map((_, ci) => (
                                <div key={`h-${ci}`} className="amg-header">{headers[ci] || ''}</div>
                              ))}
                              {choices.map((row, ri) => (
                                <Fragment key={`r-${ri}`}>
                                  <div className="amg-row-label">
                                    <span className="amg-row-num">{ri + 1}</span>
                                    <span>{normalizeQuestionText(row?.text || row?.label || '') || '-'}</span>
                                  </div>
                                  {Array.from({ length: colCount }).map((_, ci) => {
                                    const opt = (row?.options || [])[ci] || {};
                                    const userPicked = !!opt.isUserSelected;
                                    const correct = !!opt.isCorrect;
                                    const cls = userPicked && correct ? 'cell-right'
                                      : userPicked ? 'cell-wrong'
                                      : correct ? 'cell-correct'
                                      : '';
                                    const sym = userPicked && correct ? '✓'
                                      : userPicked ? '✗'
                                      : correct ? '✓'
                                      : '';
                                    return <div key={`c-${ri}-${ci}`} className={`amg-cell ${cls}`}>{sym}</div>;
                                  })}
                                </Fragment>
                              ))}
                            </div>
                          </div>
                        );
                      }

                      if (fmt === 'dropdown') {
                        const correctParts = corrAns ? corrAns.split(/\s*,\s*/) : [];
                        return (
                          <div className="answer-blank-wrap">
                            {Legend}
                            <div className="answer-blank-list">
                              {choices.map((blank, bi) => {
                                const userText = String(blank?.text || '').trim();
                                const isPlaceholder = !userText || /^select\.\.\.?$/i.test(userText);
                                const correctText = (correctParts[bi] || '').trim();
                                const userIsRight = !isPlaceholder && correctText && userText === correctText;
                                return (
                                  <article key={`b-${bi}`} className="answer-blank-card">
                                    <header className="answer-blank-head">
                                      <strong>{blank?.label || `Blank ${bi + 1}`}</strong>
                                    </header>
                                    <div className="answer-blank-body">
                                      <div className={`answer-blank-cell ${userIsRight ? 'cell-right' : isPlaceholder ? 'cell-empty' : 'cell-wrong'}`}>
                                        <span className="answer-blank-meta">Your pick</span>
                                        <span className="answer-blank-text">{isPlaceholder ? '—' : userText}</span>
                                      </div>
                                      <div className={`answer-blank-cell ${userIsRight ? 'cell-right' : 'cell-correct'}`}>
                                        <span className="answer-blank-meta">Correct</span>
                                        <span className="answer-blank-text">{correctText || '—'}</span>
                                      </div>
                                    </div>
                                  </article>
                                );
                              })}
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div className="answer-choice-wrap">
                          {Legend}
                          <div className="answer-choice-list">
                            {choices.map((choice, index) => {
                              const label = String(choice?.label || String.fromCharCode(65 + index)).trim();
                              const text = normalizeQuestionText(choice?.text || '');
                              const isMine = anyMine
                                ? !!choice?.isUserSelected
                                : myAns.toUpperCase() === label.toUpperCase();
                              const isCorrect = anyCorrectFlagged
                                ? !!choice?.isCorrect
                                : corrAns.toUpperCase() === label.toUpperCase();
                              const variant = isMine && isCorrect ? 'mine correct'
                                : isMine ? 'mine wrong'
                                : isCorrect ? 'correct-only'
                                : '';
                              return (
                                <article key={`${label}-${index}`} className={`answer-choice-card ${variant}`}>
                                  <div className="answer-choice-head">
                                    <strong>{label}</strong>
                                    <div className="answer-choice-flags">
                                      {isMine && isCorrect && <span className="question-mini-chip success-chip">Your pick · Correct</span>}
                                      {isMine && !isCorrect && <span className="question-mini-chip">Your pick · Wrong</span>}
                                      {!isMine && isCorrect && <span className="question-mini-chip accent-chip">Correct answer</span>}
                                    </div>
                                  </div>
                                  <p>{text || '-'}</p>
                                </article>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()
                  ) : (
                    <p className="muted">No answer choices were scraped for this question.</p>
                  )}
                </div>

                <div className="question-review-section">
                  <h3>Study Notes</h3>
                  <div className="question-side-stack">
                    <div className="question-side-card">
                      <span className="question-side-label">Mistake Tags</span>
                      <div className="question-side-tags">
                        {parseMistakeTags(questionReview.row.mistake_type).length ? (
                          parseMistakeTags(questionReview.row.mistake_type).map((tag) => (
                            <span key={tag} className="mistake-tag-pill">{tag}</span>
                          ))
                        ) : (
                          <span className="muted">No tags yet</span>
                        )}
                      </div>
                    </div>
                    <div className="question-side-card">
                      <span className="question-side-label">Notes</span>
                      <p>{normalizeQuestionText(questionReview.row.notes) || 'No notes yet.'}</p>
                    </div>
                    <div className="question-side-card">
                      <span className="question-side-label">Actions</span>
                      <div className="question-side-actions">
                        <Button variant="outline" type="button" onClick={() => handleOpenAnnotation(questionReview.row)}>
                          Annotate
                        </Button>
                        {canonicalQuestionUrl(questionReview.row) ? (
                          <Button
                            variant="outline"
                            type="button"
                            onClick={() => handleOpenQuestionInGmat(questionReview.row, 'question-review-side')}
                            disabled={openingQuestionKey === questionOpenKey(questionReview.row, 'question-review-side')}
                          >
                            {openingQuestionKey === questionOpenKey(questionReview.row, 'question-review-side')
                              ? 'Opening...'
                              : 'Open in GMAT'}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}

      {annotation.open && (
        <div
          className="analysis-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Annotate Error"
          onClick={handleCloseAnnotation}
        >
          <div className="analysis-dialog note-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="analysis-shell">
              <div className="analysis-header">
                <h2>{`Annotate Question ${annotation.row?.q_code || annotation.row?.id || ''}`}</h2>
                <Button variant="outline" type="button" onClick={handleCloseAnnotation}>
                  Close
                </Button>
              </div>
              <div className="form-grid">
                <div className="mistake-tags-section">
                  <span className="mistake-tags-section-title">Mistake Tags</span>
                  {annotation.mistakeTags.length > 0 && (
                    <div className="mistake-tags-selected">
                      {annotation.mistakeTags.map((tag) => (
                        <span key={tag} className="mistake-tag-pill selected">
                          {tag}
                          <button
                            type="button"
                            className="mistake-tag-remove"
                            onClick={() => handleToggleMistakeTag(tag)}
                            aria-label={`Remove ${tag}`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {Object.entries(MISTAKE_TYPES).map(([category, tags]) => (
                    <div key={category} className="mistake-category">
                      <span className="mistake-category-label">{category}</span>
                      <div className="mistake-tags-grid">
                        {tags.map((tag) => (
                          <label key={tag} className="mistake-tag-checkbox">
                            <input
                              type="checkbox"
                              checked={annotation.mistakeTags.includes(tag)}
                              onChange={() => handleToggleMistakeTag(tag)}
                            />
                            {tag}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <label className="notes-label">
                  Notes
                  <Textarea
                    rows={6}
                    value={annotation.notes}
                    placeholder="Add your reasoning gap, trap pattern, or takeaway..."
                    onChange={(event) => setAnnotation((prev) => ({ ...prev, notes: event.target.value }))}
                  />
                </label>
              </div>
              {annotation.error && <p className="status error">{annotation.error}</p>}
              <div className="analysis-actions">
                <Button variant="outline" type="button" onClick={handleCloseAnnotation}>
                  Cancel
                </Button>
                <Button type="button" onClick={handleSaveAnnotation} disabled={annotation.saving}>
                  {annotation.saving ? 'Saving...' : 'Save Annotation'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
