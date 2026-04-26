const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const DEFAULT_SCRAPER_CONFIG = {
  clientId: 789329902,
  since: '20260101000000',
  reviewCategoryId: null,
  source: 'GMAT™ Official Guide 2024-2025 - Verbal',
  pageWaitMs: 3200,
  nextPageWaitMs: 2600,
  reviewReadyTimeoutMs: 18000,
};

async function loadScraperSource(customPath) {
  const scraperPath = customPath || path.resolve(__dirname, 'scrapers', 'gmat_scraper.js');
  return fs.readFile(scraperPath, 'utf8');
}

function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULT_SCRAPER_CONFIG };
  if (raw.since) cfg.since = String(raw.since);
  if (raw.clientId) cfg.clientId = Number(raw.clientId);
  if (Object.prototype.hasOwnProperty.call(raw, 'reviewCategoryId')) {
    const value = raw.reviewCategoryId;
    if (value === null || value === undefined || value === '') {
      cfg.reviewCategoryId = null;
    } else {
      const parsed = Number(value);
      cfg.reviewCategoryId = Number.isInteger(parsed) ? parsed : null;
    }
  }
  if (raw.source) cfg.source = String(raw.source);
  if (raw.pageWaitMs) cfg.pageWaitMs = Number(raw.pageWaitMs);
  if (raw.nextPageWaitMs) cfg.nextPageWaitMs = Number(raw.nextPageWaitMs);
  if (raw.reviewReadyTimeoutMs) cfg.reviewReadyTimeoutMs = Number(raw.reviewReadyTimeoutMs);
  return cfg;
}

function extractAppSlug(appUrl) {
  if (!appUrl) return '';
  try {
    const parsed = new URL(appUrl);
    const m = parsed.pathname.match(/\/app\/([^/]+)/i);
    return m?.[1] || '';
  } catch (_error) {
    return '';
  }
}

function parseUrlSafe(rawValue) {
  try {
    return new URL(String(rawValue || ''));
  } catch (_error) {
    return null;
  }
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function isAppPath(pathname) {
  return /^\/app\/[^/]+/i.test(String(pathname || ''));
}

function resolveNavigationTargetUrl(targetUrl, appUrl) {
  const targetParsed = parseUrlSafe(targetUrl);
  if (!targetParsed) return targetUrl;

  const hashRoute = String(targetParsed.hash || '').replace(/^#/, '');
  const isCustomQuizHash = /^custom-quiz\/\d+/i.test(hashRoute);
  const targetPath = trimTrailingSlash(targetParsed.pathname || '/');
  const isRootPath = !targetPath;
  if (!isCustomQuizHash || !isRootPath) return targetUrl;

  const appParsed = parseUrlSafe(appUrl);
  if (!appParsed) return targetUrl;
  if (targetParsed.origin !== appParsed.origin) return targetUrl;
  if (!isAppPath(appParsed.pathname)) return targetUrl;

  const next = new URL(targetParsed.toString());
  next.pathname = appParsed.pathname;
  next.search = '';
  return next.toString();
}

function matchesAppEntry(pageUrl, appUrl) {
  const pageParsed = parseUrlSafe(pageUrl);
  const appParsed = parseUrlSafe(appUrl);
  if (!pageParsed || !appParsed) return false;

  const pagePath = trimTrailingSlash(pageParsed.pathname || '/');
  const appPath = trimTrailingSlash(appParsed.pathname || '/');
  if (pageParsed.origin !== appParsed.origin || pagePath !== appPath) return false;

  const pageHash = String(pageParsed.hash || '').replace(/^#/, '').trim();
  const appHash = String(appParsed.hash || '').replace(/^#/, '').trim();

  // The scraper should start from the source root, not from a deep review/custom-quiz route
  // that happens to share the same /app/... pathname.
  if (!appHash) return !pageHash;
  return pageHash === appHash;
}

function clipText(value, maxLen = 1000) {
  const text = String(value || '');
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

function parseCdpUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
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

function buildCdpUrlCandidates(rawUrl) {
  const parsed = parseCdpUrl(rawUrl);
  if (!parsed) return [String(rawUrl || '').trim() || 'http://localhost:9222'];

  const originalHost = String(parsed.hostname || '').replace(/^\[|\]$/g, '');
  const hostCandidates = [originalHost];
  if (originalHost === '127.0.0.1') hostCandidates.push('localhost', '::1');
  if (originalHost === 'localhost') hostCandidates.push('127.0.0.1', '::1');
  if (originalHost === '::1') hostCandidates.push('localhost', '127.0.0.1');

  const uniqueHosts = [];
  for (const host of hostCandidates) {
    if (host && !uniqueHosts.includes(host)) uniqueHosts.push(host);
  }

  const urls = uniqueHosts.map((host) => {
    const next = new URL(parsed.toString());
    next.hostname = host;
    return next.toString();
  });

  return urls.length ? urls : [parsed.toString()];
}

async function connectBrowserOverCdp(rawUrl) {
  const attemptedUrls = buildCdpUrlCandidates(rawUrl);
  const attemptErrors = [];

  for (const url of attemptedUrls) {
    try {
      const browser = await chromium.connectOverCDP(url);
      return {
        browser,
        connectedUrl: url,
        attemptedUrls,
        fallbackUsed: url !== attemptedUrls[0],
      };
    } catch (error) {
      attemptErrors.push({
        url,
        message: clipText(error?.message || String(error), 800),
      });
    }
  }

  const error = new Error(
    `Unable to connect to Chrome CDP. Tried: ${attemptedUrls.join(', ')}. Open Chrome with remote debugging and keep tab logged in.`
  );
  error.cdpAttemptedUrls = attemptedUrls;
  error.cdpAttemptErrors = attemptErrors;
  throw error;
}

async function inferClientId(page, fallbackClientId) {
  try {
    const detected = await page.evaluate(() => {
      const candidates = [
        window.client_id,
        window.clientId,
        window.__INITIAL_STATE__?.client_id,
        window.__INITIAL_STATE__?.clientId,
        window.__NUXT__?.state?.client_id,
        window.__NUXT__?.state?.clientId,
      ];

      for (const value of candidates) {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed > 0) return parsed;
      }
      return null;
    });
    if (Number.isInteger(detected) && detected > 0) return detected;
  } catch (_error) {
    // Fallback below.
  }
  return fallbackClientId;
}

async function inferReviewCategoryId(page, cfg, fallbackReviewCategoryId) {
  try {
    const details = await page.evaluate(async ({ since, clientId }) => {
      const response = await fetch(`/api/v2/activities.json?since=${since}&client_id=${clientId}`);
      if (!response.ok) return { categories: [] };
      const activities = await response.json();
      const categories = Array.from(
        new Set(
          (activities || [])
            .filter((item) => item.activity_type === 'answer')
            .map((item) => Number(item.activity_data?.question_category_id))
            .filter((id) => Number.isInteger(id))
        )
      ).sort((a, b) => a - b);
      return { categories };
    }, cfg);

    const categories = details?.categories || [];
    if (categories.length === 1) return categories[0];
    // Mixed-category sources (e.g., OG Main) should not force a single category id.
    if (categories.length > 1) return fallbackReviewCategoryId;
  } catch (_error) {
    // Fallback below.
  }
  return fallbackReviewCategoryId;
}

async function runScrapeFromOpenBrowser(options = {}) {
  const requestedCdpUrl = options.cdpUrl || process.env.CHROME_CDP_URL || 'http://localhost:9222';
  const scraperSource = await loadScraperSource(options.scraperPath);
  const reloadPageBeforeScrape = options.reloadPageBeforeScrape !== false;

  const startedAt = new Date().toISOString();
  const consoleLogs = [];
  const pageErrors = [];
  const pushLog = (target, entry, limit = 200) => {
    target.push(entry);
    if (target.length > limit) target.shift();
  };

  let browser = null;
  let connectedCdpUrl = requestedCdpUrl;
  let attemptedCdpUrls = [requestedCdpUrl];
  let cdpFallbackUsed = false;
  let gmatPage = null;
  let runtimeConfig = normalizeConfig(options);
  const appSlug = extractAppSlug(options.appUrl);
  let sourceNavigation = {
    requestedUrl: options.appUrl || '',
    fromUrl: '',
    toUrl: '',
    didNavigate: false,
    reloadedBeforeScrape: false,
  };
  let onConsole = null;
  let onPageError = null;
  try {
    const cdpConnection = await connectBrowserOverCdp(requestedCdpUrl);
    browser = cdpConnection.browser;
    connectedCdpUrl = cdpConnection.connectedUrl;
    attemptedCdpUrls = cdpConnection.attemptedUrls;
    cdpFallbackUsed = cdpConnection.fallbackUsed;

    const pages = browser.contexts().flatMap((ctx) => ctx.pages());
    const tabRegex = new RegExp(options.tabPattern || 'gmatofficialpractice\\.mba\\.com', 'i');
    const gmatPages = pages.filter((page) => tabRegex.test(page.url()));
    gmatPage =
      (appSlug
        ? gmatPages.find((page) => page.url().includes(`/app/${appSlug}`))
        : null) || gmatPages[0];

    if (!gmatPage) {
      throw new Error(
        `No matching tab found. Open the target site in the same Chrome instance and stay logged in.`
      );
    }

    gmatPage.setDefaultTimeout(0);
    await gmatPage.bringToFront();
    await gmatPage.waitForLoadState('domcontentloaded');

    if (options.appUrl && !matchesAppEntry(gmatPage.url(), options.appUrl)) {
      sourceNavigation = {
        ...sourceNavigation,
        fromUrl: gmatPage.url(),
      };
      await gmatPage.goto(options.appUrl, { waitUntil: 'domcontentloaded' });
      await gmatPage.waitForLoadState('domcontentloaded');
      sourceNavigation = {
        ...sourceNavigation,
        toUrl: gmatPage.url(),
        didNavigate: true,
      };
    } else {
      sourceNavigation = {
        ...sourceNavigation,
        fromUrl: gmatPage.url(),
        toUrl: gmatPage.url(),
      };
    }

    if (reloadPageBeforeScrape) {
      await gmatPage.reload({ waitUntil: 'domcontentloaded' });
      sourceNavigation = {
        ...sourceNavigation,
        toUrl: gmatPage.url(),
        reloadedBeforeScrape: true,
      };
    }

    onConsole = (msg) => {
      pushLog(consoleLogs, {
        at: new Date().toISOString(),
        type: msg.type(),
        text: clipText(msg.text(), 1200),
      });
    };
    onPageError = (error) => {
      pushLog(pageErrors, {
        at: new Date().toISOString(),
        text: clipText(error?.stack || error?.message || String(error), 2000),
      }, 50);
    };
    gmatPage.on('console', onConsole);
    gmatPage.on('pageerror', onPageError);

    const scraperIsLoaded = await gmatPage.evaluate(() => typeof window.runScraper === 'function');
    if (!scraperIsLoaded) {
      await gmatPage.addScriptTag({ content: scraperSource });
    }

    if (options.autoDetectClientId !== false) {
      runtimeConfig.clientId = await inferClientId(gmatPage, runtimeConfig.clientId);
    }
    if (options.autoDetectReviewCategoryId || !options.reviewCategoryId) {
      runtimeConfig.reviewCategoryId = await inferReviewCategoryId(
        gmatPage,
        runtimeConfig,
        runtimeConfig.reviewCategoryId
      );
    }

    const data = await gmatPage.evaluate(async (cfg) => {
      if (typeof window.runScraper !== 'function') {
        throw new Error('runScraper is not available in the page context.');
      }

      const result = await window.runScraper(cfg);
      return JSON.parse(JSON.stringify(result));
    }, runtimeConfig);

    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    const diagnostics = {
      sessions: sessions.length,
      questions: sessions.reduce((sum, session) => sum + Number(session?.stats?.total_q_api || 0), 0),
      errors: sessions.reduce((sum, session) => sum + Number(session?.stats?.errors || 0), 0),
      extractedAt: data?.extracted_at || null,
    };
    const warningCount = consoleLogs.filter(
      (row) => row.type === 'warning' || /⚠️|skipped/i.test(String(row.text || ''))
    ).length;

    return {
      data,
      tabUrl: gmatPage.url(),
      debug: {
        startedAt,
        finishedAt: new Date().toISOString(),
        cdpUrl: connectedCdpUrl,
        requestedCdpUrl,
        attemptedCdpUrls,
        cdpFallbackUsed,
        appSlug,
        sourceNavigation,
        runtimeConfig,
        diagnostics,
        warningCount,
        consoleLogs,
        pageErrors,
      },
    };
  } catch (error) {
    if (Array.isArray(error?.cdpAttemptedUrls) && error.cdpAttemptedUrls.length) {
      attemptedCdpUrls = error.cdpAttemptedUrls;
    }
    error.scrapeDebug = {
      startedAt,
      finishedAt: new Date().toISOString(),
      cdpUrl: connectedCdpUrl,
      requestedCdpUrl,
      attemptedCdpUrls,
      cdpFallbackUsed,
      cdpAttemptErrors: Array.isArray(error?.cdpAttemptErrors) ? error.cdpAttemptErrors : [],
      appSlug,
      sourceNavigation,
      runtimeConfig,
      consoleLogs,
      pageErrors,
      tabUrl: gmatPage?.url?.() || null,
    };
    throw error;
  } finally {
    if (gmatPage && onConsole) gmatPage.off('console', onConsole);
    if (gmatPage && onPageError) gmatPage.off('pageerror', onPageError);
    if (browser) await browser.close();
  }
}

async function openUrlInOpenBrowser(options = {}) {
  const requestedCdpUrl = options.cdpUrl || process.env.CHROME_CDP_URL || 'http://localhost:9222';
  const targetUrl = String(options.url || '').trim();
  const appUrlHint = String(options.appUrl || '').trim();
  if (!targetUrl) {
    throw new Error('Missing target URL.');
  }

  let browser = null;
  let connectedCdpUrl = requestedCdpUrl;
  let attemptedCdpUrls = [requestedCdpUrl];
  let cdpFallbackUsed = false;
  let page = null;
  try {
    const cdpConnection = await connectBrowserOverCdp(requestedCdpUrl);
    browser = cdpConnection.browser;
    connectedCdpUrl = cdpConnection.connectedUrl;
    attemptedCdpUrls = cdpConnection.attemptedUrls;
    cdpFallbackUsed = cdpConnection.fallbackUsed;

    const contexts = browser.contexts();
    const pages = contexts.flatMap((ctx) => ctx.pages());
    const gmatPages = pages.filter((entry) => /gmatofficialpractice\.mba\.com/i.test(entry.url()));
    const appPage = gmatPages.find((entry) => {
      const parsed = parseUrlSafe(entry.url());
      return parsed ? isAppPath(parsed.pathname) : false;
    });
    const gmatPage = appPage || gmatPages[0] || null;
    const context = gmatPage?.context?.() || contexts[0] || null;

    if (!context) {
      throw new Error('No Chrome browser context found. Open Chrome (CDP) first.');
    }

    const resolvedTargetUrl = resolveNavigationTargetUrl(
      targetUrl,
      gmatPage?.url?.() || appUrlHint
    );

    page = await context.newPage();
    await page.goto(resolvedTargetUrl, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();

    return {
      ok: true,
      openedUrl: page.url(),
      debug: {
        targetUrl,
        resolvedTargetUrl,
        appUrlHint: appUrlHint || null,
        activeGmatPageUrl: gmatPage?.url?.() || null,
        requestedCdpUrl,
        cdpUrl: connectedCdpUrl,
        attemptedCdpUrls,
        cdpFallbackUsed,
      },
    };
  } catch (error) {
    const message = error?.message || String(error);
    const wrapped = new Error(message);
    wrapped.openDebug = {
      requestedCdpUrl,
      cdpUrl: connectedCdpUrl,
      attemptedCdpUrls: Array.isArray(error?.cdpAttemptedUrls) ? error.cdpAttemptedUrls : attemptedCdpUrls,
      cdpFallbackUsed,
      cdpAttemptErrors: Array.isArray(error?.cdpAttemptErrors) ? error.cdpAttemptErrors : [],
      targetUrl,
    };
    throw wrapped;
  } finally {
    if (browser) await browser.close();
  }
}

// ─── StartTest 2 / ITD runners ───────────────────────────────────────────────
// These are for the new practice platform (www.starttest.com). Key differences
// from the old runScrapeFromOpenBrowser:
//   1. Tab pattern matches starttest.com, not gmatofficialpractice.mba.com.
//   2. The scraper is a Node-side module (starttest_scraper.js) — we call its
//      functions directly, no page.evaluate-injection.
//   3. We do NOT call browser.close() anywhere. Playwright's connectOverCDP
//      tears down wrapped contexts on close, which would close the user's
//      logged-in tab and invalidate their StartTest session token. Leaving
//      the WS to disconnect on process exit is the safe alternative.

const {
  SOURCE_PRODUCTS: STARTTEST_SOURCE_PRODUCTS,
  ScrapeAnomalyError: StartTestAnomalyError,
  runPhase1: runStartTestPhase1,
  runPhase2: runStartTestPhase2,
  normalizeProductHeading,
  _internals: startTestInternals,
} = require('./scrapers/starttest_scraper');

const STARTTEST_TAB_RE = /starttest\.com/i;

function findStartTestPage(browser) {
  const pages = browser.contexts().flatMap((ctx) => ctx.pages());
  return pages.find((p) => STARTTEST_TAB_RE.test(p.url())) || null;
}

async function runStartTestScrapeFromOpenBrowser(options = {}) {
  const requestedCdpUrl = options.cdpUrl || process.env.CHROME_CDP_URL || 'http://localhost:9222';
  const sourceId = String(options.sourceId || '').trim();
  const preset = STARTTEST_SOURCE_PRODUCTS[sourceId];
  if (!preset) {
    const err = new Error(`Unknown StartTest sourceId "${sourceId}".`);
    err.statusCode = 400;
    throw err;
  }

  const startedAt = new Date().toISOString();
  const consoleLogs = [];
  const pageErrors = [];
  const progressEvents = [];
  const pushLog = (target, entry, limit = 200) => {
    target.push(entry);
    if (target.length > limit) target.shift();
  };

  let browser = null;
  let connectedCdpUrl = requestedCdpUrl;
  let attemptedCdpUrls = [requestedCdpUrl];
  let cdpFallbackUsed = false;
  let startTestPage = null;
  let onConsole = null;
  let onPageError = null;
  try {
    const cdpConnection = await connectBrowserOverCdp(requestedCdpUrl);
    browser = cdpConnection.browser;
    connectedCdpUrl = cdpConnection.connectedUrl;
    attemptedCdpUrls = cdpConnection.attemptedUrls;
    cdpFallbackUsed = cdpConnection.fallbackUsed;

    startTestPage = findStartTestPage(browser);
    if (!startTestPage) {
      throw new Error(
        `No starttest.com tab found. Open https://www.mba.com/my-account and sign in, then open GMAT practice — it will redirect to starttest.com. Keep that tab open.`
      );
    }
    startTestPage.setDefaultTimeout(0);
    await startTestPage.bringToFront();
    await startTestPage.waitForLoadState('domcontentloaded');

    onConsole = (msg) => pushLog(consoleLogs, {
      at: new Date().toISOString(),
      type: msg.type(),
      text: clipText(msg.text(), 1200),
    });
    onPageError = (error) => pushLog(pageErrors, {
      at: new Date().toISOString(),
      text: clipText(error?.stack || error?.message || String(error), 2000),
    }, 50);
    startTestPage.on('console', onConsole);
    startTestPage.on('pageerror', onPageError);

    const data = await runStartTestPhase1({
      page: startTestPage,
      options: {
        sourceId,
        since: options.since || null,
        sessionSids: Array.isArray(options.sessionSids) ? options.sessionSids : null,
        onProgress: (evt) => pushLog(progressEvents, { at: new Date().toISOString(), ...evt }, 400),
      },
    });

    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    const diagnostics = {
      sessions: sessions.length,
      questions: sessions.reduce((sum, s) => sum + (s.stats?.total_q_api || 0), 0),
      errors: sessions.reduce((sum, s) => sum + (s.stats?.errors || 0), 0),
      extractedAt: data?.extracted_at || null,
      warnings: Array.isArray(data?.warnings) ? data.warnings.length : 0,
    };

    return {
      data,
      tabUrl: startTestPage.url(),
      debug: {
        startedAt,
        finishedAt: new Date().toISOString(),
        cdpUrl: connectedCdpUrl,
        requestedCdpUrl,
        attemptedCdpUrls,
        cdpFallbackUsed,
        sourceId,
        productLabel: preset.label,
        productId: preset.productId,
        diagnostics,
        progressEvents,
        consoleLogs,
        pageErrors,
      },
    };
  } catch (error) {
    if (Array.isArray(error?.cdpAttemptedUrls) && error.cdpAttemptedUrls.length) {
      attemptedCdpUrls = error.cdpAttemptedUrls;
    }
    error.scrapeDebug = {
      startedAt,
      finishedAt: new Date().toISOString(),
      cdpUrl: connectedCdpUrl,
      requestedCdpUrl,
      attemptedCdpUrls,
      cdpFallbackUsed,
      sourceId,
      tabUrl: startTestPage?.url?.() || null,
      progressEvents,
      consoleLogs,
      pageErrors,
      anomaly: error instanceof StartTestAnomalyError
        ? { name: error.name, url: error.url, snippet: error.snippet }
        : null,
    };
    throw error;
  } finally {
    if (startTestPage && onConsole) startTestPage.off('console', onConsole);
    if (startTestPage && onPageError) startTestPage.off('pageerror', onPageError);
    // Intentionally DO NOT call browser.close() — it would tear down the user's
    // logged-in StartTest tab and force a re-login. Let the WS disconnect on exit.
  }
}

async function openStartTestProductInOpenBrowser(options = {}) {
  const requestedCdpUrl = options.cdpUrl || process.env.CHROME_CDP_URL || 'http://localhost:9222';
  const sourceId = String(options.sourceId || '').trim();
  const preset = STARTTEST_SOURCE_PRODUCTS[sourceId];
  if (!preset) {
    const err = new Error(`Unknown StartTest sourceId "${sourceId}".`);
    err.statusCode = 400;
    throw err;
  }

  let browser = null;
  let connectedCdpUrl = requestedCdpUrl;
  let attemptedCdpUrls = [requestedCdpUrl];
  let cdpFallbackUsed = false;
  let startTestPage = null;
  try {
    const cdpConnection = await connectBrowserOverCdp(requestedCdpUrl);
    browser = cdpConnection.browser;
    connectedCdpUrl = cdpConnection.connectedUrl;
    attemptedCdpUrls = cdpConnection.attemptedUrls;
    cdpFallbackUsed = cdpConnection.fallbackUsed;

    startTestPage = findStartTestPage(browser);
    if (!startTestPage) {
      throw new Error(
        `No starttest.com tab found. Open https://www.mba.com/my-account and sign in, then open GMAT practice to get a logged-in tab.`
      );
    }
    await startTestPage.bringToFront();
    await startTestPage.waitForLoadState('domcontentloaded');

    await startTestInternals.navigateToProduct(startTestPage, preset.productId, preset.type);

    const heading = await startTestPage.evaluate(
      () => (document.querySelector('#PgHdngPracticeDash')?.innerText || '').trim()
    );

    return {
      ok: true,
      sourceId,
      productLabel: preset.label,
      expectedHeading: preset.productName,
      activeHeading: heading || null,
      matches: heading && preset.productName
        ? normalizeProductHeading(heading) === normalizeProductHeading(preset.productName)
        : null,
      tabUrl: startTestPage.url(),
      debug: {
        requestedCdpUrl,
        cdpUrl: connectedCdpUrl,
        attemptedCdpUrls,
        cdpFallbackUsed,
      },
    };
  } catch (error) {
    const message = error?.message || String(error);
    const wrapped = new Error(message);
    wrapped.openDebug = {
      requestedCdpUrl,
      cdpUrl: connectedCdpUrl,
      attemptedCdpUrls: Array.isArray(error?.cdpAttemptedUrls) ? error.cdpAttemptedUrls : attemptedCdpUrls,
      cdpFallbackUsed,
      cdpAttemptErrors: Array.isArray(error?.cdpAttemptErrors) ? error.cdpAttemptErrors : [],
      sourceId,
      tabUrl: startTestPage?.url?.() || null,
    };
    throw wrapped;
  }
  // No `finally { browser.close() }` — same reason as above.
}

// Phase 2: per-session deep enrichment. Same no-close discipline.
// Long-running (~3–5 minutes for 20 items at jittered pacing). Caller is
// expected to handle async/progress UX — server.js exposes this behind a
// dedicated endpoint and times out generously.
async function runStartTestPhase2FromOpenBrowser(options = {}) {
  const requestedCdpUrl = options.cdpUrl || process.env.CHROME_CDP_URL || 'http://localhost:9222';
  const sourceId = String(options.sourceId || '').trim();
  const preset = STARTTEST_SOURCE_PRODUCTS[sourceId];
  if (!preset) {
    const err = new Error(`Unknown StartTest sourceId "${sourceId}".`);
    err.statusCode = 400;
    throw err;
  }
  const sid = String(options.sid || '').trim();
  if (!sid) {
    const err = new Error('Phase 2 requires sid.');
    err.statusCode = 400;
    throw err;
  }

  const startedAt = new Date().toISOString();
  const consoleLogs = [];
  const pageErrors = [];
  const progressEvents = [];
  const pushLog = (target, entry, limit = 800) => {
    target.push(entry);
    if (target.length > limit) target.shift();
  };

  let browser = null;
  let connectedCdpUrl = requestedCdpUrl;
  let attemptedCdpUrls = [requestedCdpUrl];
  let cdpFallbackUsed = false;
  let startTestPage = null;
  let onConsole = null;
  let onPageError = null;
  try {
    const cdpConnection = await connectBrowserOverCdp(requestedCdpUrl);
    browser = cdpConnection.browser;
    connectedCdpUrl = cdpConnection.connectedUrl;
    attemptedCdpUrls = cdpConnection.attemptedUrls;
    cdpFallbackUsed = cdpConnection.fallbackUsed;

    startTestPage = findStartTestPage(browser);
    if (!startTestPage) {
      throw new Error(
        `No starttest.com tab found. Open GMAT practice in your logged-in tab first.`
      );
    }
    startTestPage.setDefaultTimeout(0);
    await startTestPage.bringToFront();
    await startTestPage.waitForLoadState('domcontentloaded');

    onConsole = (msg) => pushLog(consoleLogs, {
      at: new Date().toISOString(),
      type: msg.type(),
      text: clipText(msg.text(), 1200),
    });
    onPageError = (error) => pushLog(pageErrors, {
      at: new Date().toISOString(),
      text: clipText(error?.stack || error?.message || String(error), 2000),
    }, 50);
    startTestPage.on('console', onConsole);
    startTestPage.on('pageerror', onPageError);

    const result = await runStartTestPhase2({
      page: startTestPage,
      options: {
        sourceId,
        sid,
        totalQ: Number(options.totalQ) || 0,
        minDelayMs: Number(options.minDelayMs) || 3000,
        maxDelayMs: Number(options.maxDelayMs) || 6000,
        onProgress: (evt) => pushLog(progressEvents, { at: new Date().toISOString(), ...evt }),
      },
    });

    return {
      result,
      tabUrl: startTestPage.url(),
      debug: {
        startedAt,
        finishedAt: new Date().toISOString(),
        cdpUrl: connectedCdpUrl,
        requestedCdpUrl,
        attemptedCdpUrls,
        cdpFallbackUsed,
        sourceId,
        productLabel: preset.label,
        sid,
        progressEvents,
        consoleLogs,
        pageErrors,
      },
    };
  } catch (error) {
    if (Array.isArray(error?.cdpAttemptedUrls) && error.cdpAttemptedUrls.length) {
      attemptedCdpUrls = error.cdpAttemptedUrls;
    }
    error.scrapeDebug = {
      startedAt,
      finishedAt: new Date().toISOString(),
      cdpUrl: connectedCdpUrl,
      requestedCdpUrl,
      attemptedCdpUrls,
      cdpFallbackUsed,
      sourceId,
      sid,
      tabUrl: startTestPage?.url?.() || null,
      progressEvents,
      consoleLogs,
      pageErrors,
      anomaly: error instanceof StartTestAnomalyError
        ? { name: error.name, url: error.url, snippet: error.snippet }
        : null,
    };
    throw error;
  } finally {
    if (startTestPage && onConsole) startTestPage.off('console', onConsole);
    if (startTestPage && onPageError) startTestPage.off('pageerror', onPageError);
    // Same no-close discipline.
  }
}

// Phase 2 for GMAT Club: visits each topic URL one at a time on the existing
// gmatclub.com tab and runs `window.gmatClubEnrichCurrentPage()` to extract
// the stem, choices, and revealed official-answer letter.
async function runGmatClubPhase2FromOpenBrowser(options = {}) {
  const requestedCdpUrl = options.cdpUrl || process.env.CHROME_CDP_URL || 'http://localhost:9222';
  const targets = Array.isArray(options.targets) ? options.targets : [];
  if (!targets.length) {
    const err = new Error('Phase 2 requires at least one target { url, q_id }.');
    err.statusCode = 400;
    throw err;
  }
  const minDelayMs = Number.isFinite(Number(options.minDelayMs)) ? Number(options.minDelayMs) : 1500;
  const maxDelayMs = Number.isFinite(Number(options.maxDelayMs)) ? Number(options.maxDelayMs) : 3000;

  const startedAt = new Date().toISOString();
  const consoleLogs = [];
  const pageErrors = [];
  const progressEvents = [];
  const pushLog = (target, entry, limit = 800) => {
    target.push(entry);
    if (target.length > limit) target.shift();
  };

  let browser = null;
  let connectedCdpUrl = requestedCdpUrl;
  let attemptedCdpUrls = [requestedCdpUrl];
  let cdpFallbackUsed = false;
  let page = null;
  let onConsole = null;
  let onPageError = null;

  const scraperSource = await loadScraperSource(
    path.resolve(__dirname, 'scrapers', 'gmat_club_question_scraper.js')
  );

  try {
    const cdpConnection = await connectBrowserOverCdp(requestedCdpUrl);
    browser = cdpConnection.browser;
    connectedCdpUrl = cdpConnection.connectedUrl;
    attemptedCdpUrls = cdpConnection.attemptedUrls;
    cdpFallbackUsed = cdpConnection.fallbackUsed;

    const pages = browser.contexts().flatMap((ctx) => ctx.pages());
    page = pages.find((p) => /gmatclub\.com/i.test(p.url()))
      || pages.find((p) => p.url() === 'about:blank')
      || pages[0];
    if (!page) {
      throw new Error('No gmatclub.com tab found. Open GMAT Club in your logged-in tab first.');
    }
    page.setDefaultTimeout(0);
    await page.bringToFront();

    onConsole = (msg) => pushLog(consoleLogs, {
      at: new Date().toISOString(),
      type: msg.type(),
      text: clipText(msg.text(), 1200),
    });
    onPageError = (error) => pushLog(pageErrors, {
      at: new Date().toISOString(),
      text: clipText(error?.stack || error?.message || String(error), 2000),
    }, 50);
    page.on('console', onConsole);
    page.on('pageerror', onPageError);

    const items = [];
    const errors = [];
    let aborted = false;
    let abortReason = null;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const url = String(target?.url || '').trim();
      const qId = target?.q_id || null;
      if (!url || !/^https?:\/\/(?:www\.)?gmatclub\.com\//i.test(url)) {
        errors.push({ q_id: qId, url, reason: 'invalid-url' });
        continue;
      }
      pushLog(progressEvents, { at: new Date().toISOString(), kind: 'navigate', i, total: targets.length, url });

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // Wait for the OP body to materialize. GMAT Club lazy-loads inline.
        await page.waitForSelector('.item.text', { timeout: 10000 }).catch(() => null);
        // Make sure the script is loaded (re-inject after each navigation).
        await page.addScriptTag({ content: scraperSource });
        const result = await page.evaluate(() => {
          if (typeof window.gmatClubEnrichCurrentPage !== 'function') {
            return { ok: false, reason: 'scraper-not-loaded' };
          }
          return window.gmatClubEnrichCurrentPage();
        });
        if (!result?.ok) {
          errors.push({ q_id: qId, url, reason: result?.reason || 'unknown', finalUrl: result?.url || page.url() });
          continue;
        }
        items.push({
          q_id: qId,
          q_code: target?.q_code || null,
          source_url: url,
          final_url: result.url || page.url(),
          title: result.title || '',
          stem: result.stem || '',
          choices: Array.isArray(result.choices) ? result.choices : [],
          correct_answer: result.correct_answer || null,
          my_answer: result.my_answer || null,
          answer_distribution: Array.isArray(result.answer_distribution) ? result.answer_distribution : [],
        });

        // Human-like jitter between visits to avoid hammering GMAT Club.
        if (i < targets.length - 1) {
          const delay = Math.round(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
          await page.waitForTimeout(delay);
        }
      } catch (err) {
        errors.push({
          q_id: qId,
          url,
          reason: clipText(err?.message || String(err), 200),
        });
        if (errors.length >= Math.max(5, Math.ceil(targets.length / 4))) {
          aborted = true;
          abortReason = 'too-many-errors';
          break;
        }
      }
    }

    return {
      result: { items, errors, qhTotal: targets.length, aborted, abortReason },
      tabUrl: page.url(),
      debug: {
        startedAt,
        finishedAt: new Date().toISOString(),
        cdpUrl: connectedCdpUrl,
        requestedCdpUrl,
        attemptedCdpUrls,
        cdpFallbackUsed,
        targetCount: targets.length,
        progressEvents,
        consoleLogs,
        pageErrors,
      },
    };
  } catch (error) {
    error.scrapeDebug = {
      startedAt,
      finishedAt: new Date().toISOString(),
      cdpUrl: connectedCdpUrl,
      requestedCdpUrl,
      attemptedCdpUrls,
      cdpFallbackUsed,
      tabUrl: page?.url?.() || null,
      progressEvents,
      consoleLogs,
      pageErrors,
    };
    throw error;
  } finally {
    if (page && onConsole) page.off('console', onConsole);
    if (page && onPageError) page.off('pageerror', onPageError);
    // No browser.close() — same discipline as other runners.
  }
}

module.exports = {
  openUrlInOpenBrowser,
  runScrapeFromOpenBrowser,
  runStartTestScrapeFromOpenBrowser,
  runStartTestPhase2FromOpenBrowser,
  runGmatClubPhase2FromOpenBrowser,
  openStartTestProductInOpenBrowser,
  STARTTEST_SOURCE_PRODUCTS,
};
