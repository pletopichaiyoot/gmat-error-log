// Target Test Prep error-tracker scraper. Runs Node-side (not page-injected).
// Called with an already-navigated Playwright `page` connected to the user's
// logged-in Chrome via CDP.
//
// Single-pass design (unlike StartTest's two phases):
//   1. Visit /error_tracker/{section} → enumerate mistake categories from the
//      .failure-reason rows. Each row exposes a `/error_tracker/{section}/{N}`
//      link plus an aggregate count (e.g., "5 / 18").
//   2. For each category, visit ?page=1 once to read the question-count
//      dropdown (e.g., "1 of 5"). Then walk ?page=2..N pulling the per-attempt
//      payload: attempt_id (from the remove-question form), problem_id (from
//      data-exercise-id), chapter label, attempt status, time, stem, choices
//      (with .user-choice / data-correct flags). Solution text is captured but
//      may be empty if the user never expanded it.
//   3. Synthesize one session per (section, mistakeCategory) so the dashboard's
//      session-grouped UX stays meaningful. session_external_id is a stable
//      hash of `${section}|${categoryId}` so re-scrapes upsert rather than
//      duplicating.
//
// The user's mistake_type on TTP is authoritative — the scraper writes the
// mistake-category text into each question's mistake_type field, which the DB
// upsert will use to overwrite any prior value (the existing logic prefers a
// truthy scraped `mistake_type` over the preserved one).

const { sleep, jitter, hashSessionExternalId } = require('./scraper-utils');

const TTP_HOST_RE = /gmat\.targettestprep\.com/i;

const SECTION_PRESETS = Object.freeze({
  'ttp-quant-error-tracker': {
    section: 'quant',
    label: 'Target Test Prep — Quant Error Tracker',
    subjectCode: 'Q',
    categoryCode: 'PS',
  },
  'ttp-verbal-error-tracker': {
    section: 'verbal',
    label: 'Target Test Prep — Verbal Error Tracker',
    subjectCode: 'V',
    categoryCode: '',
  },
  'ttp-data-insights-error-tracker': {
    section: 'di',
    label: 'Target Test Prep — Data Insights Error Tracker',
    subjectCode: 'DI',
    categoryCode: '',
  },
});

class ScrapeAnomalyError extends Error {
  constructor(message, { url, snippet } = {}) {
    super(message);
    this.name = 'ScrapeAnomalyError';
    this.url = url || null;
    this.snippet = snippet || null;
  }
}

function parseTimeMmSs(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function todayThaiDate(now = new Date()) {
  const thai = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return `${thai.getUTCFullYear()}-${String(thai.getUTCMonth() + 1).padStart(2, '0')}-${String(thai.getUTCDate()).padStart(2, '0')}`;
}

async function gotoTtp(page, url, { timeoutMs = 30000 } = {}) {
  if (!url) throw new ScrapeAnomalyError('Empty URL passed to gotoTtp');
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  if (response && response.status() >= 400) {
    throw new ScrapeAnomalyError(`TTP returned HTTP ${response.status()} for ${url}`, { url });
  }
  // Quick login-page sniff. TTP redirects to a sign-in screen if the session
  // dies; bail loud before we start dumping login HTML into the DB.
  const looksLoggedOut = await page.evaluate(() =>
    /sign\s*in|login/i.test(document.title || '') ||
    !!document.querySelector('form[action*="users/sign_in"]')
  );
  if (looksLoggedOut) {
    throw new ScrapeAnomalyError(
      `TTP appears logged out (tab at ${page.url()}). Sign in via gmat.targettestprep.com and retry.`,
      { url: page.url() }
    );
  }
}

// Parse the section index page. Each `.failure-reason` row carries the mistake
// category text + count + a `/error_tracker/{section}/{N}` link.
async function readSectionIndex(page, section) {
  return page.evaluate(({ section }) => {
    const rows = Array.from(document.querySelectorAll('.error-tracker-list .failure-reason'));
    if (!rows.length) return { rows: [], totalQuestions: 0 };

    const items = [];
    let totalQuestions = 0;
    for (const row of rows) {
      const text = (row.querySelector('.failure-reason-text')?.textContent || '').replace(/\s+/g, ' ').trim();
      const link = row.querySelector('a[href*="/error_tracker/"]');
      const href = link?.getAttribute('href') || '';
      const m = href.match(new RegExp(`/error_tracker/${section}/(\\d+)`));
      const categoryId = m ? Number(m[1]) : null;
      // ".frequency" = percentage e.g. "28%". The fraction lives in
      // .frequency-percentage as "<b>5</b> / 18 questions".
      const pctText = (row.querySelector('.frequency')?.textContent || '').trim();
      const pct = (pctText.match(/(\d+)\s*%/) || [])[1];
      const fracBold = row.querySelector('.frequency-percentage b')?.textContent || '';
      const fracTail = (row.querySelector('.frequency-percentage')?.textContent || '').replace(/\s+/g, ' ').trim();
      const numerator = Number((fracBold || '').trim()) || 0;
      const denomMatch = fracTail.match(/\/\s*(\d+)/);
      const denominator = denomMatch ? Number(denomMatch[1]) : null;
      if (Number.isFinite(denominator) && denominator > totalQuestions) totalQuestions = denominator;
      if (!categoryId || !text) continue;
      // TTP renders zero-count "positive" categories (e.g., "I guessed correctly",
      // "I ran out of time") in the index too, but their View-Questions buttons
      // are marked disabled and visiting the category page yields no
      // .exercise-attempt-box. Skip them upfront.
      const dropdownBtn = row.querySelector('.view-questions-btn');
      const isDisabled = dropdownBtn && dropdownBtn.classList.contains('disabled');
      if (isDisabled || numerator <= 0) continue;
      items.push({
        categoryId,
        mistakeText: text,
        href,
        count: numerator,
        percent: pct ? Number(pct) : null,
      });
    }
    return { rows: items, totalQuestions };
  }, { section });
}

// Parse a single category page (`/error_tracker/{section}/{N}?page=K`). The
// returned shape mirrors the schema-aligned `question` records the rest of the
// pipeline expects.
async function readCategoryPage(page, { section, categoryId, mistakeText }) {
  return page.evaluate(({ section, categoryId, mistakeText }) => {
    const result = { ok: false, reason: '' };
    const box = document.querySelector('.exercise-attempt-box');
    if (!box) {
      result.reason = 'no-exercise-attempt-box';
      return result;
    }

    const attemptStatus = box.getAttribute('data-attempt-status') || '';
    const exerciseId = box.getAttribute('data-exercise-id') || '';
    const lessonId = box.getAttribute('data-lesson-id') || '';
    const contextType = box.getAttribute('data-context-type') || '';

    // Remove-question form carries the only stable per-attempt id we get.
    let attemptId = null;
    const removeForm = document.querySelector('form[action*="clear_from_attempt"]');
    if (removeForm) {
      const action = removeForm.getAttribute('action') || '';
      const m = action.match(/attempt_id=(\d+)/);
      if (m) attemptId = Number(m[1]);
    }

    // Chapter heading (e.g., "Chapter 16 Combinations and Permutations"). The
    // tag wraps it across multiple text nodes — collapse whitespace.
    const chapterRaw = (box.querySelector('.box-header h6, .box-header .text-truncate')?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    let chapterNumber = null;
    let chapterName = chapterRaw;
    const chapterMatch = chapterRaw.match(/^chapter\s+(\d+)\s+(.+)$/i);
    if (chapterMatch) {
      chapterNumber = Number(chapterMatch[1]);
      chapterName = chapterMatch[2].trim();
    }
    const fullChapter = chapterNumber ? `Chapter ${chapterNumber} ${chapterName}` : chapterName;

    const timeText = (box.querySelector('.question-time .data')?.textContent || '').trim();

    const exercise = box.querySelector('.exercise');
    const exerciseClass = exercise?.className || '';
    let responseFormat = null;
    if (/data_sufficiency/i.test(exerciseClass)) responseFormat = 'DS';
    else if (/problem_solving/i.test(exerciseClass)) responseFormat = 'PS';
    else if (/critical_reasoning/i.test(exerciseClass)) responseFormat = 'CR';
    else if (/reading_comprehension/i.test(exerciseClass)) responseFormat = 'RC';

    // Question stem. TTP wraps each sentence in `<span class="notetaking-preselection">`;
    // joining their text with spaces preserves the visible order without the
    // mathjax-injected duplicates that sometimes appear under `.MathJax_Preview`.
    const stemNode = box.querySelector('.interrogation_part');
    let stem = '';
    if (stemNode) {
      // Skip MathJax preview siblings; their content is duplicate ASCII for the
      // adjacent .MathJax span.
      const spans = stemNode.querySelectorAll('.notetaking-preselection');
      if (spans.length) {
        stem = Array.from(spans).map((s) => s.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
      } else {
        stem = stemNode.textContent.replace(/\s+/g, ' ').trim();
      }
    }

    // Answer choices. Each `.answer` block contains an <input> with
    // `data-correct="true|false"` and (when picked) a parent `.user-choice`
    // class. `.option` holds the visible text. Letters A-E are positional.
    const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const choiceRows = Array.from(box.querySelectorAll('.answers .answer'));
    const choices = [];
    let userLetter = null;
    let correctLetter = null;
    let analyticsRows = Array.from(box.querySelectorAll('.answers .option-analytics'));
    choiceRows.forEach((row, idx) => {
      const input = row.querySelector('input');
      const isCorrect = (input?.getAttribute('data-correct') || '').toLowerCase() === 'true';
      const isUserPick = !!row.querySelector('.user-choice') || !!input?.classList?.contains('user-choice');
      const optSpans = row.querySelectorAll('.option .notetaking-preselection');
      const optText = optSpans.length
        ? Array.from(optSpans).map((s) => s.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ')
        : (row.querySelector('.option')?.textContent || '').replace(/\s+/g, ' ').trim();
      const label = letters[idx] || String(idx + 1);
      const analytics = analyticsRows[idx];
      const accuracy = analytics?.querySelector('.accuracy')?.textContent?.trim() || null;
      if (isCorrect) correctLetter = label;
      if (isUserPick) userLetter = label;
      choices.push({
        label,
        text: optText,
        value: String(input?.getAttribute('value') ?? idx),
        isCorrect,
        isUserSelected: isUserPick,
        accuracy: accuracy || null,
      });
    });

    // Solution text (if available). TTP's solution block is collapsed by
    // default but still present in the DOM. We capture the text but skip the
    // embedded Vimeo iframe.
    const solutionNode = box.querySelector('.info-box');
    let solutionText = '';
    if (solutionNode) {
      const clone = solutionNode.cloneNode(true);
      clone.querySelectorAll('iframe, script, style, .video-wrapper').forEach((el) => el.remove());
      const paragraphs = Array.from(clone.querySelectorAll('p, li'));
      if (paragraphs.length) {
        solutionText = paragraphs.map((p) => p.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
      } else {
        solutionText = clone.textContent.replace(/\s+/g, ' ').trim();
      }
    }

    // Bookmark link contains the canonical problem id (often equal to exercise id).
    const bookmarkHref = (box.querySelector('.flag-icon-link')?.getAttribute('href') || '');
    const bookmarkMatch = bookmarkHref.match(/\/flag\/problem\/review\/(\d+)/);
    const problemId = bookmarkMatch ? Number(bookmarkMatch[1]) : Number(exerciseId) || null;

    result.ok = true;
    result.attempt_id = attemptId;
    result.exercise_id = Number(exerciseId) || null;
    result.lesson_id = Number(lessonId) || null;
    result.problem_id = problemId;
    result.context_type = contextType || null;
    result.attempt_status = attemptStatus || null;
    result.chapter_label = fullChapter || null;
    result.chapter_number = chapterNumber;
    result.chapter_name = chapterName || null;
    result.time_text = timeText || null;
    result.response_format = responseFormat;
    result.stem = stem;
    result.choices = choices;
    result.my_answer = userLetter;
    result.correct_answer = correctLetter;
    result.solution_text = solutionText;
    return result;
  }, { section, categoryId, mistakeText });
}

// Read the "1 of N Questions" pager + every dropdown link so we know how many
// pages to walk and the canonical page URLs (handles arbitrary path bases).
async function readPagerLinks(page) {
  return page.evaluate(() => {
    const dropdown = document.querySelector('.questions-navigator .dropdown-menu');
    const items = dropdown
      ? Array.from(dropdown.querySelectorAll('a.dropdown-item')).map((a) => a.getAttribute('href') || '')
      : [];
    const totalText = (document.querySelector('.question-dropdown')?.textContent || '').replace(/\s+/g, ' ').trim();
    const m = totalText.match(/(\d+)\s+of\s+(\d+)/i);
    const total = m ? Number(m[2]) : items.length;
    return { hrefs: items, total };
  });
}

function buildQuestionRecord({ pageData, mistakeText, sectionPreset }) {
  const correct = (pageData.attempt_status || '').toLowerCase() === 'correct' ? 1 : 0;
  const timeSec = parseTimeMmSs(pageData.time_text);
  const topic = pageData.chapter_label || null;
  return {
    q_code: pageData.problem_id ? `ttp-q-${pageData.problem_id}` : null,
    q_id: pageData.attempt_id ? `ttp-att-${pageData.attempt_id}` : (pageData.problem_id ? `ttp-q-${pageData.problem_id}` : null),
    cat_id: pageData.chapter_number || null,
    subject_code: sectionPreset.subjectCode || null,
    category_code: sectionPreset.categoryCode || pageData.response_format || null,
    subcategory: topic,
    subject_sub: sectionPreset.subjectCode || null,
    subject_sub_raw: sectionPreset.categoryCode || pageData.response_format || null,
    question_url: pageData.problem_id ? `https://gmat.targettestprep.com/flag/problem/review/${pageData.problem_id}` : null,
    question_stem: pageData.stem || null,
    answer_choices: Array.isArray(pageData.choices) ? pageData.choices : [],
    response_format: pageData.response_format || null,
    response_details: pageData.solution_text ? JSON.stringify({ solution: pageData.solution_text }) : null,
    correct,
    difficulty: null,
    confidence: null,
    time_sec: timeSec,
    my_answer: pageData.my_answer || null,
    correct_answer: pageData.correct_answer || null,
    topic,
    topic_source: 'ttp-chapter',
    content_domain: sectionPreset.subjectCode === 'Q' ? 'Quant'
      : sectionPreset.subjectCode === 'V' ? 'Verbal'
      : sectionPreset.subjectCode === 'DI' ? 'Data Insights'
      : null,
    mistake_type: mistakeText || null,
    notes: null,
  };
}

function summarizeQuestions(questions) {
  const total = questions.length;
  let correct = 0;
  let timeSum = 0;
  let timeCorrectSum = 0;
  let timeIncorrectSum = 0;
  let timeCorrectCount = 0;
  let timeIncorrectCount = 0;
  for (const q of questions) {
    if (q.correct) correct += 1;
    if (Number.isFinite(q.time_sec)) {
      timeSum += q.time_sec;
      if (q.correct) { timeCorrectSum += q.time_sec; timeCorrectCount += 1; }
      else { timeIncorrectSum += q.time_sec; timeIncorrectCount += 1; }
    }
  }
  return {
    total_q_api: total,
    total_q_categories: total,
    correct,
    errors: total - correct,
    accuracy_pct: total ? Number(((correct / total) * 100).toFixed(2)) : 0,
    avg_time_sec: total ? Math.round(timeSum / total) : null,
    avg_correct_time_sec: timeCorrectCount ? Math.round(timeCorrectSum / timeCorrectCount) : null,
    avg_incorrect_time_sec: timeIncorrectCount ? Math.round(timeIncorrectSum / timeIncorrectCount) : null,
  };
}

async function runScrape({ page, options = {} }) {
  const sourceId = String(options.sourceId || '').trim();
  const preset = SECTION_PRESETS[sourceId];
  if (!preset) {
    throw new ScrapeAnomalyError(
      `Unknown TTP sourceId "${sourceId}". Expected one of ${Object.keys(SECTION_PRESETS).join(', ')}.`
    );
  }
  if (!TTP_HOST_RE.test(page.url())) {
    throw new ScrapeAnomalyError(
      `Tab is not on gmat.targettestprep.com (current: ${page.url()}). Sign in there first.`
    );
  }

  const minDelayMs = Number.isFinite(Number(options.minDelayMs)) ? Number(options.minDelayMs) : 1500;
  const maxDelayMs = Number.isFinite(Number(options.maxDelayMs)) ? Number(options.maxDelayMs) : 3000;
  const errorBudget = Math.max(5, Number(options.maxErrors) || 0);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  const indexUrl = `https://gmat.targettestprep.com/error_tracker/${preset.section}`;
  await gotoTtp(page, indexUrl);
  await page.waitForSelector('.error-tracker-list .failure-reason', { timeout: 10000 }).catch(() => null);

  const index = await readSectionIndex(page, preset.section);
  if (!index.rows.length) {
    return {
      extracted_at: new Date().toISOString(),
      config: { sourceId, source: preset.label, section: preset.section, totalQuestions: 0 },
      sessions: [],
      warnings: [{ kind: 'empty', message: 'No mistake-category rows found on the section index.' }],
    };
  }

  onProgress({ phase: 'index', categories: index.rows.length, totalQuestions: index.totalQuestions });

  const sessions = [];
  const errors = [];

  for (const cat of index.rows) {
    const sessionExternalId = hashSessionExternalId(`${preset.section}|${cat.categoryId}`);
    const sessionDate = todayThaiDate();
    const firstPageUrl = `https://gmat.targettestprep.com/error_tracker/${preset.section}/${cat.categoryId}?page=1`;

    let pagerInfo;
    try {
      await gotoTtp(page, firstPageUrl);
      await page.waitForSelector('.exercise-attempt-box', { timeout: 10000 }).catch(() => null);
      pagerInfo = await readPagerLinks(page);
    } catch (err) {
      errors.push({ categoryId: cat.categoryId, page: 1, reason: (err?.message || String(err)).slice(0, 200) });
      if (errors.length >= errorBudget) {
        return {
          extracted_at: new Date().toISOString(),
          config: { sourceId, source: preset.label, section: preset.section },
          sessions,
          warnings: errors,
          aborted: true,
          abortReason: 'too-many-errors',
        };
      }
      continue;
    }

    const totalPages = Math.max(pagerInfo.total || 0, pagerInfo.hrefs.length || 0, 1);
    onProgress({ phase: 'category_start', categoryId: cat.categoryId, mistake: cat.mistakeText, total: totalPages });

    const questions = [];
    for (let i = 0; i < totalPages; i += 1) {
      // Use the dropdown's own href when available (handles future URL changes
      // without us guessing). Otherwise build a ?page=K url.
      let pageUrl;
      if (pagerInfo.hrefs[i]) {
        try {
          pageUrl = new URL(pagerInfo.hrefs[i], page.url()).toString();
        } catch (_e) {
          pageUrl = `https://gmat.targettestprep.com/error_tracker/${preset.section}/${cat.categoryId}?page=${i + 1}`;
        }
      } else {
        pageUrl = `https://gmat.targettestprep.com/error_tracker/${preset.section}/${cat.categoryId}?page=${i + 1}`;
      }

      // Skip the navigation we already did for page 1 — reuse the current DOM.
      try {
        if (i > 0) {
          await gotoTtp(page, pageUrl);
          await page.waitForSelector('.exercise-attempt-box', { timeout: 10000 }).catch(() => null);
        }
        const data = await readCategoryPage(page, {
          section: preset.section,
          categoryId: cat.categoryId,
          mistakeText: cat.mistakeText,
        });
        if (!data?.ok) {
          errors.push({ categoryId: cat.categoryId, page: i + 1, reason: data?.reason || 'extraction-failed' });
          if (errors.length >= errorBudget) {
            sessions.push({
              session_id: sessionExternalId,
              date: sessionDate,
              source: preset.label,
              subject: preset.subjectCode,
              stats: summarizeQuestions(questions),
              questions,
            });
            return {
              extracted_at: new Date().toISOString(),
              config: { sourceId, source: preset.label, section: preset.section },
              sessions,
              warnings: errors,
              aborted: true,
              abortReason: 'too-many-errors',
            };
          }
          continue;
        }
        questions.push(buildQuestionRecord({
          pageData: data,
          mistakeText: cat.mistakeText,
          sectionPreset: preset,
        }));
        onProgress({
          phase: 'page_done',
          categoryId: cat.categoryId,
          page: i + 1,
          total: totalPages,
          attempt_id: data.attempt_id,
        });
      } catch (err) {
        errors.push({ categoryId: cat.categoryId, page: i + 1, reason: (err?.message || String(err)).slice(0, 200) });
        if (errors.length >= errorBudget) {
          sessions.push({
            session_id: sessionExternalId,
            date: sessionDate,
            source: preset.label,
            subject: preset.subjectCode,
            stats: summarizeQuestions(questions),
            questions,
          });
          return {
            extracted_at: new Date().toISOString(),
            config: { sourceId, source: preset.label, section: preset.section },
            sessions,
            warnings: errors,
            aborted: true,
            abortReason: 'too-many-errors',
          };
        }
      }

      if (i < totalPages - 1) {
        await sleep(jitter(minDelayMs, maxDelayMs));
      }
    }

    sessions.push({
      session_id: sessionExternalId,
      date: sessionDate,
      source: preset.label,
      subject: preset.subjectCode,
      stats: summarizeQuestions(questions),
      questions,
    });
    onProgress({ phase: 'category_done', categoryId: cat.categoryId, count: questions.length });
  }

  return {
    extracted_at: new Date().toISOString(),
    config: { sourceId, source: preset.label, section: preset.section, totalQuestions: index.totalQuestions },
    sessions,
    warnings: errors,
  };
}

module.exports = {
  SECTION_PRESETS,
  ScrapeAnomalyError,
  runScrape,
  _internals: {
    hashSessionExternalId,
    readSectionIndex,
    readCategoryPage,
    readPagerLinks,
    parseTimeMmSs,
    todayThaiDate,
    buildQuestionRecord,
    summarizeQuestions,
  },
};
