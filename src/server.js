const path = require('path');
const { spawn } = require('child_process');
const express = require('express');

const {
  dbPath,
  initDb,
  saveScrapeResult,
  listRuns,
  listSessions,
  listErrors,
  getPatterns,
  getSessionAnalysis,
  updateErrorAnnotation,
} = require('./db');
const { runScrapeFromOpenBrowser } = require('./scraper-runner');

const app = express();
const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.HOST || '127.0.0.1';
const clientDistPath = path.resolve(__dirname, '..', 'client', 'dist');

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

function toSinceLocal(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const sec = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}${min}${sec}`;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseCustomSince(rawValue) {
  if (!rawValue) return null;
  const str = String(rawValue).trim();
  if (!str) return null;
  if (/^\d{14}$/.test(str)) return str;

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(str) ? `${str}T00:00:00` : str;
  const date = new Date(normalized);
  return toSinceLocal(date);
}

function resolveSinceFromWindow({ windowKey, customSince, fullDefaultSince }) {
  const key = String(windowKey || 'today').toLowerCase();

  if (key === 'full') return fullDefaultSince;
  if (key === 'custom') return parseCustomSince(customSince) || fullDefaultSince;

  if (key === 'last3') {
    const d = startOfToday();
    d.setDate(d.getDate() - 3);
    return toSinceLocal(d);
  }
  if (key === 'last7') {
    const d = startOfToday();
    d.setDate(d.getDate() - 7);
    return toSinceLocal(d);
  }

  return toSinceLocal(startOfToday());
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
    const rows = await listSessions(runId);
    res.json({ sessions: rows });
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
    const rows = await listErrors({
      runId,
      subject: req.query.subject || '',
      difficulty: req.query.difficulty || '',
      topic: req.query.topic || '',
      confidence: req.query.confidence || '',
    });
    res.json({ errors: rows });
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
