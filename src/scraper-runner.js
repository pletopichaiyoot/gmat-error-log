const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const DEFAULT_SCRAPER_CONFIG = {
  clientId: 789329902,
  since: '20260101000000',
  reviewCategoryId: null,
  source: 'OG Verbal Review 2024-2025',
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

function matchesAppEntry(pageUrl, appUrl) {
  const pageParsed = parseUrlSafe(pageUrl);
  const appParsed = parseUrlSafe(appUrl);
  if (!pageParsed || !appParsed) return false;

  const pagePath = trimTrailingSlash(pageParsed.pathname || '/');
  const appPath = trimTrailingSlash(appParsed.pathname || '/');
  return pageParsed.origin === appParsed.origin && pagePath === appPath;
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
    const gmatPages = pages.filter((page) => /gmatofficialpractice\.mba\.com/i.test(page.url()));
    gmatPage =
      (appSlug
        ? gmatPages.find((page) => page.url().includes(`/app/${appSlug}`))
        : null) || gmatPages[0];

    if (!gmatPage) {
      throw new Error(
        'No open GMAT tab found. Open GMAT Official Practice in the same Chrome instance and stay logged in.'
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
    const gmatPage = pages.find((entry) => /gmatofficialpractice\.mba\.com/i.test(entry.url()));
    const context = gmatPage?.context?.() || contexts[0] || null;

    if (!context) {
      throw new Error('No Chrome browser context found. Open Chrome (CDP) first.');
    }

    page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();

    return {
      ok: true,
      openedUrl: page.url(),
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
      targetUrl,
    };
    throw wrapped;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = {
  openUrlInOpenBrowser,
  runScrapeFromOpenBrowser,
};
