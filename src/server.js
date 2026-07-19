const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
require('dotenv').config();

const {
  dbPath,
  initDb,
  get: dbGet,
  all: dbAll,
  saveScrapeResult,
  resolveAiPracticeSetItems,
  logAiCuratedSession,
  enrichSessionAttempts,
  enrichGmatClubSessionAttempts,
  enrichGmatClubCatSessionAttempts,
  enrichOpeSessionAttempts,
  listGmatClubEnrichTargets,
  listRuns,
  listSessions,
  countSessions,
  listErrors,
  countErrors,
  getPatterns,
  getSessionAnalysis,
  updateErrorAnnotation,
  listAttemptHistory,
  saveLsatAttempt,
  listLsatAttempts,
  listLsatErrors,
  lsatStats,
  createLsatSession,
  completeLsatSession,
  listLsatSessions,
  getLsatSession,
  listStudyPlanTasks,
  getStudyPlanTask,
  createStudyPlanTask,
  updateStudyPlanTask,
  reorderStudyPlanTasks,
  deleteStudyPlanTask,
  getStudyPlanMeta,
  setStudyPlanMeta,
  listStudyPlanDays,
  createStudyPlanDay,
  updateStudyPlanDay,
  deleteStudyPlanDay,
  reorderStudyPlanDays,
  restoreStudyPlanSnapshot,
  seedStudyPlanIfEmpty,
  resetStudyPlanTasks,
  syncStudyPlanFromSeed,
  listMockResults,
  listScrapedMockResults,
  createMockResult,
  updateMockResult,
  deleteMockResult,
  seedMockResultsIfEmpty,
} = require('./db');
const fsLib = require('fs');
const {
  listLsatDashboardSessions,
  listLsatDashboardErrors,
  getLsatDashboardAnalysis,
  isLsatDashboardId,
  updateLsatDashboardAnnotation,
} = require('./lsat-dashboard');
const { LlmConfigError, generatePerformanceReview, answerCoachQuestion } = require('./llm-coach-agent');
const { classifyScrapedQuestions } = require('./question-topic-classifier');
const {
  runScrapeFromOpenBrowser,
  openUrlInOpenBrowser,
  runStartTestScrapeFromOpenBrowser,
  runStartTestPhase2FromOpenBrowser,
  runGmatClubPhase2FromOpenBrowser,
  openStartTestProductInOpenBrowser,
  runTtpScrapeFromOpenBrowser,
  runGmatClubCatScrapeFromOpenBrowser,
  runGmatClubCatPhase2FromOpenBrowser,
  runOpeListAttemptsFromOpenBrowser,
  runOpeMockScrapeFromOpenBrowser,
  runOpePhase3FromOpenBrowser,
} = require('./scraper-runner');
const { recoverTakeIdxFromSessionExternalId } = require('./scrapers/ope_mock_scraper');
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
const { readSetFiles } = require('./ai-practice-sets');
const AI_SETS_DIR = path.join(__dirname, '..', 'data', 'ai-practice-sets');
function loadAiPracticeSets() { return readSetFiles(AI_SETS_DIR); } // fresh every call — no cache

// Process-level safety net. The Phase 2 scrapers hold a long-lived Playwright
// CDP connection to the user's Chrome that we deliberately never close (closing
// it would tear down their logged-in session). When that connection emits an
// async error on a later tick — socket drop mid-navigation, a target/page
// closing, a protocol call rejecting after its own `await` already returned —
// it surfaces as an unhandledRejection / uncaughtException OUTSIDE any route's
// try/catch. Without these handlers, Node 24 treats that as fatal and exits
// non-zero, which under `node --watch` prints "Failed running 'src/server.js'.
// Waiting for file changes..." and takes the ENTIRE API down (every subsequent
// request gets ECONNREFUSED through the Vite proxy). A single failed enrich
// must never kill the whole server: log loudly, keep serving.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error(
    `[unhandledRejection ${new Date().toISOString()}] survived (not fatal):`,
    reason instanceof Error ? reason.stack || reason.message : reason
  );
});
process.on('uncaughtException', (error) => {
  // eslint-disable-next-line no-console
  console.error(
    `[uncaughtException ${new Date().toISOString()}] survived (not fatal):`,
    error instanceof Error ? error.stack || error.message : error
  );
});

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
  {
    id: 'gmat-club-cat',
    label: 'GMAT Club CAT',
    platform: 'gmatclub-cat',
    appUrl: 'https://gmatclub.com/gmat-focus-tests/?page=tests',
    clientId: null,
    reviewCategoryId: null,
    defaultSince: '20250101000000',
    scraperFile: 'gmat_club_cat_scraper.js',
    tabPattern: 'gmatclub\\.com',
  },
  {
    id: 'ttp-quant-error-tracker',
    label: 'Target Test Prep — Quant Error Tracker',
    platform: 'ttp',
    section: 'quant',
    appUrl: 'https://gmat.targettestprep.com/error_tracker/quant',
    defaultSince: '20250101000000',
    tabPattern: 'gmat\\.targettestprep\\.com',
  },
  // GMAT Official Practice Exams (OPE1-6). Two-step scrape: GET /api/ope/attempts
  // returns take list for the chosen OPE; POST /api/scrape with { source, takeIdx }
  // scrapes one take's Score Report (Phase 2 — section-summary). Phase 3 (per-question
  // enrichment) is not yet implemented.
  {
    id: 'ope-1',
    label: 'GMAT™ Official Practice Exam 1',
    platform: 'ope-mock',
    productId: 510723,
    productType: 1,
    appUrl: STARTTEST_ENTRY_URL,
    tabPattern: 'starttest\\.com',
    defaultSince: '20240101000000',
  },
  {
    id: 'ope-2',
    label: 'GMAT™ Official Practice Exam 2',
    platform: 'ope-mock',
    productId: 510724,
    productType: 1,
    appUrl: STARTTEST_ENTRY_URL,
    tabPattern: 'starttest\\.com',
    defaultSince: '20240101000000',
  },
  {
    id: 'ope-3',
    label: 'GMAT™ Official Practice Exam 3',
    platform: 'ope-mock',
    productId: 873268,
    productType: 1,
    appUrl: STARTTEST_ENTRY_URL,
    tabPattern: 'starttest\\.com',
    defaultSince: '20240101000000',
  },
  {
    id: 'ope-4',
    label: 'GMAT™ Official Practice Exam 4',
    platform: 'ope-mock',
    productId: 873269,
    productType: 1,
    appUrl: STARTTEST_ENTRY_URL,
    tabPattern: 'starttest\\.com',
    defaultSince: '20240101000000',
  },
  {
    id: 'ope-5',
    label: 'GMAT™ Official Practice Exam 5',
    platform: 'ope-mock',
    productId: 873270,
    productType: 1,
    appUrl: STARTTEST_ENTRY_URL,
    tabPattern: 'starttest\\.com',
    defaultSince: '20240101000000',
  },
  {
    id: 'ope-6',
    label: 'GMAT™ Official Practice Exam 6',
    platform: 'ope-mock',
    productId: 873271,
    productType: 1,
    appUrl: STARTTEST_ENTRY_URL,
    tabPattern: 'starttest\\.com',
    defaultSince: '20240101000000',
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

// Lightweight probe of the user's debug-Chrome on the CDP port. Hits Chrome's
// DevTools HTTP endpoints directly (no Playwright connect) so it is fast and
// side-effect free — used by the first-run checklist to show a live status dot
// and detect whether a practice tab is open. Always 200s; `connected` carries
// the result so the frontend never has to treat a down browser as an error.
app.get('/api/cdp-status', async (req, res) => {
  const base = String(process.env.CHROME_CDP_URL || 'http://localhost:9222').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const versionRes = await fetch(`${base}/json/version`, { signal: controller.signal });
    if (!versionRes.ok) throw new Error(`HTTP ${versionRes.status}`);
    const version = await versionRes.json().catch(() => ({}));
    let pages = [];
    try {
      const listRes = await fetch(`${base}/json/list`, { signal: controller.signal });
      if (listRes.ok) {
        const list = await listRes.json().catch(() => []);
        if (Array.isArray(list)) pages = list.filter((t) => t && t.type === 'page');
      }
    } catch {
      // tab list is best-effort; a connected browser with no listable tabs is still "connected"
    }
    res.json({
      connected: true,
      browser: version.Browser || null,
      tabs: pages.map((t) => ({ title: t.title || '', url: t.url || '' })),
    });
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timeout' : String(error?.message || error);
    res.json({ connected: false, reason, tabs: [] });
  } finally {
    clearTimeout(timer);
  }
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
    const platform = ['gmatclub', 'gmatclub-cat', 'starttest', 'ttp', 'ope-mock', 'lsat'].includes(req.query.platform) ? req.query.platform : null;
    const subject = ['Q', 'V', 'DI', 'RC', 'CR'].includes(String(req.query.subject || '').toUpperCase())
      ? String(req.query.subject).toUpperCase()
      : null;
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.startDate || '') ? req.query.startDate : null;
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.endDate || '') ? req.query.endDate : null;

    // LSAT practice lives in separate tables and is merged in here as the "lsat"
    // source. GMAT subjects are Q/V/DI; LSAT subjects are RC/CR — so a Q/V/DI
    // subject filter excludes LSAT, and an RC/CR filter excludes GMAT.
    const includeGmat = platform !== 'lsat' && !['RC', 'CR'].includes(subject);
    const includeLsat = (platform === null || platform === 'lsat') && !['Q', 'V', 'DI'].includes(subject);

    const gmatRows = includeGmat
      ? await listSessions(runId, {
          limit: 1000000,
          offset: 0,
          platform: platform === 'lsat' ? null : platform,
          subject: ['Q', 'V', 'DI'].includes(subject) ? subject : null,
          startDate,
          endDate,
        })
      : [];
    const lsatRows = includeLsat
      ? await listLsatDashboardSessions({ subject: ['RC', 'CR'].includes(subject) ? subject : null, startDate, endDate })
      : [];

    const merged = [...gmatRows, ...lsatRows].sort(
      (a, b) => new Date(b.session_date || 0) - new Date(a.session_date || 0)
    );
    const total = merged.length;

    res.json({
      sessions: merged.slice(offset, offset + pageSize),
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
    const rawId = String(req.params.sessionId || '');

    // LSAT practice sessions carry a namespaced "lsat-<n>" id.
    if (isLsatDashboardId(rawId)) {
      const lsatAnalysis = await getLsatDashboardAnalysis(rawId);
      if (!lsatAnalysis) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }
      res.json({ analysis: lsatAnalysis });
      return;
    }

    const sessionId = Number(rawId);
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

    const platform = ['gmatclub', 'gmatclub-cat', 'starttest', 'ttp', 'ope-mock', 'lsat'].includes(req.query.platform) ? req.query.platform : null;
    const subjectRaw = String(req.query.subject || '').toUpperCase();
    const sortKey = req.query.sortKey || 'session_date';
    const sortOrder = req.query.sortOrder === 'asc' ? 'asc' : 'desc';
    const search = req.query.search || '';

    const filterOptions = {
      runId,
      subject: req.query.subject || '',
      difficulty: req.query.difficulty || '',
      topic: req.query.topic || '',
      confidence: req.query.confidence || '',
      search,
      mistakeTag: req.query.mistakeTag || '',
      platform: platform === 'lsat' ? null : platform,
      sortKey,
      sortOrder,
    };

    // GMAT subjects are Q/V/DI; LSAT subjects are RC/CR. A Q/V/DI subject filter
    // excludes LSAT errors; an RC/CR filter excludes GMAT errors.
    const includeGmat = platform !== 'lsat' && !['RC', 'CR'].includes(subjectRaw);
    const includeLsat = (platform === null || platform === 'lsat') && !['Q', 'V', 'DI'].includes(subjectRaw);

    const gmatRows = includeGmat
      ? await listErrors({ ...filterOptions, limit: 1000000, offset: 0 })
      : [];
    const lsatRows = includeLsat
      ? await listLsatDashboardErrors({ subject: ['RC', 'CR'].includes(subjectRaw) ? subjectRaw : null, search })
      : [];

    const dir = sortOrder === 'asc' ? 1 : -1;
    const merged = [...gmatRows, ...lsatRows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const an = Number(av);
      const bn = Number(bv);
      const numeric =
        av != null && bv != null &&
        String(av).trim() !== '' && String(bv).trim() !== '' &&
        !Number.isNaN(an) && !Number.isNaN(bn);
      const c = numeric ? an - bn : String(av ?? '').localeCompare(String(bv ?? ''));
      return c * dir;
    });
    const total = merged.length;

    res.json({
      errors: merged.slice(offset, offset + pageSize),
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
    const rawId = req.params.errorId;
    const mistakeType = req.body?.mistakeType;
    const notes = req.body?.notes;
    const annotation = {
      mistakeType: typeof mistakeType === 'string' ? mistakeType : '',
      notes: typeof notes === 'string' ? notes : '',
    };

    // LSAT errors carry a namespaced "lsat-<attemptId>" id and live in lsat_attempts,
    // so they need their own writer rather than the question_attempts UPDATE path.
    if (isLsatDashboardId(rawId)) {
      const updatedLsat = await updateLsatDashboardAnnotation(rawId, annotation);
      if (!updatedLsat) {
        res.status(404).json({ error: 'Question attempt not found.' });
        return;
      }
      res.json({ ok: true, error: updatedLsat });
      return;
    }

    const errorId = Number(rawId);
    if (!Number.isInteger(errorId) || errorId <= 0) {
      res.status(400).json({ error: 'Invalid error id.' });
      return;
    }

    const updated = await updateErrorAnnotation(errorId, annotation);

    if (!updated) {
      res.status(404).json({ error: 'Question attempt not found.' });
      return;
    }

    res.json({ ok: true, error: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Every attempt sharing a question identity (q_code, or q_id fallback), oldest
// first — powers the error-log "Attempt history" (original + redos with notes).
app.get('/api/attempts/history', async (req, res) => {
  try {
    const attempts = await listAttemptHistory({ qCode: req.query.q_code, qId: req.query.q_id });
    res.json({ attempts });
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
    } else if (preset.platform === 'gmatclub-cat') {
      const targets = await listGmatClubEnrichTargets(sessionRow.id);
      if (!targets.length) {
        res.status(400).json({ ok: false, error: 'No questions in this session have a question_url to enrich.' });
        return;
      }
      phase2 = await runGmatClubCatPhase2FromOpenBrowser({
        cdpUrl: validatedCdpUrl,
        targets: targets.map((t) => ({ q_id: t.q_id, q_code: t.q_code, url: t.question_url })),
      });
      dbResult = await enrichGmatClubCatSessionAttempts({
        sessionExternalId: sessionRow.session_external_id,
        source: sessionRow.source,
        enrichedItems: phase2.result?.items || [],
      });
    } else if (preset.platform === 'ope-mock') {
      // OPE Phase 3: per-question enrichment via REVIEW-ALL frame walk.
      // takeIdx is recovered from the session_external_id hash by trying
      // 1..N — takeIdx isn't persisted on the session row, but the hash is
      // small (53-bit) and the input space is tiny (≤10 takes per product),
      // so inversion is cheap and reliable. The runner now uses this takeIdx
      // to deterministically open / verify the right Score Report popup
      // (previously it accepted any open ITDStart popup, which could enrich
      // the wrong take into this session).
      const recoveredTakeIdx = recoverTakeIdxFromSessionExternalId(
        sessionRow.session_external_id,
        preset.productId,
      );
      const takeIdx = Number(req.body?.takeIdx) || recoveredTakeIdx;
      if (!Number.isInteger(takeIdx) || takeIdx < 1) {
        res.status(400).json({
          ok: false,
          error: `Could not recover takeIdx from session_external_id ${sessionRow.session_external_id} for productId ${preset.productId}. Re-run Phase 2 scrape for this take, or pass takeIdx explicitly in the request body.`,
        });
        return;
      }
      phase2 = await runOpePhase3FromOpenBrowser({
        cdpUrl: validatedCdpUrl,
        sourceId: preset.id,
        takeIdx,
        expectedTotal: Number(sessionRow.total_q_api) || 64,
      });
      dbResult = await enrichOpeSessionAttempts({
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

// GET /api/ope/attempts?source=ope-1 — list available takes for an OPE so the
// UI can render a picker. Returns { takes: [{takeIdx, completedAt, status,
// hasReport, ...}] }. Requires Chrome on port 9222 with a starttest tab open.
app.get('/api/ope/attempts', async (req, res) => {
  try {
    const validatedCdpUrl = getValidatedCdpUrl(req.query?.cdpUrl);
    const preset = resolveSourcePreset(req.query?.source);
    if (!preset) {
      res.status(400).json({ ok: false, error: 'Unknown source. Pass ?source=ope-1 (or ope-2..6).' });
      return;
    }
    if (preset.platform !== 'ope-mock') {
      res.status(400).json({
        ok: false,
        error: `Source "${preset.label}" is not an OPE. /api/ope/attempts only handles ope-mock platform sources.`,
      });
      return;
    }
    const result = await runOpeListAttemptsFromOpenBrowser({
      sourceId: preset.id,
      cdpUrl: validatedCdpUrl,
    });
    res.json(withOptionalDebug({
      ok: true,
      source: preset.label,
      productId: result.productId,
      takes: result.takes,
      tabUrl: result.tabUrl,
    }, {
      debug: result.debug || null,
    }));
  } catch (error) {
    res.status(Number(error.statusCode || 500)).json(withOptionalDebug({
      ok: false,
      error: error.message,
      hint: 'Confirm Chrome is running with --remote-debugging-port=9222 and a starttest.com tab is open + logged in.',
    }, {
      details: clipText(error.stack || error.message || String(error), 4000),
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
    // Official Practice books post-2026-04-22 migration), the TTP scraper for
    // Target Test Prep, or fall back to the legacy injected-script flow for
    // the remaining gmatclub source.
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
    } else if (preset.platform === 'ttp') {
      const result = await runTtpScrapeFromOpenBrowser({
        sourceId: preset.id,
        cdpUrl: validatedCdpUrl,
      });
      data = result.data;
      tabUrl = result.tabUrl;
      debug = result.debug;
    } else if (preset.platform === 'gmatclub-cat') {
      const result = await runGmatClubCatScrapeFromOpenBrowser({
        cdpUrl: validatedCdpUrl,
        since: sinceValue,
        source: preset.label,
      });
      data = result.data;
      tabUrl = result.tabUrl;
      debug = result.debug;
    } else if (preset.platform === 'ope-mock') {
      // OPE scrape requires a takeIdx — caller picks one from /api/ope/attempts.
      const takeIdx = Number(req.body?.takeIdx);
      if (!Number.isInteger(takeIdx) || takeIdx < 1) {
        res.status(400).json({
          ok: false,
          error: 'takeIdx (positive integer) required for OPE scrapes. Call GET /api/ope/attempts?source=<ope-N> first to enumerate available takes.',
        });
        return;
      }
      const result = await runOpeMockScrapeFromOpenBrowser({
        sourceId: preset.id,
        takeIdx,
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

// ---------- AI Curated Practice endpoints ----------

app.get('/api/ai-practice/sets', async (req, res) => {
  try {
    const sets = loadAiPracticeSets();
    // completedCount = how many logged AI-curated sessions exist per slug (q_id prefix aic-att-<slug>-).
    const counts = await dbAll(
      `SELECT count(DISTINCT qa.session_id) AS n,
              substring(qa.q_id from 'aic-att-(.*)-[0-9]+$') AS slug
         FROM question_attempts qa
        WHERE qa.q_id LIKE 'aic-att-%'
        GROUP BY slug`
    );
    const bySlug = new Map(counts.map((c) => [c.slug, Number(c.n) || 0]));
    res.json({
      sets: sets.map((s) => ({
        slug: s.slug, title: s.title, focusNote: s.focusNote, subject: s.subject,
        count: s.items.length, completedCount: bySlug.get(s.slug) || 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ai-practice/sets/:slug', async (req, res) => {
  try {
    const set = loadAiPracticeSets().find((s) => s.slug === req.params.slug);
    if (!set) return res.status(404).json({ error: 'Set not found' });
    const { items, missing } = await resolveAiPracticeSetItems(set.items);
    res.json({
      slug: set.slug, title: set.title, focusNote: set.focusNote, subject: set.subject,
      missing,
      questions: items.map((it) => ({
        itemId: it.itemId, topic: it.topic, difficulty: it.difficulty, source: it.source,
        question_stem: it.questionStem, question_stem_html: it.questionStemHtml,
        // Strip the answer-key flags (isCorrect/isUserSelected/value) — anti-peek —
        // but keep textHtml so math-image choices (OG) render as their equation.
        answer_choices: safeParseChoices(it.answerChoices).map((c) => ({ label: c.label, text: c.text, textHtml: c.textHtml || null })),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function safeParseChoices(raw) {
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch (_e) { return []; }
}

app.post('/api/ai-practice/sets/:slug/submit', async (req, res) => {
  try {
    const set = loadAiPracticeSets().find((s) => s.slug === req.params.slug);
    if (!set) return res.status(404).json({ error: 'Set not found' });
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (answers.length === 0) return res.status(400).json({ error: 'No answers submitted' });

    const { items } = await resolveAiPracticeSetItems(set.items);
    const byItem = new Map(items.map((it) => [it.itemId, it]));

    const gradedItems = [];
    const results = [];
    for (const a of answers) {
      const it = byItem.get(Number(a.itemId));
      if (!it) continue;                                   // stale/unavailable — skip
      const your = String(a.answer || '').trim();
      const key = String(it.correctAnswer || '').trim();
      const correct = gradeAnswer(your, key, it.answerChoices) ? 1 : 0;
      gradedItems.push({ served: it, myAnswer: your, correct, timeSec: a.timeSec, confidence: a.confidence });
      results.push({ itemId: it.itemId, correct, yourAnswer: your, correctAnswer: key, priorAttempt: it.priorAttempt });
    }
    if (gradedItems.length === 0) return res.status(400).json({ error: 'No gradeable answers' });

    const { sessionId } = await logAiCuratedSession({
      slug: set.slug, title: set.title, subject: set.subject, gradedItems,
    });
    res.json({
      sessionId,
      score: { correct: gradedItems.filter((g) => g.correct === 1).length, total: gradedItems.length },
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-question grade for "immediate feedback" mode: reveals the answer for a
// SINGLE item the user has already committed to, keeping the rest of the set's
// key hidden (anti-peek). Read-only — does NOT log; the end-of-session submit
// remains the authoritative writer. The itemId must belong to this set, so a
// caller can't harvest answers for arbitrary question rows.
app.post('/api/ai-practice/sets/:slug/grade', async (req, res) => {
  try {
    const set = loadAiPracticeSets().find((s) => s.slug === req.params.slug);
    if (!set) return res.status(404).json({ error: 'Set not found' });
    const itemId = Number(req.body?.itemId);
    if (!Number.isInteger(itemId)) return res.status(400).json({ error: 'Bad itemId' });
    // set.items references questions by q_code now (not row id), so the old
    // `set.items.includes(itemId)` guard rejected EVERY review-mode grade (posted
    // itemId is the resolved numeric row id). Resolve the whole set and match the
    // posted row id against the resolved items — same scoping the /submit path uses.
    const { items } = await resolveAiPracticeSetItems(set.items);
    const it = items.find((x) => x.itemId === itemId);
    if (!it) return res.status(404).json({ error: 'Item not in set' });
    const your = String(req.body?.answer || '').trim();
    const correct = gradeAnswer(your, it.correctAnswer, it.answerChoices) ? 1 : 0;
    res.json({ itemId, correct, correctAnswer: it.correctAnswer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grade a chosen label against the stored correct_answer. Matches on label
// (case-insensitive), or on the chosen choice's text when correct_answer holds
// full text rather than a letter.
function gradeAnswer(yourLabel, correctAnswer, answerChoicesJson) {
  const y = String(yourLabel || '').trim().toUpperCase();
  const k = String(correctAnswer || '').trim().toUpperCase();
  if (!y || !k) return false;
  if (y === k) return true;
  const choices = safeParseChoices(answerChoicesJson);
  const chosen = choices.find((c) => String(c.label || '').trim().toUpperCase() === y);
  if (chosen && String(chosen.text || '').trim().toUpperCase() === k) return true;
  return false;
}

// ---------- LSAT practice endpoints ----------
let lsatDataCache = null;
function loadLsatData() {
  if (lsatDataCache) return lsatDataCache;
  const p = path.join(__dirname, '..', 'data', 'lsat-questions.json');
  if (!fsLib.existsSync(p)) {
    lsatDataCache = { tests: [] };
    return lsatDataCache;
  }
  lsatDataCache = JSON.parse(fsLib.readFileSync(p, 'utf-8'));
  return lsatDataCache;
}

// Flat library view: every section across every test, joined with attempt progress.
// Returned shape:
//   { sections: [{ testNum, sectionRoman, kind, questionCount, passageCount,
//                  attempted, correct, totalTimeMs, lastAttemptedAt }] }
app.get('/api/lsat/library', async (req, res) => {
  try {
    const data = loadLsatData();
    // Use latest-only attempts so each (test, section, question) contributes once,
    // representing the user's most-recent answer. Earlier history is preserved
    // in the DB and shown in error log / session review views.
    const attempts = await listLsatAttempts({ latestOnly: true });
    // Total session count per (test, section) — separate query, fast.
    const sessions = await listLsatSessions();
    const sessionCount = new Map();
    for (const s of sessions) {
      const key = `${s.test_num}:${s.section_roman}`;
      sessionCount.set(key, (sessionCount.get(key) || 0) + 1);
    }
    const progress = new Map();
    for (const a of attempts) {
      const key = `${a.test_num}:${a.section_roman}`;
      if (!progress.has(key)) {
        progress.set(key, { attempted: 0, correct: 0, totalTimeMs: 0, lastAttemptedAt: null });
      }
      const p = progress.get(key);
      p.attempted += 1;
      if (a.is_correct) p.correct += 1;
      if (a.time_ms) p.totalTimeMs += a.time_ms;
      if (!p.lastAttemptedAt || (a.attempted_at && a.attempted_at > p.lastAttemptedAt)) {
        p.lastAttemptedAt = a.attempted_at;
      }
    }
    const sections = [];
    for (const t of data.tests) {
      for (const s of t.sections) {
        if (s.kind !== 'RC' && s.kind !== 'LR') continue;
        const key = `${t.num}:${s.roman}`;
        const p = progress.get(key) || { attempted: 0, correct: 0, totalTimeMs: 0, lastAttemptedAt: null };
        sections.push({
          testNum: t.num,
          sectionRoman: s.roman,
          kind: s.kind,
          questionCount: s.questions.length,
          passageCount: (s.passages || []).length || (s.passage ? 1 : 0),
          attempted: p.attempted,
          correct: p.correct,
          totalTimeMs: p.totalTimeMs,
          lastAttemptedAt: p.lastAttemptedAt,
          sessionCount: sessionCount.get(key) || 0,
        });
      }
    }
    res.json({ sections });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lsat/tests', (req, res) => {
  try {
    const data = loadLsatData();
    const summary = data.tests.map(t => ({
      num: t.num,
      sections: t.sections.map(s => ({
        roman: s.roman,
        kind: s.kind,
        questionCount: s.questions.length,
        hasPassage: !!s.passage,
      })),
    }));
    res.json({ tests: summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lsat/tests/:testNum/sections/:sectionRoman', (req, res) => {
  try {
    const data = loadLsatData();
    const t = data.tests.find(x => String(x.num) === String(req.params.testNum));
    if (!t) return res.status(404).json({ error: 'Test not found' });
    const s = t.sections.find(x => x.roman === req.params.sectionRoman.toUpperCase());
    if (!s) return res.status(404).json({ error: 'Section not found' });

    // Annotate each question with its passage index (RC only). For LR/AR there is
    // typically a single shared "passage" (or none), so leave it 0/undefined.
    const passages = (s.passages && s.passages.length) ? s.passages : (s.passage ? [{ firstQuestion: 1, text: s.passage }] : []);
    const questionsWithPassage = s.questions.map(q => {
      let passageIdx = -1;
      for (let i = passages.length - 1; i >= 0; i--) {
        if (passages[i].firstQuestion <= q.number) { passageIdx = i; break; }
      }
      return { ...q, passageIdx };
    });
    res.json({
      testNum: t.num,
      section: { ...s, passages, questions: questionsWithPassage },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lsat/attempts', async (req, res) => {
  try {
    const { testNum, sectionRoman, sectionKind, questionNumber, userAnswer, confidence, timeMs, sessionId } = req.body || {};
    if (!testNum || !sectionRoman || !questionNumber || !userAnswer) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const data = loadLsatData();
    const t = data.tests.find(x => x.num === Number(testNum));
    if (!t) return res.status(404).json({ error: 'Test not found' });
    const s = t.sections.find(x => x.roman === String(sectionRoman).toUpperCase());
    if (!s) return res.status(404).json({ error: 'Section not found' });
    const q = s.questions.find(x => x.number === Number(questionNumber));
    if (!q) return res.status(404).json({ error: 'Question not found' });
    const result = await saveLsatAttempt({
      testNum: Number(testNum),
      sectionRoman: String(sectionRoman).toUpperCase(),
      sectionKind: s.kind,
      questionNumber: Number(questionNumber),
      userAnswer: String(userAnswer).toUpperCase(),
      correctAnswer: q.correct,
      confidence: confidence || null,
      timeMs: timeMs != null ? Number(timeMs) : null,
      sessionId: sessionId != null ? Number(sessionId) : null,
    });
    res.json({ ...result, correctAnswer: q.correct });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new practice session for a question set.
app.post('/api/lsat/sessions', async (req, res) => {
  try {
    const { testNum, sectionRoman, setKey, setLabel, firstQuestion, lastQuestion, mode, questionNumbers } = req.body || {};
    if (!testNum || !sectionRoman || !setKey || !firstQuestion || !lastQuestion) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const data = loadLsatData();
    const t = data.tests.find(x => x.num === Number(testNum));
    if (!t) return res.status(404).json({ error: 'Test not found' });
    const s = t.sections.find(x => x.roman === String(sectionRoman).toUpperCase());
    if (!s) return res.status(404).json({ error: 'Section not found' });
    const result = await createLsatSession({
      testNum: Number(testNum),
      sectionRoman: String(sectionRoman).toUpperCase(),
      sectionKind: s.kind,
      setKey: String(setKey),
      setLabel: setLabel || null,
      firstQuestion: Number(firstQuestion),
      lastQuestion: Number(lastQuestion),
      mode: mode || 'exam',
      questionNumbers: Array.isArray(questionNumbers)
        ? questionNumbers.map(Number).filter((n) => Number.isInteger(n))
        : null,
    });
    res.json({ id: result.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lsat/sessions/:id/complete', async (req, res) => {
  try {
    const result = await completeLsatSession(Number(req.params.id));
    res.json({ ok: true, answeredCount: result?.answeredCount ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lsat/sessions', async (req, res) => {
  try {
    const testNum = req.query.testNum != null ? Number(req.query.testNum) : null;
    const sectionRoman = req.query.sectionRoman ? String(req.query.sectionRoman).toUpperCase() : null;
    const rows = await listLsatSessions({ testNum, sectionRoman });
    res.json({ sessions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lsat/sessions/:id', async (req, res) => {
  try {
    const session = await getLsatSession(Number(req.params.id));
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lsat/attempts', async (req, res) => {
  try {
    const testNum = req.query.testNum != null ? Number(req.query.testNum) : null;
    const sessionId = req.query.sessionId != null ? Number(req.query.sessionId) : null;
    const latestOnly = req.query.latestOnly === 'true' || req.query.latestOnly === '1';
    const rows = await listLsatAttempts({ testNum, sessionId, latestOnly });
    res.json({ attempts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LSAT error log: most recent incorrect attempts across all sessions.
app.get('/api/lsat/errors', async (req, res) => {
  try {
    const testNum = req.query.testNum != null ? Number(req.query.testNum) : null;
    const sectionRoman = req.query.sectionRoman ? String(req.query.sectionRoman).toUpperCase() : null;
    const limit = req.query.limit != null ? Math.min(500, Number(req.query.limit)) : 200;
    const rows = await listLsatErrors({ testNum, sectionRoman, limit });
    // Hydrate each row with the question stem + choices for inline review.
    const data = loadLsatData();
    const enriched = rows.map(r => {
      const t = data.tests.find(x => x.num === r.test_num);
      const s = t?.sections.find(x => x.roman === r.section_roman);
      const q = s?.questions.find(x => x.number === r.question_number);
      return {
        ...r,
        question: q ? { stem: q.stem, choices: q.choices } : null,
      };
    });
    res.json({ errors: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lsat/stats', async (req, res) => {
  try {
    const stats = await lsatStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Study Plan API ────────────────────────────────────────────────────────
// The plan is a 28-day final-sprint checklist drafted 2026-05-23. Each task is
// a sub-item under a specific day (date). Status is one of pending/done/skipped.
// `GET /api/study-plan` returns everything the UI needs in one round trip.

app.get('/api/study-plan', async (req, res) => {
  try {
    await seedStudyPlanIfEmpty();
    const [tasks, meta, days] = await Promise.all([
      listStudyPlanTasks(), getStudyPlanMeta(), listStudyPlanDays(),
    ]);
    // `days` are first-class rows, so an emptied or newly-added day persists
    // independently of whether any task currently lives on it.
    res.json({ tasks, meta, days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/study-plan/tasks', async (req, res) => {
  try {
    const task = await createStudyPlanTask(req.body || {});
    res.status(201).json({ task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/study-plan/tasks/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid task id.' });
    }
    const task = await updateStudyPlanTask(id, req.body || {});
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    res.json({ task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/study-plan/tasks/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid task id.' });
    }
    const ok = await deleteStudyPlanTask(id);
    if (!ok) return res.status(404).json({ error: 'Task not found.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/study-plan/reorder', async (req, res) => {
  try {
    const updates = (req.body && req.body.updates) || [];
    const tasks = await reorderStudyPlanTasks(updates);
    res.json({ tasks });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Study plan days (first-class) ──────────────────────────────────────────

app.post('/api/study-plan/days', async (req, res) => {
  try {
    const day = await createStudyPlanDay(req.body || {});
    res.status(201).json({ day });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/study-plan/days/:date', async (req, res) => {
  try {
    const day = await updateStudyPlanDay(req.params.date, req.body || {});
    if (!day) return res.status(404).json({ error: 'Day not found.' });
    res.json({ day });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/study-plan/days/:date', async (req, res) => {
  try {
    const ok = await deleteStudyPlanDay(req.params.date);
    if (!ok) return res.status(404).json({ error: 'Day not found.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Drag-reorder whole days. Body: { updates: [{ date, sort_order, week_number }] }.
app.post('/api/study-plan/days/reorder', async (req, res) => {
  try {
    const updates = (req.body && req.body.updates) || [];
    const days = await reorderStudyPlanDays(updates);
    res.json({ days });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Undo/redo: reconcile the whole plan to a client-captured snapshot.
// Body: { days, tasks, meta }. Returns the fresh full plan.
app.post('/api/study-plan/restore', async (req, res) => {
  try {
    const result = await restoreStudyPlanSnapshot(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Smart sync: apply the latest buildStudyPlanSeed() to existing tasks.
// Rows with status != 'pending' OR non-empty notes are preserved (only their
// day_theme/label is updated). This is the right way to apply seed changes
// when the user has already made progress.
app.post('/api/study-plan/sync', async (req, res) => {
  try {
    const result = await syncStudyPlanFromSeed();
    const [tasks, meta] = await Promise.all([listStudyPlanTasks(), getStudyPlanMeta()]);
    res.json({ ...result, tasks, meta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Wipe all plan tasks and immediately re-seed from buildStudyPlanSeed().
// Used when the seed payload changes and the user wants a fresh checklist.
// Preserves study_plan_meta (test date, plan title) unless explicitly cleared.
app.post('/api/study-plan/reset', async (req, res) => {
  try {
    const { deleted } = await resetStudyPlanTasks();
    const seedResult = await seedStudyPlanIfEmpty();
    const [tasks, meta] = await Promise.all([listStudyPlanTasks(), getStudyPlanMeta()]);
    res.json({ deleted, ...seedResult, tasks, meta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/study-plan/meta', async (req, res) => {
  try {
    const patch = req.body || {};
    const keys = Object.keys(patch);
    if (!keys.length) return res.status(400).json({ error: 'No meta fields provided.' });
    for (const k of keys) {
      await setStudyPlanMeta(k, patch[k]);
    }
    const meta = await getStudyPlanMeta();
    res.json({ meta });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Mock Results API ──────────────────────────────────────────────────────
// Tracks full-length mock exam scores (OPE + GMAT Club CAT). Seeded once with
// Mock #1 baseline. UI surfaces this in the Study Plan view for trend tracking.

app.get('/api/mocks', async (req, res) => {
  try {
    // Note: seedMockResultsIfEmpty intentionally NOT called here. It used to
    // run on every read to bootstrap the OPE3 baseline, but that re-created
    // any row the user explicitly deleted. The scraped mocks list now covers
    // the same baseline, so the manual table is purely opt-in.
    const [manual, scraped] = await Promise.all([
      listMockResults(),
      listScrapedMockResults(),
    ]);
    const mocks = manual.map((m) => ({ ...m, source_type: 'manual' }));
    res.json({ mocks, mocks_scraped: scraped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mocks', async (req, res) => {
  try {
    const mock = await createMockResult(req.body || {});
    res.status(201).json({ mock });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/mocks/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid mock id.' });
    }
    const mock = await updateMockResult(id, req.body || {});
    if (!mock) return res.status(404).json({ error: 'Mock not found.' });
    res.json({ mock });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/mocks/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid mock id.' });
    }
    const ok = await deleteMockResult(id);
    if (!ok) return res.status(404).json({ error: 'Mock not found.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
