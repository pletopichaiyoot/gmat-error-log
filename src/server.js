const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
require('dotenv').config();

const {
  dbPath,
  initDb,
  get: dbGet,
  saveScrapeResult,
  enrichSessionAttempts,
  enrichGmatClubSessionAttempts,
  listGmatClubEnrichTargets,
  listRuns,
  listSessions,
  countSessions,
  listErrors,
  countErrors,
  getPatterns,
  getSessionAnalysis,
  updateErrorAnnotation,
} = require('./db');
const { LlmConfigError, generatePerformanceReview, answerCoachQuestion } = require('./llm-coach-agent');
const { classifyScrapedQuestions } = require('./question-topic-classifier');
const {
  runScrapeFromOpenBrowser,
  openUrlInOpenBrowser,
  runStartTestScrapeFromOpenBrowser,
  runStartTestPhase2FromOpenBrowser,
  runGmatClubPhase2FromOpenBrowser,
  openStartTestProductInOpenBrowser,
} = require('./scraper-runner');
const {
  createSession: createCoachSession,
  getSession: getCoachSession,
  listSessions: listCoachSessions,
  addMessage: addCoachMessage,
  getMessages: getCoachMessages,
  updateSessionTitle: updateCoachSessionTitle,
  deleteSession: deleteCoachSession,
} = require('./coach-session');
const { isMemoryEnabled, getAllMemories, deleteMemory, deleteAllMemories } = require('./memory');

const app = express();
const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.HOST || '127.0.0.1';
const EXPOSE_INTERNAL_DEBUG = /^(1|true|yes)$/i.test(String(process.env.EXPOSE_INTERNAL_DEBUG || '').trim());
const ALLOW_REMOTE_CDP = /^(1|true|yes)$/i.test(String(process.env.ALLOW_REMOTE_CDP || '').trim());
const clientDistPath = path.resolve(__dirname, '..', 'client', 'dist');
const THAI_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
const THAI_TIME_ZONE = 'Asia/Bangkok';
const TODAY_SAFETY_BUFFER_HOURS = Math.max(
  0,
  Number.isFinite(Number(process.env.SCRAPE_TODAY_BUFFER_HOURS))
    ? Number(process.env.SCRAPE_TODAY_BUFFER_HOURS)
    : 36
);
const ONE_HOUR_MS = 60 * 60 * 1000;

// Source presets — seven GMAT Official Practice books (platform: 'starttest')
// and one legacy GMAT Club forum scraper (platform: 'gmatclub'). After the
// 2026-04-22 migration, the mba.com/app/... URLs are dead; the user now lands
// on StartTest 2 via the mba.com login flow. The `appUrl` for starttest sources
// is the mba.com login entry so the /api/open-chrome launcher still works; the
// scraper itself navigates inside the already-logged-in tab via CDP.
const STARTTEST_ENTRY_URL = 'https://www.mba.com/my-account';
const SOURCE_PRESETS = [
  {
    id: 'og-main-2024-2025',
    label: 'GMAT™ Official Guide 2024-2025',
    platform: 'starttest',
    productId: 1373434,
    productName: 'GMAT™ Official Guide 2024-2025',
    appUrl: STARTTEST_ENTRY_URL,
    tabPattern: 'starttest\\.com',
    defaultSince: '20260101000000',
  },
  {
    id: 'og-verbal-review-2024-2025',
    label: 'GMAT™ Official Guide 2024-2025 - Verbal',
    platform: 'starttest',
    productId: 1554373,
    productName: 'GMAT™ Official Guide 2024-2025 - Verbal',
    appUrl: STARTTEST_ENTRY_URL,
    tabPattern: 'starttest\\.com',
    defaultSince: '20260101000000',
  },
  {
    id: 'og-quantitative-review-2024-2025',
    label: 'GMAT™ Official Guide 2024-2025 - Quantitative',
    platform: 'starttest',
    productId: 1519887,
    productName: 'GMAT™ Official Guide 2024-2025 - Quantitative',
    appUrl: STARTTEST_ENTRY_URL,
    tabPattern: 'starttest\\.com',
    defaultSince: '20260101000000',
  },
  {
    id: 'og-data-insights-review-2024-2025',
    label: 'GMAT™ Official Guide 2024-2025 - Data Insights',
    platform: 'starttest',
    productId: 1452568,
    productName: 'GMAT™ Official Guide 2024-2025 - Data Insights',
    appUrl: STARTTEST_ENTRY_URL,
    tabPattern: 'starttest\\.com',
    defaultSince: '20260101000000',
  },
  {
    id: 'focus-quant-practice',
    label: 'GMAT™ Official Practice - Quantitative',
    platform: 'starttest',
    productId: 1213806,
    productName: 'GMAT™ Official Practice - Quantitative',
    appUrl: STARTTEST_ENTRY_URL,
    tabPattern: 'starttest\\.com',
    defaultSince: '20260101000000',
  },
  {
    id: 'focus-verbal-practice',
    label: 'GMAT™ Official Practice - Verbal',
    platform: 'starttest',
    productId: 1213807,
    productName: 'GMAT™ Official Practice - Verbal',
    appUrl: STARTTEST_ENTRY_URL,
    tabPattern: 'starttest\\.com',
    defaultSince: '20260101000000',
  },
  {
    id: 'focus-data-insights-practice',
    label: 'GMAT™ Official Practice - Data Insights',
    platform: 'starttest',
    productId: 1213805,
    productName: 'GMAT™ Official Practice - Data Insights',
    appUrl: STARTTEST_ENTRY_URL,
    tabPattern: 'starttest\\.com',
    defaultSince: '20260101000000',
  },
  {
    id: 'gmat-club-error-log',
    label: 'GMAT Club Error Log',
    platform: 'gmatclub',
    appUrl: 'https://gmatclub.com/forum/analytics.php#error_log',
    clientId: null,
    reviewCategoryId: null,
    defaultSince: '20250101000000',
    scraperFile: 'gmat_club_scraper.js',
    tabPattern: 'gmatclub\\.com',
  },
];

function normalizeSourceKey(rawSource) {
  return String(rawSource || '')
    .trim()
    .toLowerCase();
}

function resolveSourcePreset(rawSource) {
  const key = normalizeSourceKey(rawSource);
  if (!key) return SOURCE_PRESETS[0];
  return (
    SOURCE_PRESETS.find(
      (preset) => normalizeSourceKey(preset.id) === key || normalizeSourceKey(preset.label) === key
    ) || null
  );
}

function thaiDateParts(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const thaiDate = new Date(date.getTime() + THAI_UTC_OFFSET_MS);
  return {
    yyyy: thaiDate.getUTCFullYear(),
    mm: thaiDate.getUTCMonth() + 1,
    dd: thaiDate.getUTCDate(),
    hh: thaiDate.getUTCHours(),
    min: thaiDate.getUTCMinutes(),
    sec: thaiDate.getUTCSeconds(),
  };
}

function toSinceThai(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const parts = thaiDateParts(date);
  if (!parts) return null;
  const yyyy = parts.yyyy;
  const mm = String(parts.mm).padStart(2, '0');
  const dd = String(parts.dd).padStart(2, '0');
  const hh = String(parts.hh).padStart(2, '0');
  const min = String(parts.min).padStart(2, '0');
  const sec = String(parts.sec).padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}${min}${sec}`;
}

function thaiMidnight(date = new Date()) {
  const parts = thaiDateParts(date);
  if (!parts) return null;
  return new Date(Date.UTC(parts.yyyy, parts.mm - 1, parts.dd, 0, 0, 0) - THAI_UTC_OFFSET_MS);
}

function parseThaiDateTimeString(value) {
  const input = String(value || '').trim();
  const match = input.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!match) return null;
  const [, yyyy, mm, dd, hh = '00', min = '00', sec = '00'] = match;
  return `${yyyy}${mm}${dd}${hh}${min}${sec}`;
}

function parseCustomSince(rawValue) {
  if (!rawValue) return null;
  const str = String(rawValue).trim();
  if (!str) return null;
  if (/^\d{14}$/.test(str)) return str;
  const parsedThaiLiteral = parseThaiDateTimeString(str);
  if (parsedThaiLiteral) return parsedThaiLiteral;
  const date = new Date(str);
  return toSinceThai(date);
}

function resolveSinceFromWindow({ windowKey, customSince, fullDefaultSince }) {
  const key = String(windowKey || 'today').toLowerCase();

  if (key === 'full') return fullDefaultSince;
  if (key === 'custom') return parseCustomSince(customSince) || fullDefaultSince;

  const start = thaiMidnight(new Date());
  if (!start) return fullDefaultSince;

  if (key === 'last3') {
    return toSinceThai(new Date(start.getTime() - 3 * 24 * 60 * 60 * 1000));
  }
  if (key === 'last7') {
    return toSinceThai(new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000));
  }

  // "today" uses a safety buffer to avoid missing fresh sessions due to
  // timestamp skew or delayed activity writes on the source side.
  return toSinceThai(new Date(start.getTime() - TODAY_SAFETY_BUFFER_HOURS * ONE_HOUR_MS));
}

function chromeBinaryPath() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];
  const match = candidates.find((candidate) => require('fs').existsSync(candidate));
  return match || null;
}

function clipText(value, maxLen = 3000) {
  const text = String(value || '');
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

function parseHttpUrlSafe(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return null;
  try {
    return new URL(value);
  } catch (_error) {
    try {
      return new URL(`http://${value}`);
    } catch (_innerError) {
      return null;
    }
  }
}

function isLoopbackHostname(rawHost) {
  const host = String(rawHost || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function normalizeCdpUrl(rawUrl) {
  if (!rawUrl) return '';
  const parsed = parseHttpUrlSafe(rawUrl);
  if (!parsed || !/^https?:$/i.test(parsed.protocol)) return '';
  return parsed.toString();
}

function getValidatedCdpUrl(rawUrl) {
  const normalized = normalizeCdpUrl(rawUrl);
  if (!normalized) return '';
  const parsed = new URL(normalized);
  if (!ALLOW_REMOTE_CDP && !isLoopbackHostname(parsed.hostname)) {
    const error = new Error('Remote CDP hosts are blocked. Use localhost/127.0.0.1/::1 or set ALLOW_REMOTE_CDP=true.');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function withOptionalDebug(response, { details = '', debug = null } = {}) {
  if (EXPOSE_INTERNAL_DEBUG) {
    if (details) response.details = details;
    if (debug) response.debug = debug;
  }
  return response;
}

function normalizeOpenUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return `https://gmatofficialpractice.mba.com${value}`;
  return null;
}

function parseOptionalRunId(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  const runId = Number(rawValue);
  if (!Number.isInteger(runId) || runId <= 0) return null;
  return runId;
}

app.use(express.json({ limit: '1mb' }));
if (require('fs').existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, dbPath });
});

app.get('/api/runs', async (req, res) => {
  try {
    const limit = Number(req.query.limit || 20);
    const rows = await listRuns(limit);
    res.json({ runs: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sources', (req, res) => {
  res.json({
    sources: SOURCE_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      appUrl: preset.appUrl,
      platform: preset.platform || 'legacy',
      productName: preset.productName || null,
    })),
  });
});

app.get('/api/sessions', async (req, res) => {
  try {
    const runId = req.query.runId ? Number(req.query.runId) : null;
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20)));
    const offset = (page - 1) * pageSize;
    const platform = ['gmatclub', 'starttest'].includes(req.query.platform) ? req.query.platform : null;

    const [rows, total] = await Promise.all([
      listSessions(runId, { limit: pageSize, offset, platform }),
      countSessions(runId, { platform }),
    ]);

    res.json({
      sessions: rows,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions/:sessionId/analysis', async (req, res) => {
  try {
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      res.status(400).json({ error: 'Invalid session id.' });
      return;
    }

    const analysis = await getSessionAnalysis(sessionId);
    if (!analysis) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }

    res.json({ analysis });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/errors', async (req, res) => {
  try {
    const runId = req.query.runId ? Number(req.query.runId) : null;
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20)));
    const offset = (page - 1) * pageSize;

    const filterOptions = {
      runId,
      subject: req.query.subject || '',
      difficulty: req.query.difficulty || '',
      topic: req.query.topic || '',
      confidence: req.query.confidence || '',
      search: req.query.search || '',
      mistakeTag: req.query.mistakeTag || '',
      platform: ['gmatclub', 'starttest'].includes(req.query.platform) ? req.query.platform : null,
      sortKey: req.query.sortKey || 'session_date',
      sortOrder: req.query.sortOrder === 'asc' ? 'asc' : 'desc',
    };

    const [rows, total] = await Promise.all([
      listErrors({ ...filterOptions, limit: pageSize, offset }),
      countErrors(filterOptions),
    ]);

    res.json({
      errors: rows,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/patterns', async (req, res) => {
  try {
    const runId = req.query.runId ? Number(req.query.runId) : null;
    const patterns = await getPatterns(runId);
    res.json(patterns);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ai/review', async (req, res) => {
  try {
    const runIdRaw = req.body?.runId;
    const runId =
      runIdRaw === null || runIdRaw === undefined || runIdRaw === ''
        ? null
        : parseOptionalRunId(runIdRaw);
    if (runIdRaw !== null && runIdRaw !== undefined && runIdRaw !== '' && runId === null) {
      res.status(400).json({ error: 'Invalid run id.' });
      return;
    }

    const focus = String(req.body?.focus || '').trim();
    const sessionId = String(req.body?.sessionId || '').trim() || null;
    const result = await generatePerformanceReview({ runId, focus, sessionId });

    res.json({
      ok: true,
      review: result.text,
      contextMeta: result.contextMeta || null,
    });
  } catch (error) {
    if (error instanceof LlmConfigError || Number.isInteger(error?.statusCode)) {
      res.status(Number(error.statusCode || 400)).json({
        error: error.message,
        hint: error.hint || '',
      });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ai/chat', async (req, res) => {
  try {
    const runIdRaw = req.body?.runId;
    const runId =
      runIdRaw === null || runIdRaw === undefined || runIdRaw === ''
        ? null
        : parseOptionalRunId(runIdRaw);
    if (runIdRaw !== null && runIdRaw !== undefined && runIdRaw !== '' && runId === null) {
      res.status(400).json({ error: 'Invalid run id.' });
      return;
    }

    const question = String(req.body?.question || '').trim();
    if (!question) {
      res.status(400).json({ error: 'Question is required.' });
      return;
    }

    let sessionId = String(req.body?.sessionId || '').trim() || null;

    // Auto-create session if none provided
    if (!sessionId) {
      const session = await createCoachSession({ runId });
      sessionId = session.id;
    }

    // Save user message
    await addCoachMessage(sessionId, { role: 'user', content: question });

    const result = await answerCoachQuestion({ runId, question, sessionId });

    // Save assistant response
    await addCoachMessage(sessionId, { role: 'assistant', content: result.text });

    // Auto-title: set title from first user question if session has no title yet
    const session = await getCoachSession(sessionId);
    if (session && !session.title) {
      const title = question.length > 80 ? question.slice(0, 77) + '...' : question;
      await updateCoachSessionTitle(sessionId, title);
    }

    res.json({
      ok: true,
      answer: result.text,
      sessionId,
      contextMeta: result.contextMeta || null,
    });
  } catch (error) {
    if (error instanceof LlmConfigError || Number.isInteger(error?.statusCode)) {
      res.status(Number(error.statusCode || 400)).json({
        error: error.message,
        hint: error.hint || '',
      });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

// --- Coach session endpoints ---

app.post('/api/ai/sessions', async (req, res) => {
  try {
    const runId = req.body?.runId != null ? Number(req.body.runId) || null : null;
    const session = await createCoachSession({ runId });
    res.json({ ok: true, session });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ai/sessions', async (req, res) => {
  try {
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 20), 100);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const sessions = await listCoachSessions({ limit, offset });
    res.json({ ok: true, sessions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ai/sessions/:id', async (req, res) => {
  try {
    const session = await getCoachSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    const messages = await getCoachMessages(req.params.id);
    res.json({ ok: true, session, messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/ai/sessions/:id', async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim();
    const updated = await updateCoachSessionTitle(req.params.id, title);
    if (!updated) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/ai/sessions/:id', async (req, res) => {
  try {
    const deleted = await deleteCoachSession(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Memory management endpoints ---

app.get('/api/ai/memories', async (req, res) => {
  try {
    if (!isMemoryEnabled()) {
      return res.json({ ok: true, enabled: false, memories: [] });
    }
    const memories = await getAllMemories();
    res.json({ ok: true, enabled: true, memories });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/ai/memories', async (req, res) => {
  try {
    const deleted = await deleteAllMemories();
    res.json({ ok: deleted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/ai/memories/:id', async (req, res) => {
  try {
    const memoryId = req.params.id;
    if (!memoryId) {
      return res.status(400).json({ error: 'Memory ID is required.' });
    }
    const deleted = await deleteMemory(memoryId);
    res.json({ ok: deleted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/errors/:errorId', async (req, res) => {
  try {
    const errorId = Number(req.params.errorId);
    if (!Number.isInteger(errorId) || errorId <= 0) {
      res.status(400).json({ error: 'Invalid error id.' });
      return;
    }

    const mistakeType = req.body?.mistakeType;
    const notes = req.body?.notes;

    const updated = await updateErrorAnnotation(errorId, {
      mistakeType: typeof mistakeType === 'string' ? mistakeType : '',
      notes: typeof notes === 'string' ? notes : '',
    });

    if (!updated) {
      res.status(404).json({ error: 'Question attempt not found.' });
      return;
    }

    res.json({ ok: true, error: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function cdpPortFromUrl(rawUrl) {
  if (!rawUrl) return 9222;
  try {
    const parsed = new URL(String(rawUrl));
    const port = Number(parsed.port || 9222);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 9222;
    return port;
  } catch (_error) {
    return 9222;
  }
}

app.post('/api/open-chrome', async (req, res) => {
  try {
    if (process.platform !== 'darwin') {
      res.status(400).json({
        ok: false,
        error: 'Automatic Chrome launch is currently implemented for macOS only.',
      });
      return;
    }

    const validatedCdpUrl = getValidatedCdpUrl(req.body?.cdpUrl);
    const port = cdpPortFromUrl(validatedCdpUrl || req.body?.cdpUrl);
    const sourcePreset = resolveSourcePreset(req.body?.source);
    if (!sourcePreset) {
      res.status(400).json({
        ok: false,
        error: 'Unknown source. Please choose a source from the dropdown.',
      });
      return;
    }

    const profileDir = path.resolve(__dirname, '..', 'data', 'chrome-cdp-profile');
    const chromePath = chromeBinaryPath();
    let child = null;
    if (chromePath) {
      child = spawn(
        chromePath,
        [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profileDir}`,
          '--new-window',
          sourcePreset.appUrl,
        ],
        {
          detached: true,
          stdio: 'ignore',
        }
      );
    } else {
      child = spawn(
        'open',
        [
          '-na',
          'Google Chrome',
          '--args',
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profileDir}`,
          sourcePreset.appUrl,
        ],
        {
          detached: true,
          stdio: 'ignore',
        }
      );
    }

    child.unref();

    res.json({
      ok: true,
      port,
      source: sourcePreset.label,
      appUrl: sourcePreset.appUrl,
      ...(EXPOSE_INTERNAL_DEBUG ? { profileDir } : {}),
      message: 'Chrome launch command sent.',
    });
  } catch (error) {
    res.status(Number(error.statusCode || 500)).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post('/api/open-question', async (req, res) => {
  try {
    const targetUrl = normalizeOpenUrl(req.body?.questionUrl);
    if (!targetUrl) {
      res.status(400).json({
        ok: false,
        error: 'Invalid question URL. Expected absolute GMAT URL.',
      });
      return;
    }

    const cdpUrl = getValidatedCdpUrl(req.body?.cdpUrl);
    const rawSource = String(req.body?.source || '').trim();
    const sourcePreset = rawSource ? resolveSourcePreset(rawSource) : null;
    const result = await openUrlInOpenBrowser({
      cdpUrl,
      url: targetUrl,
      appUrl: sourcePreset?.appUrl || '',
    });

    res.json(withOptionalDebug({
      ok: true,
      openedUrl: result.openedUrl,
    }, {
      debug: result.debug || null,
    }));
  } catch (error) {
    res.status(Number(error.statusCode || 500)).json(withOptionalDebug({
      ok: false,
      error: error.message,
      hint: 'Open Chrome (CDP) first, keep GMAT tab logged in, then try Open again.',
    }, {
      details: clipText(error.stack || error.message || String(error), 4000),
      debug: error.openDebug || null,
    }));
  }
});

// Phase 2 endpoint: deep-enrich a single practice session. Takes the DB session
// id (sessions.id), looks up its session_external_id + source, and runs the
// per-item iframe loop in the user's logged-in CDP tab. Long-running (~3–5
// minutes for a 20-question session). Each item adds ~5–8 s for the outer
// page load + 3–6 s of human-like jitter. Aborts on any anomaly.
app.post('/api/sessions/:sessionId/enrich', async (req, res) => {
  try {
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      res.status(400).json({ ok: false, error: 'Invalid session id.' });
      return;
    }
    const validatedCdpUrl = getValidatedCdpUrl(req.body?.cdpUrl);
    const sessionRow = await dbGet(
      `
        SELECT s.id, s.session_external_id, s.source, s.total_q_api
        FROM sessions s
        WHERE s.id = ?
      `,
      [sessionId]
    );
    if (!sessionRow) {
      res.status(404).json({ ok: false, error: 'Session not found.' });
      return;
    }
    const preset = resolveSourcePreset(sessionRow.source);
    if (!preset) {
      res.status(400).json({
        ok: false,
        error: `Unknown source "${sessionRow.source}".`,
      });
      return;
    }

    let phase2;
    let dbResult;
    if (preset.platform === 'starttest') {
      phase2 = await runStartTestPhase2FromOpenBrowser({
        cdpUrl: validatedCdpUrl,
        sourceId: preset.id,
        sid: String(sessionRow.session_external_id),
        totalQ: Number(sessionRow.total_q_api) || 0,
      });
      dbResult = await enrichSessionAttempts({
        sessionExternalId: sessionRow.session_external_id,
        source: sessionRow.source,
        enrichedItems: phase2.result?.items || [],
      });
    } else if (preset.platform === 'gmatclub') {
      const targets = await listGmatClubEnrichTargets(sessionRow.id);
      if (!targets.length) {
        res.status(400).json({
          ok: false,
          error: 'No questions in this session have a question_url to enrich.',
        });
        return;
      }
      phase2 = await runGmatClubPhase2FromOpenBrowser({
        cdpUrl: validatedCdpUrl,
        targets: targets.map((t) => ({ q_id: t.q_id, q_code: t.q_code, url: t.question_url })),
      });
      dbResult = await enrichGmatClubSessionAttempts({
        sessionExternalId: sessionRow.session_external_id,
        source: sessionRow.source,
        enrichedItems: phase2.result?.items || [],
      });
    } else {
      res.status(400).json({
        ok: false,
        error: `Phase 2 enrichment is not supported for platform "${preset.platform}".`,
      });
      return;
    }

    res.json(withOptionalDebug({
      ok: true,
      sessionId,
      sessionExternalId: sessionRow.session_external_id,
      source: sessionRow.source,
      qhTotal: phase2.result?.qhTotal || 0,
      enrichedCount: phase2.result?.items?.length || 0,
      dbUpdated: dbResult.updated,
      dbSkipped: dbResult.skipped,
      dbErrors: dbResult.errors,
      scrapeErrors: phase2.result?.errors || [],
      aborted: !!phase2.result?.aborted,
      abortReason: phase2.result?.abortReason || null,
      warning: phase2.result?.aborted
        ? `Phase 2 aborted at item ${phase2.result.items.length}/${phase2.result.qhTotal}: ${phase2.result.abortReason}. Items already enriched were saved.`
        : '',
    }, {
      debug: phase2.debug || null,
    }));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[api/sessions/:sessionId/enrich] failed', error);
    res.status(Number(error.statusCode || 500)).json(withOptionalDebug({
      ok: false,
      error: error.message,
      hint: 'Confirm the GMAT tab is on the matching product home before triggering. Phase 2 aborts on any anomaly so partial DB writes are still applied for items completed.',
    }, {
      details: clipText(error.stack || error.message || String(error), 4000),
      debug: error.scrapeDebug || null,
    }));
  }
});

// Helper: lets the web app "open" a specific StartTest product in the user's
// logged-in Chrome tab via CDP. Under the hood this calls `navigateToProduct`
// in the starttest scraper (Home → click product link). Used so the user can
// click one button to switch products instead of finding it in the tab menu.
app.post('/api/open-product', async (req, res) => {
  try {
    const { source, cdpUrl } = req.body || {};
    const validatedCdpUrl = getValidatedCdpUrl(cdpUrl);
    const preset = resolveSourcePreset(source);
    if (!preset) {
      res.status(400).json({ ok: false, error: 'Unknown source. Please choose a source from the dropdown.' });
      return;
    }
    if (preset.platform !== 'starttest') {
      res.status(400).json({
        ok: false,
        error: `Source "${preset.label}" is not a StartTest product — nothing to open via /api/open-product.`,
      });
      return;
    }
    const result = await openStartTestProductInOpenBrowser({
      sourceId: preset.id,
      cdpUrl: validatedCdpUrl,
    });
    res.json(withOptionalDebug({
      ok: true,
      source: preset.label,
      expectedHeading: result.expectedHeading,
      activeHeading: result.activeHeading,
      matches: result.matches,
      tabUrl: result.tabUrl,
    }, {
      debug: result.debug || null,
    }));
  } catch (error) {
    res.status(Number(error.statusCode || 500)).json(withOptionalDebug({
      ok: false,
      error: error.message,
      hint: 'Confirm your Chrome tab is on starttest.com (signed in via mba.com first). If it is, try again; otherwise re-login.',
    }, {
      details: clipText(error.stack || error.message || String(error), 4000),
      debug: error.openDebug || null,
    }));
  }
});

app.post('/api/scrape', async (req, res) => {
  try {
    const { source, cdpUrl, scrapeWindow, customSince } = req.body || {};
    const validatedCdpUrl = getValidatedCdpUrl(cdpUrl);
    const preset = resolveSourcePreset(source);
    if (!preset) {
      res.status(400).json({
        ok: false,
        error: 'Unknown source. Please choose a source from the dropdown.',
      });
      return;
    }

    const sinceValue = resolveSinceFromWindow({
      windowKey: scrapeWindow,
      customSince,
      fullDefaultSince: preset.defaultSince,
    });

    // Route to the StartTest 2 scraper for starttest sources (the seven GMAT
    // Official Practice books post-2026-04-22 migration). Fall back to the
    // legacy injected-script flow for the remaining gmatclub source.
    let data, tabUrl, debug;
    if (preset.platform === 'starttest') {
      const result = await runStartTestScrapeFromOpenBrowser({
        sourceId: preset.id,
        since: sinceValue,
        cdpUrl: validatedCdpUrl,
      });
      data = result.data;
      tabUrl = result.tabUrl;
      debug = result.debug;
    } else {
      const isCustomScraper = !!preset.scraperFile;
      const result = await runScrapeFromOpenBrowser({
        since: sinceValue,
        clientId: preset.clientId,
        autoDetectClientId: !isCustomScraper,
        reviewCategoryId: preset.reviewCategoryId,
        autoDetectReviewCategoryId: !preset.reviewCategoryId && !isCustomScraper,
        source: preset.label,
        appUrl: preset.appUrl,
        cdpUrl: validatedCdpUrl,
        scraperPath: path.resolve(__dirname, 'scrapers', preset.scraperFile || 'gmat_scraper.js'),
        tabPattern: preset.tabPattern || null,
      });
      data = result.data;
      tabUrl = result.tabUrl;
      debug = result.debug;
    }

    let classification = null;
    try {
      classification = await classifyScrapedQuestions(data);
    } catch (error) {
      classification = {
        attempted: 0,
        classified: 0,
        skipped: true,
        reason: 'llm_unavailable',
        error: error.message,
        hint: error.hint || '',
      };
      // eslint-disable-next-line no-console
      console.warn('[api/scrape] question classification skipped', {
        error: error.message,
        hint: error.hint || '',
      });
    }
    data.classification = classification;

    const savedRun = await saveScrapeResult(data, {
      since: sinceValue,
      source: preset.label,
      reviewCategoryId: preset.reviewCategoryId,
    });

    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    const hasNoSessions = sessions.length === 0;
    const warning = hasNoSessions
      ? 'Scrape completed but extracted 0 sessions. Check source tab, date window, and debug logs below.'
      : '';

    res.json(withOptionalDebug({
      ok: true,
      tabUrl,
      run: savedRun,
      source: preset.label,
      sinceUsed: sinceValue,
      sinceTimezone: THAI_TIME_ZONE,
      scrapeWindowUsed: String(scrapeWindow || 'today').toLowerCase(),
      mode: 'auto-upsert',
      classification,
      warning,
    }, {
      debug: debug || null,
    }));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[api/scrape] failed', error);
    res.status(Number(error.statusCode || 500)).json(withOptionalDebug({
      ok: false,
      error: error.message,
      hint: 'Confirm Chrome is running with --remote-debugging-port=9222 and GMAT tab is open + logged in.',
    }, {
      details: clipText(error.stack || error.message || String(error), 4000),
      debug: error.scrapeDebug || null,
    }));
  }
});

app.get('*', (req, res) => {
  if (require('fs').existsSync(path.join(clientDistPath, 'index.html'))) {
    res.sendFile(path.join(clientDistPath, 'index.html'));
    return;
  }

  res.status(404).json({
    error: 'Frontend not built. Run "npm run dev" for local development or "npm run build:web".',
  });
});

async function start() {
  await initDb();
  app.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`GMAT Error Log app running on http://${HOST}:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`Database: ${dbPath}`);
  });
}

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', error);
  process.exit(1);
});
