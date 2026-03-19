const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
require('dotenv').config();

const {
  dbPath,
  initDb,
  saveScrapeResult,
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
const { runScrapeFromOpenBrowser, openUrlInOpenBrowser } = require('./scraper-runner');

const app = express();
const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.HOST || '127.0.0.1';
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

const SOURCE_PRESETS = [
  {
    id: 'og-verbal-review-2024-2025',
    label: 'OG Verbal Review 2024-2025',
    appUrl:
      'https://gmatofficialpractice.mba.com/app/gmat-official-guide-2024-2025-verbal-review-online-question-bank',
    clientId: 789329902,
    reviewCategoryId: 1337003,
    defaultSince: '20260101000000',
  },
  {
    id: 'og-quantitative-review-2024-2025',
    label: 'OG Quantitative Review 2024-2025',
    appUrl:
      'https://gmatofficialpractice.mba.com/app/gmat-official-guide-2024-2025-quantitative-review-online-question-bank',
    clientId: 640835702,
    reviewCategoryId: null,
    defaultSince: '20250101000000',
  },
  {
    id: 'og-data-insights-review-2024-2025',
    label: 'OG Data Insights Review 2024-2025',
    appUrl:
      'https://gmatofficialpractice.mba.com/app/gmat-official-guide-2024-2025-data-insights-review-online-question-bank',
    clientId: 789329902,
    reviewCategoryId: null,
    defaultSince: '20250101000000',
  },
  {
    id: 'og-main-2024-2025',
    label: 'OG Main 2024-2025',
    appUrl:
      'https://gmatofficialpractice.mba.com/app/gmat-official-guide-2024-2025-online-question-bank',
    clientId: 789329902,
    reviewCategoryId: null,
    defaultSince: '20250101000000',
  },
  {
    id: 'focus-quant-practice',
    label: 'GMAT Focus Quantitative Practice',
    appUrl: 'https://gmatofficialpractice.mba.com/app/gmat-focus-official-practice-questions-quantitative',
    clientId: 789329902,
    reviewCategoryId: null,
    defaultSince: '20250101000000',
  },
  {
    id: 'focus-verbal-practice',
    label: 'GMAT Focus Verbal Practice',
    appUrl: 'https://gmatofficialpractice.mba.com/app/gmat-focus-official-practice-questions-verbal',
    clientId: 789329902,
    reviewCategoryId: null,
    defaultSince: '20250101000000',
  },
  {
    id: 'focus-data-insights-practice',
    label: 'GMAT Focus Data Insights Practice',
    appUrl: 'https://gmatofficialpractice.mba.com/app/gmat-focus-official-practice-questions-data-insights',
    clientId: 789329902,
    reviewCategoryId: null,
    defaultSince: '20250101000000',
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
    })),
  });
});

app.get('/api/sessions', async (req, res) => {
  try {
    const runId = req.query.runId ? Number(req.query.runId) : null;
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20)));
    const offset = (page - 1) * pageSize;

    const [rows, total] = await Promise.all([
      listSessions(runId, { limit: pageSize, offset }),
      countSessions(runId),
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
    const result = await generatePerformanceReview({ runId, focus });

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

    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const result = await answerCoachQuestion({ runId, question, history });

    res.json({
      ok: true,
      answer: result.text,
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

    const port = cdpPortFromUrl(req.body?.cdpUrl);
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
      profileDir,
      source: sourcePreset.label,
      appUrl: sourcePreset.appUrl,
      message: 'Chrome launch command sent.',
    });
  } catch (error) {
    res.status(500).json({
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

    const rawSource = String(req.body?.source || '').trim();
    const sourcePreset = rawSource ? resolveSourcePreset(rawSource) : null;
    const result = await openUrlInOpenBrowser({
      cdpUrl: req.body?.cdpUrl,
      url: targetUrl,
      appUrl: sourcePreset?.appUrl || '',
    });

    res.json({
      ok: true,
      openedUrl: result.openedUrl,
      debug: result.debug || null,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      hint: 'Open Chrome (CDP) first, keep GMAT tab logged in, then try Open again.',
      details: clipText(error.stack || error.message || String(error), 4000),
      debug: error.openDebug || null,
    });
  }
});

app.post('/api/scrape', async (req, res) => {
  try {
    const { source, cdpUrl, scrapeWindow, customSince } = req.body || {};
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

    const { data, tabUrl, debug } = await runScrapeFromOpenBrowser({
      since: sinceValue,
      clientId: preset.clientId,
      autoDetectClientId: true,
      reviewCategoryId: preset.reviewCategoryId,
      autoDetectReviewCategoryId: !preset.reviewCategoryId,
      source: preset.label,
      appUrl: preset.appUrl,
      cdpUrl,
      scraperPath: path.resolve(__dirname, 'scrapers', 'gmat_scraper.js'),
    });

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

    res.json({
      ok: true,
      tabUrl,
      run: savedRun,
      source: preset.label,
      sinceUsed: sinceValue,
      sinceTimezone: THAI_TIME_ZONE,
      scrapeWindowUsed: String(scrapeWindow || 'today').toLowerCase(),
      mode: 'auto-upsert',
      warning,
      debug: debug || null,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[api/scrape] failed', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      hint: 'Confirm Chrome is running with --remote-debugging-port=9222 and GMAT tab is open + logged in.',
      details: clipText(error.stack || error.message || String(error), 4000),
      debug: error.scrapeDebug || null,
    });
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
