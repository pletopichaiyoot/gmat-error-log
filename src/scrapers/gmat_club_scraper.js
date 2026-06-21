(function () {
  'use strict';

  // GMAT Club Error Log scraper — runs in the browser context, injected by
  // scraper-runner.js as `window.runScraper(cfg)`.
  //
  // Target page: https://gmatclub.com/forum/analytics.php#error_log
  // Table: `table.analytics-table`. Verified column layout (2026-04-26):
  //   0: checkbox  1: Question  2: Result(svg)  3: Attempts  4: Category
  //   5: Difficulty band  6: Time  7: Date  8: Mistakes/Notes
  // The table has NO forum column. Subject must be inferred downstream
  // (LLM classifier).

  const PAGE_LOAD_POLL_MS = 250;
  const PAGE_LOAD_TIMEOUT_MS = 15000;
  const TABLE_READY_TIMEOUT_MS = 15000;
  const PREFERRED_PAGE_SIZE = 100;

  const MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };

  // GMAT Club's analytics table has no forum column, but the Category cell is
  // already at the topic level (e.g., "Probability"). Map it directly to a
  // category code so the LLM classifier can be skipped — the category itself
  // is the subject signal. Keys are case-insensitive.
  const GMATCLUB_CATEGORY_TO_CODE = {
    // Quant — PS
    'probability': 'PS', 'combinations': 'PS', 'permutations': 'PS',
    'counting': 'PS', 'counting methods': 'PS',
    'number properties': 'PS', 'remainders': 'PS',
    'multiples and factors': 'PS', 'divisibility': 'PS', 'divisors': 'PS',
    'exponents': 'PS', 'roots': 'PS', 'powers and roots': 'PS',
    'algebra': 'PS', 'inequalities': 'PS', 'absolute values': 'PS',
    'absolute value': 'PS', 'functions': 'PS', 'sequences': 'PS',
    'min-max problems': 'PS', 'min/max problems': 'PS',
    'arithmetic': 'PS', 'fractions': 'PS', 'decimals': 'PS',
    'percent': 'PS', 'percents': 'PS', 'percentages': 'PS',
    'ratios': 'PS', 'ratio and proportion': 'PS', 'ratio & proportion': 'PS',
    'mixture problems': 'PS', 'word problems': 'PS', 'arithmetic word problems': 'PS',
    'distance and speed problems': 'PS', 'distance/rate problems': 'PS',
    'work rate problems': 'PS', 'work/rate problems': 'PS', 'rates': 'PS',
    'statistics': 'PS', 'standard deviation': 'PS',
    'geometry': 'PS', 'coordinate geometry': 'PS', 'solid geometry': 'PS',
    'overlapping sets': 'PS', 'sets': 'PS', 'venn diagrams': 'PS',
    // Verbal — CR
    'strengthen': 'CR', 'weaken': 'CR', 'logical flaw': 'CR', 'flaw': 'CR',
    'assumption': 'CR', 'evaluate': 'CR', 'resolve': 'CR', 'explain': 'CR',
    'inference': 'CR', 'must or could be true': 'CR', 'must be true': 'CR',
    'boldface': 'CR', 'method': 'CR', 'parallel': 'CR', 'complete': 'CR',
    'argument structure': 'CR', 'cr': 'CR',
    // Verbal — RC
    'main idea': 'RC', 'main idea / purpose': 'RC', 'purpose': 'RC',
    'detail': 'RC', 'structure / function': 'RC', 'author view': 'RC',
    'author attitude': 'RC', 'application': 'RC', 'organization': 'RC',
    'rc': 'RC',
    // DI
    'tables': 'TA', 'table analysis': 'TA',
    'graphs': 'GI', 'graphics interpretation': 'GI',
    'multi-source reasoning': 'MSR', 'msr': 'MSR',
    'two-part analysis': 'TPA', 'tpa': 'TPA',
    'di': 'DI',
  };
  const CODE_TO_SUBJECT = { PS: 'Q', DS: 'Q', CR: 'V', RC: 'V', GI: 'DI', TA: 'DI', MSR: 'DI', TPA: 'DI', DI: 'DI' };

  // Keyword fallback for compound GMAT Club categories like
  // "Statistics and Sets Problems" that aren't a direct entry in the table.
  // Order matters: more specific keywords first.
  // Drop trailing \b so plurals/suffixes (e.g., "statistics", "fractions",
  // "ratios", "rates", "sets") still match the stem.
  const KEYWORD_TO_CODE = [
    [/\b(must be true|could be true|inference|infer)/, 'CR'],
    [/\b(strengthen|weaken|flaw|assumption|evaluate|resolve|explain|boldface|argument|parallel)/, 'CR'],
    [/\b(main idea|purpose|author|detail|structure|application|organization)/, 'RC'],
    [/\b(table analysis|tables?)\b/, 'TA'],
    [/\b(graphs?|graphics)/, 'GI'],
    [/\b(multi.?source|msr)\b/, 'MSR'],
    [/\b(two.?part|tpa)\b/, 'TPA'],
    [/\b(probability|combination|permutation|counting)/, 'PS'],
    [/\b(geometry|coordinate)/, 'PS'],
    [/\b(algebra|inequalit|absolute value|function|sequence|exponent|root)/, 'PS'],
    [/\b(arithmetic|fraction|decimal|percent|ratio)/, 'PS'],
    [/\b(rate|work|distance|speed|motion|mixture)/, 'PS'],
    [/\b(statistic|stats|standard deviation|deviation|mean|median|average)/, 'PS'],
    [/\b(set|venn|overlapping)/, 'PS'],
    [/\b(number propert|divisor|factor|multiple|remainder|prime|integer)/, 'PS'],
    [/\b(min.?max|word problem)/, 'PS'],
  ];

  function mapGmatClubCategory(raw) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) return { code: null, subject: null };
    let code = GMATCLUB_CATEGORY_TO_CODE[key] || null;
    if (!code) {
      for (const [pattern, mappedCode] of KEYWORD_TO_CODE) {
        if (pattern.test(key)) { code = mappedCode; break; }
      }
    }
    return { code, subject: code ? CODE_TO_SUBJECT[code] || null : null };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function parseDateRaw(raw) {
    // "7 Mar 2026" → Date at local midnight, or null
    const m = String(raw || '').trim().match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const year = parseInt(m[3], 10);
    if (month === undefined || !Number.isFinite(day) || !Number.isFinite(year)) return null;
    return new Date(year, month, day);
  }

  function formatDateISO(d) {
    if (!d) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseSinceDateKey(since) {
    // YYYYMMDDHHmmss → "YYYY-MM-DD" (day granularity — the table only shows date)
    const s = String(since || '');
    if (s.length < 8) return '';
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }

  function parseTimeSec(raw) {
    if (!raw) return null;
    const parts = String(raw).trim().split(':').map((x) => parseInt(x, 10));
    if (parts.some((p) => !Number.isFinite(p))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function mapDifficulty(raw) {
    // GMAT Club's own Focus-scale band → tier mapping, taken verbatim from
    // their Difficulty filter UI. Seven bands, bucketed on the lower bound:
    //   Easy:   "Sub 505", "505-555"           (low < 555)
    //   Medium: "555-605", "605-655"           (555 <= low < 655)
    //   Hard:   "655-705", "705-805", "805+"   (low >= 655)
    // Title-cased to match the StartTest/OPE difficulty labels (downstream
    // aggregation is case-insensitive, but raw display elsewhere is not).
    if (!raw) return null;
    const m = String(raw).match(/(\d+)/);
    if (!m) return null;
    const low = parseInt(m[1], 10);
    if (!Number.isFinite(low)) return null;
    if (low < 555) return 'Easy';
    if (low < 655) return 'Medium';
    return 'Hard';
  }

  function extractTopicId(url) {
    const m = String(url || '').match(/topic(\d+)/);
    return m ? m[1] : null;
  }

  function hashSessionId(input) {
    let hash = 0;
    const s = String(input);
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  function getShowingText() {
    const m = document.body.innerText.match(/Showing\s+(\d+)-(\d+)\s+of\s+(\d+)/i);
    if (!m) return null;
    return { start: +m[1], end: +m[2], total: +m[3], raw: m[0] };
  }

  async function waitForSelector(selector, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (document.querySelector(selector)) return true;
      await sleep(PAGE_LOAD_POLL_MS);
    }
    return !!document.querySelector(selector);
  }

  async function waitForTableReady() {
    await waitForSelector('.analytics-table', TABLE_READY_TIMEOUT_MS);
    // Wait for either rows to appear or for "Showing" text to materialize.
    const deadline = Date.now() + TABLE_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const hasRow = document.querySelector('.analytics-table tbody tr');
      const showing = getShowingText();
      if (hasRow || (showing && showing.total === 0)) return showing;
      await sleep(PAGE_LOAD_POLL_MS);
    }
    return getShowingText();
  }

  // The pager container is the nearest ancestor of the table that also contains
  // the "Showing N-N of M" text. Scoping page-button lookups to this container
  // avoids a false match against the row-level Attempts buttons (which are
  // also `<button>{N}</button>`).
  function findPagerContainer() {
    const table = document.querySelector('.analytics-table');
    if (!table) return null;
    let node = table.parentElement;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      if (/Showing\s+\d+-\d+\s+of\s+\d+/i.test(node.textContent || '')) return node;
    }
    return null;
  }

  function findPageButton(targetPage) {
    const pager = findPagerContainer();
    if (!pager) return null;
    const candidates = Array.from(pager.querySelectorAll('button'))
      .filter((b) => !b.closest('tbody'))
      .filter((b) => b.textContent.trim() === String(targetPage))
      .filter((b) => !b.disabled);
    // Prefer the rounded-md pager style if multiple match.
    const styled = candidates.find((b) => /rounded-md/.test(b.className || ''));
    return styled || candidates[0] || null;
  }

  async function waitForShowingChange(prev) {
    const deadline = Date.now() + PAGE_LOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const cur = getShowingText();
      if (cur && (!prev || cur.start !== prev.start)) return cur;
      await sleep(PAGE_LOAD_POLL_MS);
    }
    return getShowingText();
  }

  async function waitForRowCount(expected, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const count = document.querySelectorAll('.analytics-table tbody tr').length;
      if (count === expected) return count;
      await sleep(PAGE_LOAD_POLL_MS);
    }
    return document.querySelectorAll('.analytics-table tbody tr').length;
  }

  async function trySetPageSize(targetSize) {
    // The page-size <select> sits outside the table. Match it by the option text.
    const selects = Array.from(document.querySelectorAll('select'));
    const sel = selects.find((s) =>
      Array.from(s.options).some((o) => /\d+\s*Entries/i.test(o.textContent || ''))
    );
    if (!sel) return null;
    const option = Array.from(sel.options).find(
      (o) => parseInt(o.textContent || '', 10) === targetSize
    );
    if (!option) return null;
    if (sel.value === option.value) return targetSize;

    sel.value = option.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.dispatchEvent(new Event('input', { bubbles: true }));

    // Showing text updates synchronously; rows re-render async. Wait for the
    // row count to actually match the new "Showing X-Y of Z" range.
    const showing = getShowingText();
    const expectedRows = showing ? Math.min(targetSize, showing.end - showing.start + 1) : targetSize;
    await waitForRowCount(expectedRows, PAGE_LOAD_TIMEOUT_MS);
    return targetSize;
  }

  function scrapeCurrentPage() {
    const table = document.querySelector('.analytics-table');
    if (!table) return [];

    const rows = Array.from(table.querySelectorAll('tbody tr'));
    return rows.map((row) => {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 9) return null;

      const stemLink = cells[1] ? cells[1].querySelector('a[href]') : null;
      const stem = cells[1] ? cells[1].textContent.replace(/\s+/g, ' ').trim() : '';
      const questionUrl = stemLink ? stemLink.href : '';

      const resultSvg = cells[2] ? cells[2].querySelector('svg') : null;
      const svgClass = resultSvg ? resultSvg.getAttribute('class') || '' : '';
      const correct = /text-green/.test(svgClass);

      const attemptsText = cells[3] ? cells[3].textContent.trim() : '';
      const attempts = parseInt(attemptsText, 10) || null;

      // Category cell may render multiple chips plus a "+N topics" hover
      // affordance, which textContent joins as e.g. "Combinations+1 topic".
      // Strip the trailing "+N topic(s)" so the value is the visible label.
      const category = cells[4]
        ? cells[4].textContent.replace(/\s+/g, ' ').trim().replace(/\s*\+\s*\d+\s+topics?$/i, '').trim()
        : '';
      const difficultyRaw = cells[5] ? cells[5].textContent.trim() : '';
      const timeRaw = cells[6] ? cells[6].textContent.trim() : '';
      const dateRaw = cells[7] ? cells[7].textContent.trim() : '';

      // Per-attempt + per-question stable ids live on the mistake button.
      const mistakeBtn = cells[8] ? cells[8].querySelector('button[data-row]') : null;
      const dataRow = mistakeBtn ? mistakeBtn.getAttribute('data-row') || '' : '';
      const attemptIdMatch = dataRow.match(/(\d+)$/);
      const attemptId = attemptIdMatch ? attemptIdMatch[1] : null;
      const questionIdAttr = mistakeBtn
        ? mistakeBtn.getAttribute('data-analytics-question-id') || ''
        : '';
      const questionId = questionIdAttr || extractTopicId(questionUrl);

      // The notes button is hover-revealed; the cell text is empty by default.
      // Capture any visible text in case GMAT Club ever surfaces a saved note.
      const notes = cells[8] ? cells[8].textContent.replace(/\s+/g, ' ').trim() : '';

      return {
        attemptId,
        questionId,
        questionUrl,
        questionStem: stem,
        category,
        difficultyRaw,
        timeRaw,
        dateRaw,
        correct,
        attempts,
        notes,
      };
    }).filter(Boolean);
  }

  window.runScraper = async function runScraper(cfg) {
    const sinceKey = parseSinceDateKey(cfg && cfg.since);
    const source = (cfg && cfg.source) || 'GMAT Club Error Log';
    console.log(`[gmat-club-scraper] start since=${cfg && cfg.since} (key=${sinceKey}) source=${source}`);

    const initialShowing = await waitForTableReady();
    if (!initialShowing) {
      console.warn('[gmat-club-scraper] No "Showing N-N of M" text found — table may not have loaded');
    }
    const total = initialShowing ? initialShowing.total : 0;
    console.log(`[gmat-club-scraper] total entries: ${total}`);

    if (total === 0) {
      return {
        extracted_at: new Date().toISOString(),
        config: { since: cfg && cfg.since, source, sinceTimezone: 'Asia/Bangkok' },
        sessions: [],
      };
    }

    const usedPageSize = (await trySetPageSize(PREFERRED_PAGE_SIZE)) || (initialShowing
      ? Math.max(1, initialShowing.end - initialShowing.start + 1)
      : 20);

    // Always start on page 1. The user (or a prior scrape) may have left the
    // table on a later page; otherwise we'd skip the head of the list.
    const showingNow = getShowingText() || initialShowing;
    if (showingNow && showingNow.start > 1) {
      const page1 = findPageButton(1);
      if (page1) {
        page1.click();
        const after = await waitForShowingChange(showingNow);
        if (after) {
          await waitForRowCount(Math.min(usedPageSize, after.end - after.start + 1), PAGE_LOAD_TIMEOUT_MS);
        }
      }
    }

    const showingAfterResize = getShowingText() || initialShowing;
    const totalPages = Math.ceil((showingAfterResize ? showingAfterResize.total : total) / usedPageSize) || 1;
    console.log(`[gmat-club-scraper] page size=${usedPageSize}, pages=${totalPages}`);

    const seenAttemptIds = new Set();
    const collected = [];
    let reachedEnd = false;

    for (let page = 1; page <= totalPages; page++) {
      const showing = getShowingText();
      console.log(`[gmat-club-scraper] page ${page}/${totalPages} (${showing ? showing.raw : 'no showing text'})`);

      const rows = scrapeCurrentPage();
      if (!rows.length) {
        console.warn(`[gmat-club-scraper] empty page ${page}, stopping`);
        break;
      }

      for (const r of rows) {
        const dedupKey = r.attemptId || `${r.questionId || 'q'}|${r.dateRaw}|${r.timeRaw}`;
        if (seenAttemptIds.has(dedupKey)) continue;
        seenAttemptIds.add(dedupKey);

        const d = parseDateRaw(r.dateRaw);
        const dateKey = d ? formatDateISO(d) : '';
        if (sinceKey && dateKey && dateKey < sinceKey) {
          reachedEnd = true;
          continue;
        }
        collected.push({ ...r, dateKey });
      }

      if (reachedEnd) {
        console.log(`[gmat-club-scraper] hit since cutoff at page ${page}`);
        break;
      }
      if (page >= totalPages) break;

      const before = getShowingText();
      const nextBtn = findPageButton(page + 1);
      if (!nextBtn) {
        console.warn(`[gmat-club-scraper] no pager button for page ${page + 1}`);
        break;
      }
      nextBtn.click();
      const after = await waitForShowingChange(before);
      if (!after || (before && after.start === before.start)) {
        console.warn(`[gmat-club-scraper] page did not advance after clicking ${page + 1}`);
        break;
      }
      const expectedRows = Math.min(usedPageSize, after.end - after.start + 1);
      await waitForRowCount(expectedRows, PAGE_LOAD_TIMEOUT_MS);
    }

    console.log(`[gmat-club-scraper] collected ${collected.length} rows`);

    // Group rows into sessions by date. GMAT Club Error Log is not session-
    // based, so each calendar day becomes one synthetic session. The session
    // id is hashed from `${source}|${dateKey}` so different sources don't
    // collide on the same day.
    const byDate = new Map();
    for (const r of collected) {
      const key = r.dateKey || 'unknown';
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(r);
    }

    const sessions = Array.from(byDate.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([dateKey, rows]) => {
        const correctCount = rows.filter((r) => r.correct).length;
        const errorCount = rows.length - correctCount;
        const times = rows.map((r) => parseTimeSec(r.timeRaw)).filter((t) => t !== null);
        const correctTimes = rows.filter((r) => r.correct).map((r) => parseTimeSec(r.timeRaw)).filter((t) => t !== null);
        const errorTimes = rows.filter((r) => !r.correct).map((r) => parseTimeSec(r.timeRaw)).filter((t) => t !== null);
        const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

        const questions = rows.map((r) => {
          const mapped = mapGmatClubCategory(r.category);
          // If the category maps to a known code, mark the row as
          // 'gmatclub-canonical' so the LLM classifier skips it. Otherwise
          // leave `topic_source` null and let the classifier handle it.
          const topicSource = mapped.code ? 'gmatclub-canonical' : null;
          return ({
          // q_id = stable per-attempt id (timer history). q_code = per-question
          // topic id. Both prefixed for cross-source uniqueness.
          q_id: r.attemptId ? `gc-att-${r.attemptId}` : null,
          q_code: r.questionId ? `gc-q-${r.questionId}` : null,
          cat_id: null,
          correct: r.correct,
          difficulty: mapDifficulty(r.difficultyRaw),
          confidence: null,
          time_sec: parseTimeSec(r.timeRaw),
          my_answer: null,
          correct_answer: null,
          // The category cell is the topic. Carry it through as `topic` and
          // also mirror to `subcategory` so the existing UI columns render.
          topic: r.category || null,
          subcategory: r.category || null,
          topic_source: topicSource,
          question_url: r.questionUrl || null,
          question_stem: r.questionStem || null,
          answer_choices: null,
          // Feed the inferred category code into `subject_sub_raw` so
          // deriveQuestionMetadata can compute category_code/subject_code
          // without any LLM call.
          subject_sub: null,
          subject_sub_raw: mapped.code,
          content_domain: null,
          response_format: null,
          response_details: null,
          notes: r.notes || null,
          mistake_type: null,
          });
        });

        return {
          session_id: hashSessionId(`${source}|${dateKey}`),
          date: dateKey,
          source,
          // No subject signal exists in the GMAT Club table. Leave null and
          // let downstream code (or the user) fill it in.
          subject: null,
          review_category_id: null,
          stats: {
            total_q_api: rows.length,
            total_q_categories: rows.length,
            correct: correctCount,
            errors: errorCount,
            accuracy_pct: rows.length > 0 ? Math.round((correctCount / rows.length) * 1000) / 10 : 0,
            avg_time_sec: avg(times),
            avg_correct_time_sec: avg(correctTimes),
            avg_incorrect_time_sec: avg(errorTimes),
          },
          questions,
          wrong_q_ids: questions
            .filter((q) => !q.correct)
            .map((q) => ({ q_id: q.q_id, cat_id: null })),
        };
      });

    return {
      extracted_at: new Date().toISOString(),
      config: {
        since: cfg && cfg.since,
        source,
        clientId: null,
        sinceTimezone: 'Asia/Bangkok',
        sessionDateTimezone: 'browser-local',
      },
      sessions,
    };
  };
})();
