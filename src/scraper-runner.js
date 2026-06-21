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

    if (/gmatclub\.com/i.test(gmatPage.url())) {
      await navigateGmatClubHomeSafe(gmatPage);
    }

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

const {
  SECTION_PRESETS: TTP_SECTION_PRESETS,
  ScrapeAnomalyError: TtpAnomalyError,
  runScrape: runTtpScrape,
} = require('./scrapers/ttp_scraper');

const {
  runScrape: runGmatClubCatScrape,
  ScrapeAnomalyError: GmatClubCatAnomalyError,
} = require('./scrapers/gmat_club_cat_scraper');

const STARTTEST_TAB_RE = /starttest\.com/i;
const TTP_TAB_RE = /gmat\.targettestprep\.com/i;
const GMATCLUB_HOME_URL = 'https://gmatclub.com/forum/analytics.php#error_log';

function findStartTestPage(browser) {
  const pages = browser.contexts().flatMap((ctx) => ctx.pages());
  return pages.find((p) => STARTTEST_TAB_RE.test(p.url())) || null;
}

// Best-effort post-run navigation back to the platform's "home" so the user's
// tab is left in a clean state. Swallows errors — a failed nav must not
// override a successful scrape return value.
async function navigateStartTestHomeSafe(page) {
  if (!page) return;
  try {
    await startTestInternals.navigateHome(page);
  } catch (_error) {
    // Intentional: nav-home is a UX nicety, not a contract.
  }
}

async function navigateGmatClubHomeSafe(page) {
  if (!page) return;
  try {
    await page.goto(GMATCLUB_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (_error) {
    // Intentional: nav-home is a UX nicety, not a contract.
  }
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

    await navigateStartTestHomeSafe(startTestPage);

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

    await navigateStartTestHomeSafe(startTestPage);

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

    // Group targets by URL so that an RC topic (whose page lists 5-6 questions
    // sharing the same topic id) is visited once instead of once per question.
    // Within each group, sort by the numeric attempt id ascending — that lines
    // up with the user's chronological attempt order on GMAT Club, which in
    // turn lines up with question position 1..N for users who answered the
    // RC set in document order (the common case).
    const numericAttemptId = (qId) => {
      const m = String(qId || '').match(/(\d+)$/);
      return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
    };
    const groupedByUrl = new Map();
    for (const t of targets) {
      const url = String(t?.url || '').trim();
      if (!url) {
        errors.push({ q_id: t?.q_id || null, url: '', reason: 'invalid-url' });
        continue;
      }
      if (!groupedByUrl.has(url)) groupedByUrl.set(url, []);
      groupedByUrl.get(url).push(t);
    }
    for (const arr of groupedByUrl.values()) {
      arr.sort((a, b) => numericAttemptId(a.q_id) - numericAttemptId(b.q_id));
    }
    const urls = Array.from(groupedByUrl.keys());

    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      const group = groupedByUrl.get(url);
      const groupQIds = group.map((t) => t.q_id || null);
      if (!/^https?:\/\/(?:www\.)?gmatclub\.com\//i.test(url)) {
        for (const t of group) errors.push({ q_id: t.q_id || null, url, reason: 'invalid-url' });
        continue;
      }
      pushLog(progressEvents, { at: new Date().toISOString(), kind: 'navigate', i, total: urls.length, url, groupSize: group.length });

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
          for (const t of group) {
            errors.push({ q_id: t.q_id || null, url, reason: result?.reason || 'unknown', finalUrl: result?.url || page.url() });
          }
          continue;
        }

        const finalUrl = result.url || page.url();
        const layout = result.layout || 'single';

        if (layout === 'rc' && Array.isArray(result.questions) && result.questions.length) {
          const passage = result.passage || '';
          const qs = result.questions;
          // Pair attempt rows (sorted oldest→newest) to questions 1..N. If
          // the row count exceeds the question count, extra rows still get
          // the passage but no per-question stem/choices (better than nothing).
          for (let j = 0; j < group.length; j += 1) {
            const t = group[j];
            const q = qs[j] || null;
            items.push({
              q_id: t.q_id || null,
              q_code: t.q_code || null,
              source_url: url,
              final_url: finalUrl,
              title: result.title || '',
              passage_text: passage,
              rc_position: q ? q.position : null,
              rc_question_count: qs.length,
              rc_attempt_count: group.length,
              stem: q?.stem || '',
              choices: q && Array.isArray(q.choices) ? q.choices : [],
              correct_answer: q?.correct_answer || null,
              my_answer: q?.my_answer || null,
              answer_distribution: q && Array.isArray(q.answer_distribution) ? q.answer_distribution : [],
            });
          }
          pushLog(progressEvents, { at: new Date().toISOString(), kind: 'rc-paired', url, attempts: group.length, questionsOnPage: qs.length });
        } else {
          // Single-question (CR / standalone PS / etc.). Emit one item per
          // attempt row in the group — multiple attempts at the same CR
          // question all share the same content but each needs its own DB
          // update.
          for (const t of group) {
            items.push({
              q_id: t.q_id || null,
              q_code: t.q_code || null,
              source_url: url,
              final_url: finalUrl,
              title: result.title || '',
              passage_text: '',
              rc_position: null,
              rc_question_count: null,
              rc_attempt_count: group.length,
              stem: result.stem || '',
              choices: Array.isArray(result.choices) ? result.choices : [],
              correct_answer: result.correct_answer || null,
              my_answer: result.my_answer || null,
              answer_distribution: Array.isArray(result.answer_distribution) ? result.answer_distribution : [],
            });
          }
        }

        // Human-like jitter between visits to avoid hammering GMAT Club.
        if (i < urls.length - 1) {
          const delay = Math.round(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
          await page.waitForTimeout(delay);
        }
      } catch (err) {
        for (const t of group) {
          errors.push({
            q_id: t.q_id || null,
            url,
            reason: clipText(err?.message || String(err), 200),
          });
        }
        if (errors.length >= Math.max(5, Math.ceil(targets.length / 4))) {
          aborted = true;
          abortReason = 'too-many-errors';
          break;
        }
      }
    }

    await navigateGmatClubHomeSafe(page);

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

// ─── Target Test Prep runner ────────────────────────────────────────────────
// Single-pass scrape: visits the section index, then walks each mistake
// category's `?page=N` URLs. The TTP error tracker is fully cumulative (no
// since-date concept on the page), so the `since` parameter is currently
// unused — the user filters the resulting rows in the dashboard.
//
// Same no-close discipline as the other CDP-attached runners.

function findTtpPage(browser) {
  const pages = browser.contexts().flatMap((ctx) => ctx.pages());
  return pages.find((p) => TTP_TAB_RE.test(p.url())) || null;
}

async function runTtpScrapeFromOpenBrowser(options = {}) {
  const requestedCdpUrl = options.cdpUrl || process.env.CHROME_CDP_URL || 'http://localhost:9222';
  const sourceId = String(options.sourceId || '').trim();
  const preset = TTP_SECTION_PRESETS[sourceId];
  if (!preset) {
    const err = new Error(`Unknown TTP sourceId "${sourceId}".`);
    err.statusCode = 400;
    throw err;
  }

  const startedAt = new Date().toISOString();
  const consoleLogs = [];
  const pageErrors = [];
  const progressEvents = [];
  const pushLog = (target, entry, limit = 400) => {
    target.push(entry);
    if (target.length > limit) target.shift();
  };

  let browser = null;
  let connectedCdpUrl = requestedCdpUrl;
  let attemptedCdpUrls = [requestedCdpUrl];
  let cdpFallbackUsed = false;
  let ttpPage = null;
  let onConsole = null;
  let onPageError = null;
  try {
    const cdpConnection = await connectBrowserOverCdp(requestedCdpUrl);
    browser = cdpConnection.browser;
    connectedCdpUrl = cdpConnection.connectedUrl;
    attemptedCdpUrls = cdpConnection.attemptedUrls;
    cdpFallbackUsed = cdpConnection.fallbackUsed;

    ttpPage = findTtpPage(browser);
    if (!ttpPage) {
      throw new Error(
        `No gmat.targettestprep.com tab found. Open https://gmat.targettestprep.com/error_tracker/${preset.section} and sign in, then keep that tab open.`
      );
    }
    ttpPage.setDefaultTimeout(0);
    await ttpPage.bringToFront();
    await ttpPage.waitForLoadState('domcontentloaded');

    onConsole = (msg) => pushLog(consoleLogs, {
      at: new Date().toISOString(),
      type: msg.type(),
      text: clipText(msg.text(), 1200),
    });
    onPageError = (error) => pushLog(pageErrors, {
      at: new Date().toISOString(),
      text: clipText(error?.stack || error?.message || String(error), 2000),
    }, 50);
    ttpPage.on('console', onConsole);
    ttpPage.on('pageerror', onPageError);

    const data = await runTtpScrape({
      page: ttpPage,
      options: {
        sourceId,
        minDelayMs: Number(options.minDelayMs) || 1500,
        maxDelayMs: Number(options.maxDelayMs) || 3000,
        maxErrors: Number(options.maxErrors) || 0,
        onProgress: (evt) => pushLog(progressEvents, { at: new Date().toISOString(), ...evt }, 800),
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
      tabUrl: ttpPage.url(),
      debug: {
        startedAt,
        finishedAt: new Date().toISOString(),
        cdpUrl: connectedCdpUrl,
        requestedCdpUrl,
        attemptedCdpUrls,
        cdpFallbackUsed,
        sourceId,
        productLabel: preset.label,
        section: preset.section,
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
      tabUrl: ttpPage?.url?.() || null,
      progressEvents,
      consoleLogs,
      pageErrors,
      anomaly: error instanceof TtpAnomalyError
        ? { name: error.name, url: error.url, snippet: error.snippet }
        : null,
    };
    throw error;
  } finally {
    if (ttpPage && onConsole) ttpPage.off('console', onConsole);
    if (ttpPage && onPageError) ttpPage.off('pageerror', onPageError);
    // No browser.close() — preserve the user's logged-in TTP session.
  }
}

async function runGmatClubCatScrapeFromOpenBrowser(options = {}) {
  const requestedCdpUrl = options.cdpUrl || process.env.CHROME_CDP_URL || 'http://localhost:9222';
  const source = options.source || 'GMAT Club CAT';
  const startedAt = new Date().toISOString();
  const consoleLogs = [];
  const pageErrors = [];
  const progressEvents = [];
  const pushLog = (target, entry, limit = 800) => { target.push(entry); if (target.length > limit) target.shift(); };

  let browser = null;
  let connectedCdpUrl = requestedCdpUrl;
  let attemptedCdpUrls = [requestedCdpUrl];
  let cdpFallbackUsed = false;
  let page = null;
  let onConsole = null;
  let onPageError = null;
  try {
    const cdpConnection = await connectBrowserOverCdp(requestedCdpUrl);
    browser = cdpConnection.browser;
    connectedCdpUrl = cdpConnection.connectedUrl;
    attemptedCdpUrls = cdpConnection.attemptedUrls;
    cdpFallbackUsed = cdpConnection.fallbackUsed;

    const pages = browser.contexts().flatMap((ctx) => ctx.pages());
    page = pages.find((p) => /gmatclub\.com/i.test(p.url())) || pages.find((p) => p.url() === 'about:blank') || pages[0];
    if (!page) {
      throw new Error('No gmatclub.com tab found. Open https://gmatclub.com/gmat-focus-tests/?page=tests in your logged-in tab first.');
    }
    page.setDefaultTimeout(0);
    await page.bringToFront();

    onConsole = (msg) => pushLog(consoleLogs, { at: new Date().toISOString(), type: msg.type(), text: clipText(msg.text(), 1200) });
    onPageError = (error) => pushLog(pageErrors, { at: new Date().toISOString(), text: clipText(error?.stack || error?.message || String(error), 2000) }, 50);
    page.on('console', onConsole);
    page.on('pageerror', onPageError);

    const data = await runGmatClubCatScrape({
      page,
      options: {
        since: options.since,
        source,
        minDelayMs: Number(options.minDelayMs) || 1500,
        maxDelayMs: Number(options.maxDelayMs) || 3000,
        onProgress: (evt) => pushLog(progressEvents, { at: new Date().toISOString(), ...evt }, 800),
      },
    });

    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    return {
      data,
      tabUrl: page.url(),
      debug: {
        startedAt, finishedAt: new Date().toISOString(),
        cdpUrl: connectedCdpUrl, requestedCdpUrl, attemptedCdpUrls, cdpFallbackUsed,
        source,
        diagnostics: {
          sessions: sessions.length,
          questions: sessions.reduce((sum, s) => sum + (s.stats?.total_q_api || 0), 0),
          warnings: Array.isArray(data?.warnings) ? data.warnings.length : 0,
        },
        progressEvents, consoleLogs, pageErrors,
      },
    };
  } catch (error) {
    error.scrapeDebug = {
      startedAt, finishedAt: new Date().toISOString(),
      cdpUrl: connectedCdpUrl, requestedCdpUrl, attemptedCdpUrls, cdpFallbackUsed,
      source, tabUrl: page?.url?.() || null,
      progressEvents, consoleLogs, pageErrors,
      anomaly: error instanceof GmatClubCatAnomalyError ? { name: error.name, url: error.url, snippet: error.snippet } : null,
    };
    throw error;
  } finally {
    if (page && onConsole) page.off('console', onConsole);
    if (page && onPageError) page.off('pageerror', onPageError);
    // No browser.close() — preserve the user's logged-in GMAT Club session.
  }
}

async function runGmatClubCatPhase2FromOpenBrowser(options = {}) {
  const requestedCdpUrl = options.cdpUrl || process.env.CHROME_CDP_URL || 'http://localhost:9222';
  const targets = Array.isArray(options.targets) ? options.targets : [];
  if (!targets.length) {
    const err = new Error('Phase 2 requires at least one target { url, q_id }.');
    err.statusCode = 400; throw err;
  }
  const minDelayMs = Number.isFinite(Number(options.minDelayMs)) ? Number(options.minDelayMs) : 1500;
  const maxDelayMs = Number.isFinite(Number(options.maxDelayMs)) ? Number(options.maxDelayMs) : 3000;
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));
  const jit = () => Math.round(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));

  const startedAt = new Date().toISOString();
  const consoleLogs = []; const pageErrors = []; const progressEvents = [];
  const pushLog = (t, e, limit = 800) => { t.push(e); if (t.length > limit) t.shift(); };

  let browser = null; let page = null; let onConsole = null; let onPageError = null;
  const scraperSource = await loadScraperSource(path.resolve(__dirname, 'scrapers', 'gmat_club_cat_question_scraper.js'));
  try {
    const cdp = await connectBrowserOverCdp(requestedCdpUrl);
    browser = cdp.browser;
    const pages = browser.contexts().flatMap((ctx) => ctx.pages());
    page = pages.find((p) => /gmatclub\.com/i.test(p.url())) || pages.find((p) => p.url() === 'about:blank') || pages[0];
    if (!page) throw new Error('No gmatclub.com tab found. Open GMAT Club in your logged-in tab first.');
    page.setDefaultTimeout(0);
    await page.bringToFront();
    onConsole = (msg) => pushLog(consoleLogs, { at: new Date().toISOString(), type: msg.type(), text: clipText(msg.text(), 1200) });
    onPageError = (e) => pushLog(pageErrors, { at: new Date().toISOString(), text: clipText(e?.stack || e?.message || String(e), 2000) }, 50);
    page.on('console', onConsole); page.on('pageerror', onPageError);

    const items = []; const errors = [];
    const maxErrors = Math.max(5, Math.ceil(targets.length / 4));
    for (let i = 0; i < targets.length; i += 1) {
      const t = targets[i];
      const url = String(t?.url || '').trim();
      if (!/^https?:\/\/(?:www\.)?gmatclub\.com\//i.test(url)) { errors.push({ q_id: t?.q_id || null, url, reason: 'invalid-url' }); continue; }
      pushLog(progressEvents, { at: new Date().toISOString(), kind: 'navigate', i, total: targets.length, url });
      try {
        await sleepMs(jit());
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const hasOptions = await page.waitForSelector('.option', { timeout: 10000 }).catch(() => null);
        // The official answer letter lives in a `.correctAnswer` span that is
        // EMPTY until the explanation is expanded. On MC pages, expand it (click
        // the "Show Explanation"/"Show Answer" control) if no letter is present
        // yet, then wait for the letter to populate. Non-MC DI formats
        // (TPA/MSR/TA/GI) have no `.option` and are skipped — they'd just burn
        // the timeout.
        if (hasOptions) {
          await page.evaluate(() => {
            const hasLetter = Array.from(document.querySelectorAll('.correctAnswer'))
              .some((e) => /^[A-H]$/.test((e.textContent || '').trim()));
            if (!hasLetter) {
              const btn = Array.from(document.querySelectorAll('button,a,div,span'))
                .find((e) => /^\s*(show explanation|show answer)\s*$/i.test((e.textContent || '').trim()));
              if (btn) btn.click();
            }
          }).catch(() => null);
          await page.waitForFunction(
            () => Array.from(document.querySelectorAll('.correctAnswer')).some((e) => /^[A-H]$/.test((e.textContent || '').trim())),
            { timeout: 5000 }
          ).catch(() => null);
        }
        await page.addScriptTag({ content: scraperSource });
        const result = await page.evaluate(() => (typeof window.gmatClubCatEnrichCurrentPage === 'function'
          ? window.gmatClubCatEnrichCurrentPage() : { ok: false, reason: 'scraper-not-loaded' }));
        if (!result?.ok) { errors.push({ q_id: t.q_id || null, url, reason: result?.reason || 'unknown' });
          if (errors.length > maxErrors) throw new Error(`Too many Phase 2 errors (${errors.length}); aborting.`);
          continue; }
        items.push({
          q_id: t.q_id || null,
          stem: result.stem || '',
          choices: Array.isArray(result.choices) ? result.choices : [],
          correct_answer: result.correct_answer || '',
          my_answer: result.my_answer || '',
          explanation: result.explanation || '',
          final_url: result.url || page.url(),
        });
      } catch (err) {
        errors.push({ q_id: t.q_id || null, url, reason: err.message });
        if (errors.length > maxErrors) throw err;
      }
    }
    return {
      result: { items, errors },
      debug: { startedAt, finishedAt: new Date().toISOString(), cdpUrl: cdp.connectedUrl, targets: targets.length, progressEvents, consoleLogs, pageErrors },
    };
  } finally {
    if (page && onConsole) page.off('console', onConsole);
    if (page && onPageError) page.off('pageerror', onPageError);
    // No browser.close().
  }
}

// ─── OPE Mock scraper runners ──────────────────────────────────────────────
// Two-step UX: (1) list takes for the chosen OPE so the user picks one,
// (2) scrape that take's Score Report. The user must have the OPE landing
// page open in their CDP-attached Chrome (or any starttest.com tab — we
// navigate to the landing if needed). The Score Report popup is opened by
// the runner via a single launchitdwindow click that mints a fresh SVC.

const opeScraper = require('./scrapers/ope_mock_scraper.js');

async function runOpeListAttemptsFromOpenBrowser(options = {}) {
  const requestedCdpUrl = options.cdpUrl || process.env.CHROME_CDP_URL || 'http://localhost:9222';
  const sourceId = String(options.sourceId || '').trim();
  const preset = opeScraper.SOURCE_PRODUCTS[sourceId];
  if (!preset) {
    const err = new Error(`Unknown OPE sourceId "${sourceId}".`);
    err.statusCode = 400;
    throw err;
  }
  const startedAt = new Date().toISOString();
  let browser = null;
  try {
    const cdp = await connectBrowserOverCdp(requestedCdpUrl);
    browser = cdp.browser;
    const landing = findStartTestPage(browser);
    if (!landing) {
      throw new Error(
        'No starttest.com tab found. Sign in via mba.com and open the GMAT practice area first.',
      );
    }
    await landing.bringToFront();
    const takes = await opeScraper.listOpeAttemptsForProduct(landing, {
      productId: preset.productId,
      type: preset.type,
    });
    return {
      sourceId,
      sourceLabel: preset.label,
      productId: preset.productId,
      takes,
      tabUrl: landing.url(),
      debug: {
        startedAt,
        finishedAt: new Date().toISOString(),
        cdpUrl: cdp.connectedUrl,
      },
    };
  } finally {
    void browser;
  }
}

async function runOpeMockScrapeFromOpenBrowser(options = {}) {
  const requestedCdpUrl = options.cdpUrl || process.env.CHROME_CDP_URL || 'http://localhost:9222';
  const sourceId = String(options.sourceId || '').trim();
  const takeIdx = Number(options.takeIdx);
  const preset = opeScraper.SOURCE_PRODUCTS[sourceId];
  if (!preset) {
    const err = new Error(`Unknown OPE sourceId "${sourceId}".`);
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isInteger(takeIdx) || takeIdx < 1) {
    const err = new Error(`takeIdx must be a positive integer (got ${options.takeIdx}).`);
    err.statusCode = 400;
    throw err;
  }
  const startedAt = new Date().toISOString();
  let browser = null;
  let popup = null;
  let popupOpenedByUs = false;
  let landing = null;
  const verificationAttempts = [];
  const closedStalePopups = [];
  try {
    const cdp = await connectBrowserOverCdp(requestedCdpUrl);
    browser = cdp.browser;

    // Locate landing tab (must NOT be the ITDStart popup — both match the
    // starttest.com regex). We need the landing for both the completed-date
    // lookup and for verifying any already-open popup against the requested
    // takeIdx.
    const allPages = browser.contexts().flatMap((c) => c.pages());
    landing = allPages.find(
      (p) => STARTTEST_TAB_RE.test(p.url()) && !/ITDStart\.aspx/i.test(p.url()),
    ) || null;
    if (!landing) {
      throw new Error(
        'No starttest.com tab found. Sign in via mba.com first and open the OPE area.',
      );
    }
    await landing.bringToFront();

    // Read the take list BEFORE opening any popup. The `View Score Report`
    // click refreshes the landing (data_testtable.urlrefresh) and rotates its
    // `code` token, so reads after that point can fail against a stale token.
    await opeScraper.navigateToOpeLanding(landing, {
      productId: preset.productId,
      type: preset.type,
    });
    const takes = await opeScraper.listOpeAttemptsForProduct(landing, {
      productId: preset.productId,
      type: preset.type,
    });
    const completedDateISO = takes.find((t) => t.takeIdx === takeIdx)?.completedAt || null;

    // Verify any existing ITDStart popup against the requested takeIdx. The
    // old code reused *any* open popup, which silently scraped take-1's data
    // into take-2's session row when the user left an old popup around.
    const existingPopups = allPages.filter((p) => /ITDStart\.aspx/i.test(p.url()));
    for (const candidate of existingPopups) {
      const info = await opeScraper.verifyPopupMatchesTakeIdx(candidate, landing, {
        productId: preset.productId,
        type: preset.type,
        takeIdx,
      }).catch((e) => ({ matches: false, reason: `verify-threw: ${e.message}` }));
      verificationAttempts.push({
        popupUrl: candidate.url(),
        matches: !!info.matches,
        reason: info.reason || null,
        landingDateText: info.landingDateText || null,
        takeGuid: info.identity?.takeGuid || null,
      });
      if (info.matches) {
        popup = candidate;
        break;
      }
    }

    if (!popup) {
      // No popup matches the requested takeIdx — close stale ones so we don't
      // leave the user with multiple Score Report tabs, then open fresh from
      // the landing page deterministically.
      for (const stale of existingPopups) {
        const staleUrl = stale.url();
        try {
          await stale.close({ runBeforeUnload: false });
          closedStalePopups.push(staleUrl);
        } catch (e) {
          closedStalePopups.push(`${staleUrl} (close-failed: ${e.message})`);
        }
      }
      popup = await opeScraper.openTakeScoreReportPopup(landing, { takeIdx, timeoutMs: 30000 });
      popupOpenedByUs = true;
    }
    await popup.bringToFront();
    const result = await opeScraper.scrapeScoreReportPopup(popup, { sourceId, takeIdx });
    const shaped = opeScraper.shapeForSaveScrapeResult(result, { completedDateISO });
    return {
      data: shaped,
      raw: result,
      tabUrl: popup.url(),
      debug: {
        startedAt,
        finishedAt: new Date().toISOString(),
        cdpUrl: cdp.connectedUrl,
        sourceId,
        productLabel: preset.label,
        takeIdx,
        takeGuid: result.takeGuid,
        popupOpenedByUs,
        verificationAttempts,
        closedStalePopups,
      },
    };
  } catch (error) {
    error.scrapeDebug = {
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceId,
      takeIdx,
      tabUrl: popup?.url?.() || landing?.url?.() || null,
      popupOpenedByUs,
      verificationAttempts,
      closedStalePopups,
      anomaly: error instanceof opeScraper.ScrapeAnomalyError
        ? { name: error.name, url: error.url, snippet: error.snippet }
        : null,
    };
    throw error;
  } finally {
    void browser;
  }
}

// OPE Phase 3 enrichment runner. Drives enrichment from the OPE landing page
// deterministically — `navigateToOpeLanding` + `openTakeScoreReportPopup` for
// the requested takeIdx. If the user already has a popup open we verify it
// matches the requested take (via Score Card Test Date ↔ landing row date)
// and reuse it; otherwise stale ITDStart popups are closed before we open a
// fresh one. The popup's takeGuid is captured at verification time and passed
// as `expectedTakeGuid` so `scrapeAttemptPhase3` can reject if the popup
// rotates underneath us before the 64-item walk completes.
async function runOpePhase3FromOpenBrowser(options = {}) {
  const requestedCdpUrl = options.cdpUrl || process.env.CHROME_CDP_URL || 'http://localhost:9222';
  const sourceId = String(options.sourceId || '').trim();
  const takeIdx = Number(options.takeIdx);
  const expectedTotal = Number(options.expectedTotal) || 64;
  const preset = opeScraper.SOURCE_PRODUCTS[sourceId];
  if (!preset) {
    const err = new Error(`Unknown OPE sourceId "${sourceId}".`);
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isInteger(takeIdx) || takeIdx < 1) {
    const err = new Error(`takeIdx must be a positive integer (got ${options.takeIdx}).`);
    err.statusCode = 400;
    throw err;
  }
  const startedAt = new Date().toISOString();
  const progressEvents = [];
  let browser = null;
  let popup = null;
  let popupOpenedByUs = false;
  let popupTakeGuid = null;
  const verificationAttempts = [];
  const closedStalePopups = [];
  try {
    const cdp = await connectBrowserOverCdp(requestedCdpUrl);
    browser = cdp.browser;

    // The landing must be a non-popup starttest.com tab — ITDStart.aspx URLs
    // also match the starttest.com regex, so be explicit here.
    const allPages = browser.contexts().flatMap((c) => c.pages());
    const landing = allPages.find(
      (p) => STARTTEST_TAB_RE.test(p.url()) && !/ITDStart\.aspx/i.test(p.url()),
    ) || null;
    if (!landing) {
      throw new Error('No starttest.com tab found. Sign in and open the OPE area first.');
    }
    await landing.bringToFront();

    // Identify any already-open ITDStart popups. We either reuse one that
    // matches the requested take, or close all of them before opening a
    // fresh popup deterministically.
    const existingPopups = allPages.filter((p) => /ITDStart\.aspx/i.test(p.url()));

    for (const candidate of existingPopups) {
      const info = await opeScraper.verifyPopupMatchesTakeIdx(candidate, landing, {
        productId: preset.productId,
        type: preset.type,
        takeIdx,
      }).catch((e) => ({ matches: false, reason: `verify-threw: ${e.message}` }));
      verificationAttempts.push({
        popupUrl: candidate.url(),
        matches: !!info.matches,
        reason: info.reason || null,
        landingDateText: info.landingDateText || null,
        takeGuid: info.identity?.takeGuid || null,
      });
      if (info.matches) {
        popup = candidate;
        popupTakeGuid = info.identity?.takeGuid || null;
        break;
      }
    }

    if (!popup) {
      // No popup matches the requested takeIdx — close all stale ITDStart
      // popups so the launchitdwindow click below doesn't get confused, and
      // so we don't leave the user with multiple Score Report tabs lying
      // around. (Safe: these popups are transient child tabs of the landing,
      // not the user's main starttest.com session tab.)
      for (const stale of existingPopups) {
        const staleUrl = stale.url();
        try {
          await stale.close({ runBeforeUnload: false });
          closedStalePopups.push(staleUrl);
        } catch (e) {
          closedStalePopups.push(`${staleUrl} (close-failed: ${e.message})`);
        }
      }
      await opeScraper.navigateToOpeLanding(landing, {
        productId: preset.productId,
        type: preset.type,
      });
      popup = await opeScraper.openTakeScoreReportPopup(landing, { takeIdx, timeoutMs: 30000 });
      popupOpenedByUs = true;
      // Capture the freshly-minted popup's takeGuid for the in-scraper guard.
      const identity = await opeScraper.readScoreCardTakeIdentity(popup).catch(() => null);
      popupTakeGuid = identity?.takeGuid || null;
    }
    await popup.bringToFront();
    const result = await opeScraper.scrapeAttemptPhase3(popup, {
      sourceId,
      takeIdx,
      expectedTotal,
      expectedTakeGuid: popupTakeGuid,
      minDelayMs: Number(options.minDelayMs) || 1500,
      maxDelayMs: Number(options.maxDelayMs) || 3000,
      onProgress: (evt) => {
        progressEvents.push({ at: new Date().toISOString(), ...evt });
        if (progressEvents.length > 200) progressEvents.shift();
      },
    });
    return {
      result,
      tabUrl: popup.url(),
      debug: {
        startedAt,
        finishedAt: new Date().toISOString(),
        cdpUrl: cdp.connectedUrl,
        sourceId,
        takeIdx,
        productLabel: preset.label,
        popupOpenedByUs,
        popupTakeGuid,
        verificationAttempts,
        closedStalePopups,
        diagnostics: {
          enriched: result.items.length,
          errors: result.errors.length,
          aborted: result.aborted,
          abortReason: result.abortReason,
        },
        progressEvents,
      },
    };
  } catch (error) {
    error.scrapeDebug = {
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceId,
      takeIdx,
      tabUrl: popup?.url?.() || null,
      popupOpenedByUs,
      popupTakeGuid,
      verificationAttempts,
      closedStalePopups,
      progressEvents,
      anomaly: error instanceof opeScraper.ScrapeAnomalyError
        ? { name: error.name, url: error.url, snippet: error.snippet }
        : null,
    };
    throw error;
  } finally {
    void browser;
  }
}

module.exports = {
  openUrlInOpenBrowser,
  runScrapeFromOpenBrowser,
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
  STARTTEST_SOURCE_PRODUCTS,
  TTP_SECTION_PRESETS,
  OPE_SOURCE_PRODUCTS: opeScraper.SOURCE_PRODUCTS,
};
