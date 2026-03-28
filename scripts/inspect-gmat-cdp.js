const { chromium } = require('playwright');

const SOURCES = [
  {
    id: 'og-verbal-review-2024-2025',
    label: 'OG Verbal Review 2024-2025',
    url: 'https://gmatofficialpractice.mba.com/app/gmat-official-guide-2024-2025-verbal-review-online-question-bank',
  },
  {
    id: 'og-quantitative-review-2024-2025',
    label: 'OG Quantitative Review 2024-2025',
    url: 'https://gmatofficialpractice.mba.com/app/gmat-official-guide-2024-2025-quantitative-review-online-question-bank',
  },
  {
    id: 'og-data-insights-review-2024-2025',
    label: 'OG Data Insights Review 2024-2025',
    url: 'https://gmatofficialpractice.mba.com/app/gmat-official-guide-2024-2025-data-insights-review-online-question-bank',
  },
  {
    id: 'og-main-2024-2025',
    label: 'OG Main 2024-2025',
    url: 'https://gmatofficialpractice.mba.com/app/gmat-official-guide-2024-2025-online-question-bank',
  },
  {
    id: 'focus-quant-practice',
    label: 'GMAT Focus Quantitative Practice',
    url: 'https://gmatofficialpractice.mba.com/app/gmat-focus-official-practice-questions-quantitative',
  },
  {
    id: 'focus-verbal-practice',
    label: 'GMAT Focus Verbal Practice',
    url: 'https://gmatofficialpractice.mba.com/app/gmat-focus-official-practice-questions-verbal',
  },
  {
    id: 'focus-data-insights-practice',
    label: 'GMAT Focus Data Insights Practice',
    url: 'https://gmatofficialpractice.mba.com/app/gmat-focus-official-practice-questions-data-insights',
  },
];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function inspectPage(page, pageLabel) {
  return page.evaluate((label) => {
    const text = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const count = (selector) => {
      try {
        return document.querySelectorAll(selector).length;
      } catch (_error) {
        return -1;
      }
    };
    const sampleTexts = (selector, limit = 5) => {
      try {
        return Array.from(document.querySelectorAll(selector))
          .map((el) => text(el.innerText || el.textContent || ''))
          .filter(Boolean)
          .slice(0, limit);
      } catch (_error) {
        return [];
      }
    };
    const attrSamples = (selector, attr, limit = 8) => {
      try {
        return Array.from(document.querySelectorAll(selector))
          .map((el) => text(el.getAttribute(attr)))
          .filter(Boolean)
          .slice(0, limit);
      } catch (_error) {
        return [];
      }
    };
    const classContains = (fragment) => {
      const needle = String(fragment || '').toLowerCase();
      return Array.from(document.querySelectorAll('*')).filter((el) =>
        String(el.className || '').toLowerCase().includes(needle)
      ).length;
    };

    return {
      pageLabel: label,
      title: document.title,
      url: location.href,
      pathname: location.pathname,
      hash: location.hash,
      headings: [...sampleTexts('h1', 3), ...sampleTexts('h2', 4)].slice(0, 6),
      bodyPreview: text(document.body.innerText).slice(0, 500),
      selectorCounts: {
        categoryRows: count('[data-id].category.content,[data-id][class*="category"][class*="content"]'),
        categoryLinks: count('a[href*="categories/"],[data-href*="categories/"],[data-url*="categories/"],[data-link*="categories/"]'),
        reviewLinks: count('a[href*="review/categories/"],[data-href*="review/categories/"],[data-url*="review/categories/"],[data-link*="review/categories/"]'),
        previewNodes: count('[class*="preview"]'),
        difficultyNodes: count('[class*="difficulty"]'),
        confidenceNodes: count('[class*="confidence"]'),
        correctnessNodes: count('[class*="correctness"]'),
        reviewNodes: count('[class*="review"]'),
        choiceContainers: count('.question-choices-multi,[class*="question-choices"]'),
        choiceNodes: count('.question-choices-multi .multi-choice,.question-choices-multi [class*="choice"],[class*="question-choices"] .multi-choice,[class*="question-choices"] [class*="choice"]'),
        explanationNodes: count('[class*="explanation"],[id*="explanation"],[data-testid*="explanation"],[class*="rationale"],[class*="analysis"]'),
      },
      classContains: {
        category: classContains('category'),
        content: classContains('content'),
        preview: classContains('preview'),
        difficulty: classContains('difficulty'),
        confidence: classContains('confidence'),
        correctness: classContains('correctness'),
        review: classContains('review'),
        questionChoices: classContains('question-choices'),
      },
      categorySamples: sampleTexts('[data-id].category.content,[data-id][class*="category"][class*="content"]', 5),
      previewSamples: sampleTexts('[class*="preview"]', 5),
      routeHrefSamples: [
        ...attrSamples('a[href*="categories/"]', 'href', 4),
        ...attrSamples('a[href*="review/categories/"]', 'href', 4),
      ].slice(0, 8),
      dataIdSamples: attrSamples('[data-id]', 'data-id', 8),
      buttonSamples: sampleTexts('button', 8),
    };
  }, pageLabel);
}

async function main() {
  const cdpUrl = process.env.CHROME_CDP_URL || 'http://127.0.0.1:9222';
  const browser = await chromium.connectOverCDP(cdpUrl);

  try {
    const pages = browser.contexts().flatMap((ctx) => ctx.pages());
    const page = pages.find((entry) => /gmatofficialpractice\.mba\.com/i.test(entry.url()));
    if (!page) {
      throw new Error('No GMAT page found in the connected Chrome session.');
    }

    const output = [];
    page.setDefaultNavigationTimeout(15000);
    page.setDefaultTimeout(15000);
    await page.bringToFront();
    await page.waitForLoadState('domcontentloaded');
    output.push(await inspectPage(page, 'existing-page'));

    for (const source of SOURCES) {
      // eslint-disable-next-line no-console
      console.error(`Inspecting ${source.label} -> ${source.url}`);
      try {
        await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1800);
        output.push(await inspectPage(page, source.label));
      } catch (error) {
        output.push({
          pageLabel: source.label,
          url: source.url,
          error: normalizeText(error?.message || String(error)),
        });
      }
    }

    console.log(JSON.stringify(output, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(normalizeText(error?.stack || error?.message || String(error)));
  process.exit(1);
});
