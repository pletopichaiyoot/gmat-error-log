import { useEffect, useMemo, useState } from 'react';
import { Card } from './components/ui/card';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { Select } from './components/ui/select';

const DEFAULT_CDP_URL = 'http://localhost:9222';

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
  let data = null;
  try {
    data = await response.json();
  } catch (_error) {
    data = {};
  }

  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.hint = data.hint || '';
    error.details = data.details || '';
    error.debug = data.debug || null;
    throw error;
  }
  return data;
}

function formatRequestError(error) {
  const parts = [error?.message || 'Request failed', error?.hint || ''].filter(Boolean);
  return parts.join(' ');
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
    byTopic: [],
    bySubject: [],
    bySubjectTopic: [],
    byDifficulty: [],
    confidenceMismatch: [],
    subjectProgress: [],
    categoryBreakdown: [],
    subtopicBreakdown: [],
  });
  const [subtopicScope, setSubtopicScope] = useState('All');
  const [filters, setFilters] = useState({ subject: '', difficulty: '', topic: '', confidence: '', search: '' });
  const [syncCenterOpen, setSyncCenterOpen] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [isScraping, setIsScraping] = useState(false);
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
    mistakeType: '',
    notes: '',
  });
  const [openingQuestionKey, setOpeningQuestionKey] = useState('');
  const [sessionSubjectFilter, setSessionSubjectFilter] = useState('');
  const [sessionSort, setSessionSort] = useState({ key: 'session_date', order: 'desc' });
  const [sessionAnalysisSort, setSessionAnalysisSort] = useState({ key: 'time_sec', order: 'desc' });
  const [errorSort, setErrorSort] = useState({ key: 'session_date', order: 'desc' });
  const [sessionDateRange, setSessionDateRange] = useState({ start: '', end: '' });

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
          byTopic: patternsRes.byTopic || [],
          bySubject: patternsRes.bySubject || [],
          bySubjectTopic: patternsRes.bySubjectTopic || [],
          byDifficulty: patternsRes.byDifficulty || [],
          confidenceMismatch: patternsRes.confidenceMismatch || [],
          subjectProgress: patternsRes.subjectProgress || [],
          categoryBreakdown: patternsRes.categoryBreakdown || [],
          subtopicBreakdown: patternsRes.subtopicBreakdown || [],
        });
      })(),
    ]);
  }

  async function loadSessions(page, runId = selectedRunId) {
    const params = new URLSearchParams();
    if (runId) params.set('runId', runId);
    params.set('page', page);
    params.set('pageSize', sessionPagination.pageSize);
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
    params.set('sortKey', customSort.key);
    params.set('sortOrder', customSort.order);

    const data = await fetchJson(`/api/errors?${params.toString()}`);
    setErrors(Array.isArray(data.errors) ? data.errors : []);
    setErrorPagination({
      page: data.page,
      pageSize: data.pageSize,
      total: data.total,
      totalPages: data.totalPages,
    });
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
    if (!sessionAnalysis.open && !patternDrilldown.open && !syncCenterOpen && !annotation.open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [sessionAnalysis.open, patternDrilldown.open, syncCenterOpen, annotation.open]);

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
    await loadErrors(1, selectedRunId, customFilters);
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
      const family = row.subject_family || mapSubjectFamily(row.subject_sub);
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

    const order = ['Verbal', 'Quant', 'DI', 'Other'];
    return Array.from(groups.values())
      .sort((a, b) => order.indexOf(a.family) - order.indexOf(b.family))
      .map((group) => ({
        ...group,
        accuracy_pct: group.total ? Number(((group.correct * 100) / group.total).toFixed(1)) : 0,
        avg_time_sec: group.total ? Math.round(group.weightedTime / group.total) : 0,
        subs: group.subs.sort((a, b) => b.total - a.total),
      }));
  }, [patterns.subjectProgress]);

  const topicsForScope = useMemo(() => {
    const rows = patterns.bySubjectTopic || [];
    if (subtopicScope === 'All') return patterns.byTopic || [];

    const sameScopeRows =
      subtopicScope === 'Verbal' || subtopicScope === 'Quant' || subtopicScope === 'DI'
        ? rows.filter((row) => mapSubjectFamily(row.subject) === subtopicScope)
        : rows.filter((row) => row.subject === subtopicScope);

    const topicMap = new Map();
    for (const row of sameScopeRows) {
      const topic = row.topic || 'Unknown';
      topicMap.set(topic, (topicMap.get(topic) || 0) + Number(row.mistakes || 0));
    }

    return Array.from(topicMap.entries())
      .map(([topic, mistakes]) => ({ topic, mistakes }))
      .sort((a, b) => b.mistakes - a.mistakes || a.topic.localeCompare(b.topic));
  }, [patterns.bySubjectTopic, patterns.byTopic, subtopicScope]);

  const categoryRows = useMemo(() => patterns.categoryBreakdown || [], [patterns.categoryBreakdown]);

  const subtopicScopeOptions = useMemo(() => {
    const options = ['All'];
    for (const row of patterns.subtopicBreakdown || []) {
      const key = row.subject_family || 'Other';
      if (!options.includes(key)) options.push(key);
    }
    return options;
  }, [patterns.subtopicBreakdown]);

  const filteredSubtopicRows = useMemo(() => {
    const rows = patterns.subtopicBreakdown || [];
    if (subtopicScope === 'All') return rows;
    return rows.filter((row) => (row.subject_family || 'Other') === subtopicScope);
  }, [patterns.subtopicBreakdown, subtopicScope]);

  const overallMastery = useMemo(() => {
    const total = subjectCards.reduce((sum, card) => sum + Number(card.total || 0), 0);
    const correct = subjectCards.reduce((sum, card) => sum + Number(card.correct || 0), 0);
    if (!total) return 0;
    return Number(((correct * 100) / total).toFixed(1));
  }, [subjectCards]);

  const totalWrongTopicMistakes = useMemo(
    () =>
      (sessionAnalysis.data?.topWrongTopics || []).reduce(
        (sum, row) => sum + Number(row?.mistakes || 0),
        0
      ),
    [sessionAnalysis.data?.topWrongTopics]
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
      list = list.filter((s) => s.subject === sessionSubjectFilter);
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

  function statusLabelFromAccuracy(accuracyPct) {
    const score = Number(accuracyPct || 0);
    if (score >= 80) return 'Strong';
    if (score >= 65) return 'Improving';
    return 'Needs Focus';
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
      mistakeType: row.mistake_type || '',
      notes: row.notes || '',
    });
  }

  function handleCloseAnnotation() {
    setAnnotation({
      open: false,
      saving: false,
      error: '',
      row: null,
      mistakeType: '',
      notes: '',
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
          mistakeType: annotation.mistakeType,
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

  async function handleOpenQuestion(row, scope = '') {
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

  return (
    <main className="page-shell">
      <Card className="hero card">
        <p className="eyebrow">Local GMAT Analytics</p>
        <h1>Topic Breakdown Dashboard</h1>
        <p className="muted">
          Track Quant, Verbal, and Data Insights performance and review error patterns from synced GMAT practice.
        </p>
        <div className="hero-actions">
          <Button type="button" onClick={() => setSyncCenterOpen(true)}>
            Sync GMAT Practice
          </Button>
          <Button variant="outline" asChild>
            <a
              href="https://gmat.targettestprep.com/gmat_focus_score_chart_and_calculator"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Score Calculator
            </a>
          </Button>
          <p className={`status${status.isError ? ' error' : ''}`}>{status.message}</p>
        </div>
      </Card>

      <Card className="card topic-dashboard">
        <div className="topic-dashboard-head">
          <div>
            <p className="eyebrow">Performance Dashboard</p>
            <h2>Topic Breakdown</h2>
            <p className="muted">Performance across Quant, Verbal, and Data Insights modules.</p>
          </div>
        </div>

        <div className="topic-score-grid">
          {!subjectCards.length && <article className="topic-score-card muted">No subject data yet.</article>}
          {subjectCards.map((card) => {
            const accuracy = Math.max(0, Math.min(100, Number(card.accuracy_pct || 0)));
            const errorRate = Math.max(0, Number((100 - accuracy).toFixed(1)));
            return (
              <article key={card.family} className="topic-score-card">
                <span className="topic-chip">{card.family}</span>
                <strong className="topic-score">{formatPercent(accuracy)}</strong>
                <span className="topic-score-meta">{`${card.correct}/${card.total} correct · Avg ${formatDurationSeconds(card.avg_time_sec)}`}</span>
                <div className="topic-track">
                  <div className="topic-track-fill" style={{ width: `${accuracy}%` }} />
                </div>
                <span className="topic-score-meta">{`${errorRate}% error rate`}</span>
              </article>
            );
          })}
        </div>

        <div className="topic-insight-grid">
          <article className="topic-panel">
            <h3>Accuracy vs Error Rate</h3>
            <ul className="accuracy-rows">
              {!subjectCards.length && <li className="metric-empty">No data yet</li>}
              {subjectCards.map((card) => {
                const accuracy = Math.max(0, Math.min(100, Number(card.accuracy_pct || 0)));
                const errorRate = Math.max(0, Number((100 - accuracy).toFixed(1)));
                return (
                  <li key={`acc-${card.family}`}>
                    <div className="accuracy-label">
                      <span>{card.family}</span>
                      <strong>{`${formatPercent(accuracy)} / ${formatPercent(errorRate)}`}</strong>
                    </div>
                    <div className="accuracy-bar">
                      <div className="accuracy-fill" style={{ width: `${accuracy}%` }} />
                      <div className="error-fill" style={{ width: `${errorRate}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </article>

          <article className="topic-panel mastery-panel">
            <h3>Overall Mastery</h3>
            <div
              className="mastery-ring"
              style={{
                background: `conic-gradient(var(--accent) 0 ${overallMastery}%, rgba(61, 69, 65, 0.14) ${overallMastery}% 100%)`,
              }}
            >
              <div className="mastery-inner">
                <strong>{formatPercent(overallMastery)}</strong>
                <span>weighted</span>
              </div>
            </div>
            <div className="mastery-legend">
              {subjectCards.map((card) => (
                <div key={`m-${card.family}`}>
                  <span>{card.family}</span>
                  <strong>{formatPercent(card.accuracy_pct)}</strong>
                </div>
              ))}
            </div>
          </article>
        </div>

      </Card>

      <Card className="card">
        <h2>Category Detailed Breakdown</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                <th>Category</th>
                <th>Total Questions</th>
                <th>Correct</th>
                <th>Incorrect</th>
                <th>Accuracy</th>
                <th>Avg Time / Q</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {!categoryRows.length && (
                <tr>
                  <td colSpan="8">No category data yet.</td>
                </tr>
              )}
              {categoryRows.map((row) => (
                <tr key={`${row.subject_family}-${row.subject_sub}`}>
                  <td>{formatMaybe(row.subject_family)}</td>
                  <td>{formatMaybe(row.subject_sub)}</td>
                  <td>{formatMaybe(row.total_questions)}</td>
                  <td>{formatMaybe(row.correct_count)}</td>
                  <td>{formatMaybe(row.incorrect_count)}</td>
                  <td>{formatPercent(row.accuracy_pct)}</td>
                  <td>{formatDurationSeconds(row.avg_time_sec)}</td>
                  <td>
                    <Badge
                      variant={
                        statusLabelFromAccuracy(row.accuracy_pct) === 'Strong'
                          ? 'success'
                          : statusLabelFromAccuracy(row.accuracy_pct) === 'Improving'
                            ? 'info'
                            : 'warning'
                      }
                      className="status-pill"
                    >
                      {statusLabelFromAccuracy(row.accuracy_pct)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="card">
        <div className="section-header-filters">
          <h2>Subtopic Breakdown</h2>
          <Select className="filter-select" value={subtopicScope} onChange={(event) => setSubtopicScope(event.target.value)}>
            {subtopicScopeOptions.map((scope) => (
              <option key={scope} value={scope}>
                {scope}
              </option>
            ))}
          </Select>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                <th>Category</th>
                <th>Subtopic</th>
                <th>Incorrect</th>
                <th>Avg Time (Incorrect)</th>
              </tr>
            </thead>
            <tbody>
              {!filteredSubtopicRows.length && (
                <tr>
                  <td colSpan="5">No subtopic data yet.</td>
                </tr>
              )}
              {filteredSubtopicRows.map((row) => (
                <tr key={`${row.subject_family}-${row.subject_sub}-${row.subtopic}`}>
                  <td>{formatMaybe(row.subject_family)}</td>
                  <td>{formatMaybe(row.subject_sub)}</td>
                  <td>{formatMaybe(row.subtopic)}</td>
                  <td>{formatMaybe(row.incorrect_count)}</td>
                  <td>{formatDurationSeconds(row.avg_time_sec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="card">
        <div className="section-header-filters">
          <h2>Performance by Session</h2>
          <div className="filter-row session-filters">
            <Select
              className="filter-select"
              value={sessionSubjectFilter}
              onChange={(e) => setSessionSubjectFilter(e.target.value)}
            >
              <option value="">All Subjects</option>
              <option value="CR">CR</option>
              <option value="RC">RC</option>
              <option value="Verbal">Verbal</option>
              <option value="PS">PS</option>
              <option value="DS">DS</option>
              <option value="Quant">Quant</option>
              <option value="DI">DI</option>
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
            {(sessionSubjectFilter || sessionDateRange.start || sessionDateRange.end) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSessionSubjectFilter('');
                  setSessionDateRange({ start: '', end: '' });
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th
                  className="sortable"
                  onClick={() => handleSessionSort('session_date')}
                >
                  Date {sessionSort.key === 'session_date' && (sessionSort.order === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  className="sortable"
                  onClick={() => handleSessionSort('session_external_id')}
                >
                  Session ID {sessionSort.key === 'session_external_id' && (sessionSort.order === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  className="sortable"
                  onClick={() => handleSessionSort('subject')}
                >
                  Subject {sessionSort.key === 'subject' && (sessionSort.order === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  className="sortable"
                  onClick={() => handleSessionSort('question_count_display')}
                >
                  Questions {sessionSort.key === 'question_count_display' && (sessionSort.order === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  className="sortable"
                  onClick={() => handleSessionSort('error_count_display')}
                >
                  Errors {sessionSort.key === 'error_count_display' && (sessionSort.order === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  className="sortable"
                  onClick={() => handleSessionSort('answered_accuracy_pct')}
                >
                  Accuracy % {sessionSort.key === 'answered_accuracy_pct' && (sessionSort.order === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  className="sortable"
                  onClick={() => handleSessionSort('avg_time_sec')}
                >
                  Avg Time {sessionSort.key === 'avg_time_sec' && (sessionSort.order === 'asc' ? '↑' : '↓')}
                </th>
                <th>Hard (Q / Acc / Avg)</th>
                <th>Medium (Q / Acc / Avg)</th>
                <th>Easy (Q / Acc / Avg)</th>
                <th>Session Analysis</th>
              </tr>
            </thead>
            <tbody>
              {processedSessions.length === 0 && (
                <tr>
                  <td colSpan="11">No sessions found.</td>
                </tr>
              )}
              {processedSessions.map((row) => (
                <tr key={`${row.session_external_id}-${row.run_id}`}>
                  <td>{formatDate(row.session_date)}</td>
                  <td>{formatMaybe(row.session_external_id)}</td>
                  <td>{formatMaybe(row.subject)}</td>
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
      </Card>

      <Card className="card">
        <h2>Error Log</h2>
        <form className="filter-row" onSubmit={handleApplyFilter}>
            <Select
              value={filters.subject}
              onChange={(event) => setFilters((prev) => ({ ...prev, subject: event.target.value }))}
            >
              <option value="">All subjects</option>
              <option value="CR">CR</option>
              <option value="RC">RC</option>
              <option value="Verbal">Verbal</option>
              <option value="PS">PS</option>
              <option value="DS">DS</option>
              <option value="Quant">Quant</option>
              <option value="DI">DI</option>
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
              placeholder="Topic or Q Code (e.g. Weaken, V01234)"
              value={filters.search}
              onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
            />
            <Button variant="outline" type="submit">
              Apply Filter
            </Button>
        </form>

        <div className="table-wrap error-log-table-wrap">
          <table className="error-log-table">
            <thead>
              <tr>
                <th className="sortable" onClick={() => handleErrorSort('session_date')}>
                  Date {errorSort.key === 'session_date' && (errorSort.order === 'asc' ? '↑' : '↓')}
                </th>
                <th className="sortable" onClick={() => handleErrorSort('session_external_id')}>
                  Session {errorSort.key === 'session_external_id' && (errorSort.order === 'asc' ? '↑' : '↓')}
                </th>
                <th className="sortable" onClick={() => handleErrorSort('q_code')}>
                  Q Code {errorSort.key === 'q_code' && (errorSort.order === 'asc' ? '↑' : '↓')}
                </th>
                <th className="sortable" onClick={() => handleErrorSort('subject')}>
                  Subject {errorSort.key === 'subject' && (errorSort.order === 'asc' ? '↑' : '↓')}
                </th>
                <th className="sortable" onClick={() => handleErrorSort('difficulty')}>
                  Difficulty {errorSort.key === 'difficulty' && (errorSort.order === 'asc' ? '↑' : '↓')}
                </th>
                <th className="sortable topic-col" onClick={() => handleErrorSort('topic')}>
                  Topic {errorSort.key === 'topic' && (errorSort.order === 'asc' ? '↑' : '↓')}
                </th>
                <th>My Ans</th>
                <th>Correct</th>
                <th>Redo</th>
                <th className="sortable" onClick={() => handleErrorSort('time_sec')}>
                  Time (min:sec) {errorSort.key === 'time_sec' && (errorSort.order === 'asc' ? '↑' : '↓')}
                </th>
                <th className="sortable" onClick={() => handleErrorSort('mistake_type')}>
                  Mistake Type {errorSort.key === 'mistake_type' && (errorSort.order === 'asc' ? '↑' : '↓')}
                </th>
                <th className="notes-col">Notes</th>
                <th className="action-col annotate-col">Annotate</th>
                <th className="action-col open-col">Open</th>
              </tr>
            </thead>
            <tbody>
              {errors.length === 0 && (
                <tr>
                  <td colSpan="14">No error rows match this filter.</td>
                </tr>
              )}
              {errors.map((row) => (
                <tr key={row.id}>
                  <td>{formatDate(row.session_date)}</td>
                  <td>{formatMaybe(row.session_external_id)}</td>
                  <td>{formatMaybe(row.q_code)}</td>
                  <td>{formatMaybe(row.subject)}</td>
                  <td>{formatMaybe(row.difficulty)}</td>
                  <td className="topic-col">{formatMaybe(row.topic)}</td>
                  <td>{formatMaybe(row.my_answer)}</td>
                  <td>{formatMaybe(row.correct_answer)}</td>
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
                    {row.question_url ? (
                      <Button
                        variant="outline"
                        size="sm"
                        type="button"
                        className="readmore-btn"
                        onClick={() => handleOpenQuestion(row, 'error-log')}
                        disabled={openingQuestionKey === questionOpenKey(row, 'error-log')}
                      >
                        {openingQuestionKey === questionOpenKey(row, 'error-log') ? 'Opening...' : 'Open'}
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
                    <table>
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Session</th>
                          <th>Q Code</th>
                          <th>Subject</th>
                          <th>Difficulty</th>
                          <th>Topic</th>
                          <th>Confidence</th>
                          <th>My Ans</th>
                          <th>Correct</th>
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
                            <td>{formatMaybe(row.q_code)}</td>
                            <td>{formatMaybe(row.subject)}</td>
                            <td>{formatMaybe(row.difficulty)}</td>
                            <td>{formatMaybe(row.topic)}</td>
                            <td>{formatMaybe(row.confidence)}</td>
                            <td>{formatMaybe(row.my_answer)}</td>
                            <td>{formatMaybe(row.correct_answer)}</td>
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
                              {row.question_url ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  type="button"
                                  className="readmore-btn"
                                  onClick={() => handleOpenQuestion(row, 'drilldown')}
                                  disabled={openingQuestionKey === questionOpenKey(row, 'drilldown')}
                                >
                                  {openingQuestionKey === questionOpenKey(row, 'drilldown') ? 'Opening...' : 'Open'}
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
          className="analysis-overlay session-analysis-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Session Analysis"
          onClick={handleCloseSessionAnalysis}
        >
          <div className="analysis-dialog session-analysis-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="analysis-shell">
            <div className="analysis-header">
              <h2>Session Analysis</h2>
              <Button variant="outline" type="button" onClick={handleCloseSessionAnalysis}>
                Close
              </Button>
            </div>

            {sessionAnalysis.loading && <p className="muted">Loading session analysis...</p>}
            {sessionAnalysis.error && <p className="error">{sessionAnalysis.error}</p>}

            {!sessionAnalysis.loading && !sessionAnalysis.error && sessionAnalysis.data?.session && (
              <>
                <div className="summary-grid">
                  <div className="summary-item">
                    <span>Date</span>
                    <strong>{formatDate(sessionAnalysis.data.session.session_date)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Subject</span>
                    <strong>{formatMaybe(sessionAnalysis.data.session.subject)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Questions</span>
                    <strong>{formatMaybe(getSessionQuestionCount(sessionAnalysis.data.session))}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Unanswered</span>
                    <strong>{formatMaybe(getSessionUnansweredCount(sessionAnalysis.data.session))}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Answered Accuracy</span>
                    <strong>{formatPercent(getSessionAnsweredAccuracy(sessionAnalysis.data.session))}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Completion</span>
                    <strong>{formatPercent(getSessionCompletionRate(sessionAnalysis.data.session))}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Avg Time</span>
                    <strong>{formatDurationSeconds(sessionAnalysis.data.session.avg_time_sec)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Avg Correct Time</span>
                    <strong>{formatDurationSeconds(sessionAnalysis.data.session.avg_correct_time_sec)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Avg Incorrect Time</span>
                    <strong>{formatDurationSeconds(sessionAnalysis.data.session.avg_incorrect_time_sec)}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Session ID</span>
                    <strong>{formatMaybe(sessionAnalysis.data.session.session_external_id)}</strong>
                  </div>
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
                    <h3>Wrong Topics (All)</h3>
                    <ul className="metric-list">
                      {!sessionAnalysis.data.topWrongTopics?.length && <li className="metric-empty">No wrong-topic data</li>}
                      {(sessionAnalysis.data.topWrongTopics || []).map((row) => (
                        <li key={row.topic}>
                          <span className="metric-label">{row.topic}</span>
                          <span className="metric-values">
                            <strong>{row.mistakes}</strong>
                            <small>
                              {totalWrongTopicMistakes
                                ? `${((Number(row.mistakes || 0) * 100) / totalWrongTopicMistakes).toFixed(1)}%`
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
                    <table className="session-analysis-questions-table">
                      <thead>
                        <tr>
                          <th className="sortable" onClick={() => handleSessionAnalysisSort('q_code')}>
                            Q Code {sessionAnalysisSort.key === 'q_code' && (sessionAnalysisSort.order === 'asc' ? '↑' : '↓')}
                          </th>
                          <th className="sortable" onClick={() => handleSessionAnalysisSort('difficulty')}>
                            Difficulty {sessionAnalysisSort.key === 'difficulty' && (sessionAnalysisSort.order === 'asc' ? '↑' : '↓')}
                          </th>
                          <th className="sortable topic-col" onClick={() => handleSessionAnalysisSort('topic')}>
                            Topic {sessionAnalysisSort.key === 'topic' && (sessionAnalysisSort.order === 'asc' ? '↑' : '↓')}
                          </th>
                          <th className="sortable" onClick={() => handleSessionAnalysisSort('my_answer')}>
                            My Ans {sessionAnalysisSort.key === 'my_answer' && (sessionAnalysisSort.order === 'asc' ? '↑' : '↓')}
                          </th>
                          <th className="sortable" onClick={() => handleSessionAnalysisSort('correct_answer')}>
                            Correct {sessionAnalysisSort.key === 'correct_answer' && (sessionAnalysisSort.order === 'asc' ? '↑' : '↓')}
                          </th>
                          <th className="sortable" onClick={() => handleSessionAnalysisSort('time_sec')}>
                            Time {sessionAnalysisSort.key === 'time_sec' && (sessionAnalysisSort.order === 'asc' ? '↑' : '↓')}
                          </th>
                          <th className="sortable" onClick={() => handleSessionAnalysisSort('mistake_type')}>
                            Mistake Type {sessionAnalysisSort.key === 'mistake_type' && (sessionAnalysisSort.order === 'asc' ? '↑' : '↓')}
                          </th>
                          <th className="sortable notes-col" onClick={() => handleSessionAnalysisSort('notes')}>
                            Notes {sessionAnalysisSort.key === 'notes' && (sessionAnalysisSort.order === 'asc' ? '↑' : '↓')}
                          </th>
                          <th className="action-col annotate-col">Annotate</th>
                          <th className="action-col open-col">Open</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!sessionAnalysis.data.slowWrongQuestions?.length && (
                          <tr>
                            <td colSpan="10">No wrong questions found.</td>
                          </tr>
                        )}
                        {sortedSessionAnalysisWrongQuestions.map((row, idx) => (
                          <tr key={`${row.q_code || 'q'}-${idx}`}>
                            <td>{formatMaybe(row.q_code)}</td>
                            <td>{formatMaybe(row.difficulty)}</td>
                            <td className="topic-col">{formatMaybe(row.topic)}</td>
                            <td>{formatMaybe(row.my_answer)}</td>
                            <td>{formatMaybe(row.correct_answer)}</td>
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
                              {row.question_url ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  type="button"
                                  className="readmore-btn"
                                  onClick={() => handleOpenQuestion(row, 'session-analysis')}
                                  disabled={openingQuestionKey === questionOpenKey(row, 'session-analysis')}
                                >
                                  {openingQuestionKey === questionOpenKey(row, 'session-analysis')
                                    ? 'Opening...'
                                    : 'Open'}
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
                <label>
                  Mistake Type
                  <Select
                    value={annotation.mistakeType}
                    onChange={(event) => setAnnotation((prev) => ({ ...prev, mistakeType: event.target.value }))}
                  >
                    <option value="">Not set</option>
                    <option value="Conceptual Gap">Conceptual Gap</option>
                    <option value="Misread Question">Misread Question</option>
                    <option value="Misread Passage">Misread Passage</option>
                    <option value="Logic Breakdown">Logic Breakdown</option>
                    <option value="Careless Error">Careless Error</option>
                    <option value="Timing Pressure">Timing Pressure</option>
                    <option value="Bad Elimination">Bad Elimination</option>
                    <option value="Guess">Guess</option>
                  </Select>
                </label>
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
