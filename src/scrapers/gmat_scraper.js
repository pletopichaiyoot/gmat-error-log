/**
 * GMAT Official Practice — Two-Part Data Scraper
 * ===============================================
 * Paste this entire script into DevTools console on:
 *   https://gmatofficialpractice.mba.com/app/gmat-official-guide-2024-2025-verbal-review-online-question-bank
 *
 * PART 1 — run first (fast, ~3s per session):
 *   const data = await scrapePart1(CONFIG);
 *   console.log(JSON.stringify(data));
 *
 * PART 2 — run after Part 1 (slow, ~1.5s per wrong answer):
 *   const details = await scrapePart2(data.sessions, CONFIG);
 *   console.log(JSON.stringify(details));
 *
 * Together these produce everything needed to populate the spreadsheet
 * AND build a future progress-visualisation tool.
 */

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  clientId:          789329902,
  since:             '20260101000000',   // YYYYMMDDHHmmss — fetch activities after this date
  reviewCategoryId:  null,               // optional fixed category; null = auto-detect per session
  source:            'OG Verbal Review 2024-2025',
  pageWaitMs:        3200,               // ms to wait after hash navigation
  nextPageWaitMs:    2600,               // ms to wait after clicking "Next" in pagination
  reviewReadyTimeoutMs: 18000,           // ms to wait for review answer DOM to stabilize
};
const THAI_TIME_ZONE = 'Asia/Bangkok';

// ── HELPERS ───────────────────────────────────────────────────────────────────

function parseTimeSec(str) {
  // "3 mins 34 secs"  →  214
  // "45 secs"         →  45
  // "00:02:19"        →  139
  // "2:35"            →  155
  if (!str) return 0;
  if (str.includes(':')) {
    const parts = str
      .split(':')
      .map((part) => Number(part))
      .filter((part) => Number.isFinite(part));
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return 0;
  }
  const m = str.match(/(?:(\d+)\s*mins?\s*)?(\d+)\s*secs?/);
  return m ? (parseInt(m[1] || 0) * 60 + parseInt(m[2] || 0)) : 0;
}

function formatYmdInTimeZone(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

function toThaiDateOnly(rawValue) {
  if (!rawValue) return null;
  const parsed = new Date(rawValue);
  if (!Number.isNaN(parsed.getTime())) return formatYmdInTimeZone(parsed, THAI_TIME_ZONE);
  const text = String(rawValue).trim();
  const dayOnly = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return dayOnly || null;
}

function extractActivityDate(activityData = {}) {
  const candidates = [
    activityData.client_created_at,
    activityData.created_at,
    activityData.client_updated_at,
    activityData.updated_at,
  ];
  for (const candidate of candidates) {
    const thaiDate = toThaiDateOnly(candidate);
    if (thaiDate) return thaiDate;
  }
  return null;
}

function inferTimestampTimezoneLabel(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return 'unknown';
  if (/z$/i.test(value)) return 'UTC (Z)';
  const offsetMatch = value.match(/([+-]\d{2}:?\d{2})$/);
  if (offsetMatch) return `offset ${offsetMatch[1]}`;
  return 'no offset in timestamp (likely client-local)';
}

function sourceFamily(source) {
  const text = String(source || '').toLowerCase();
  if (text.includes('data insights') || /\bdi\b/.test(text)) return 'DI';
  if (text.includes('quant')) return 'Quant';
  if (text.includes('verbal')) return 'Verbal';
  return 'Mixed';
}

function detectClientIdFromPage() {
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
}

function shouldInferTopic(source, sessionSubject) {
  const family = sourceFamily(source);
  if (family === 'Verbal') return true;
  const subject = String(sessionSubject || '').trim().toUpperCase();
  return subject === 'CR' || subject === 'RC' || subject === 'VERBAL';
}

function extractIdCandidatesFromActivity(activityData = {}) {
  const ids = [];
  const contentLocation = String(activityData.content_location || '');

  const questionIdFromLocation = contentLocation.match(/questions:([^/]+)/i)?.[1];
  if (questionIdFromLocation) ids.push(String(questionIdFromLocation));

  const answerIdFromLocation = contentLocation.match(/answers:([^/]+)/i)?.[1];
  if (answerIdFromLocation) ids.push(String(answerIdFromLocation));

  return Array.from(new Set(ids.filter(Boolean))).slice(0, 2);
}

function isCompletedAnswerActivity(activity) {
  if (activity?.activity_type !== 'answer') return false;
  const data = activity?.activity_data || {};
  const incompleteValue = data?.incomplete;
  if (incompleteValue === true) return false;
  if (String(incompleteValue || '').toLowerCase() === 'true') return false;
  return true;
}

function normalizeSubSubject(question) {
  const direct = String(question?.subject_sub_raw || question?.subject_sub || '')
    .trim()
    .toUpperCase();
  if (direct === 'CR' || direct === 'RC' || direct === 'PS' || direct === 'DS') return direct;
  if (direct === 'MSR' || direct === 'TA' || direct === 'GI' || direct === 'TPA' || direct === 'DI') return direct;
  if (direct === 'QUANT') return 'QUANT';
  if (direct === 'VERBAL') return 'VERBAL';

  const catId = Number(question?.cat_id);
  if (catId === 1337013) return 'CR';
  if (catId === 1337023) return 'RC';
  if (catId >= 1336700 && catId <= 1336899) return 'DI';

  const label = String(question?.cat_label || '').toLowerCase();
  if (!label) return null;

  if (label.includes('critical reasoning') || /\bcr\b/.test(label)) return 'CR';
  if (label.includes('reading comprehension') || /\brc\b/.test(label)) return 'RC';
  if (label.includes('problem solving') || /\bps\b/.test(label)) return 'PS';
  if (label.includes('data sufficiency') || /\bds\b/.test(label)) return 'DS';
  if (label.includes('two-part analysis')) return 'TPA';
  if (label.includes('table analysis')) return 'TA';
  if (label.includes('graphics interpretation')) return 'GI';
  if (label.includes('multi-source reasoning')) return 'MSR';

  return null;
}

function subSubjectGroup(subSubject) {
  const value = String(subSubject || '').trim().toUpperCase();
  if (!value) return null;
  if (value === 'DS') return 'DS';
  if (value === 'TPA' || value === 'TA' || value === 'GI' || value === 'MSR' || value === 'DI') return 'DI';
  if (value === 'CR' || value === 'RC' || value === 'VERBAL') return value === 'VERBAL' ? 'Verbal' : value;
  if (value === 'PS' || value === 'QUANT') return value === 'QUANT' ? 'Quant' : value;
  return null;
}

function detectSubSubjectCodeFromText(rawValue) {
  const text = String(rawValue || '').toLowerCase();
  if (!text) return null;

  const mentions = [];
  if (text.includes('data sufficiency')) mentions.push('DS');
  if (text.includes('multi-source reasoning')) mentions.push('MSR');
  if (text.includes('table analysis')) mentions.push('TA');
  if (text.includes('graphics interpretation')) mentions.push('GI');
  if (text.includes('two-part analysis')) mentions.push('TPA');
  if (text.includes('critical reasoning')) mentions.push('CR');
  if (text.includes('reading comprehension')) mentions.push('RC');
  if (text.includes('problem solving')) mentions.push('PS');

  const unique = Array.from(new Set(mentions));
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) return null;
  return null;
}

function detectSubSubjectGroupFromText(rawValue) {
  return subSubjectGroup(detectSubSubjectCodeFromText(rawValue));
}

function detectSubSubjectCodeFromCurrentPage() {
  const selector =
    'h1,h2,h3,[class*="title"],[class*="heading"],[class*="breadcrumb"],[class*="header"],[class*="category"],[class*="subtitle"]';
  const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 40);
  for (const node of nodes) {
    const text = node?.innerText?.trim();
    if (!text) continue;
    const detected = detectSubSubjectCodeFromText(text);
    if (detected) return detected;
  }

  const lines = String(document.body?.innerText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 80);
  for (const line of lines) {
    const detected = detectSubSubjectCodeFromText(line);
    if (detected) return detected;
  }

  const bodyDetected = detectSubSubjectCodeFromText(document.body?.innerText || '');
  if (bodyDetected) return bodyDetected;
  return null;
}

function detectSubSubjectGroupFromCurrentPage() {
  return subSubjectGroup(detectSubSubjectCodeFromCurrentPage());
}

function diSubtopicFromSubSubject(subSubject) {
  const value = String(subSubject || '').trim().toUpperCase();
  if (!value) return '';
  if (value === 'DS') return 'Data Sufficiency';
  if (value === 'MSR') return 'Multi-Source Reasoning';
  if (value === 'TA') return 'Table Analysis';
  if (value === 'GI') return 'Graphics Interpretation';
  if (value === 'TPA') return 'Two-Part Analysis';
  return '';
}

function mergeCategorySubCodeHints(targetMap, nextMap) {
  if (!(targetMap instanceof Map) || !(nextMap instanceof Map)) return targetMap;
  for (const [catId, code] of nextMap.entries()) {
    const num = Number(catId);
    const nextCode = String(code || '').trim().toUpperCase();
    if (!Number.isInteger(num) || !nextCode) continue;
    const existing = String(targetMap.get(num) || '').trim().toUpperCase();
    if (!existing) {
      targetMap.set(num, nextCode);
      continue;
    }
    if (existing === 'DI' && nextCode !== 'DI') {
      targetMap.set(num, nextCode);
    }
  }
  return targetMap;
}

function subSubjectFamily(subSubject) {
  if (subSubject === 'CR' || subSubject === 'RC' || subSubject === 'VERBAL') return 'Verbal';
  if (subSubject === 'PS' || subSubject === 'QUANT') return 'Quant';
  if (subSubject === 'DS' || subSubject === 'TPA' || subSubject === 'TA' || subSubject === 'GI' || subSubject === 'MSR' || subSubject === 'DI') {
    return 'DI';
  }
  return 'Mixed';
}

function extractCategoryLabel(activityData = {}) {
  const directKeys = [
    'question_category_name',
    'question_category_title',
    'question_category',
    'category_name',
    'category_title',
    'question_type_name',
    'question_type',
  ];

  for (const key of directKeys) {
    const value = activityData[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  const objects = [activityData.question_category, activityData.category];
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    if (name) return name;
    if (title) return title;
  }

  return null;
}

function normalizeTopicLabel(rawValue) {
  if (!rawValue) return '';
  const text = String(rawValue).trim().toLowerCase();
  if (!text) return '';

  if (/undermin|weaken/.test(text)) return 'Weaken';
  if (/strengthen|support\b(?!.*must be true)/.test(text)) return 'Strengthen';
  if (/paradox|discrepancy|resolve|explain/.test(text)) return 'Explain';
  if (/infer|inference|conclude|must be true|best supported/.test(text)) return 'Inference';
  if (/assumption|presuppose|depends on/.test(text)) return 'Assumption';
  if (/boldface|role of .*bold|function of .*bold/.test(text)) return 'Boldface';
  if (/evaluate|most useful to know|would be most relevant/.test(text)) return 'Evaluate';
  if (/flaw|vulnerable to criticism|questionable because/.test(text)) return 'Flaw';
  if (/parallel/.test(text)) return 'Parallel';
  if (/complete.*passage|complete.*argument|completes the argument/.test(text)) return 'Complete';
  if (/method|technique|strategy|approach|reasoning proceeds/.test(text)) return 'Method';

  if (/main point|main idea|primary purpose|central idea/.test(text)) return 'Main Idea';
  if (/according to the passage|explicitly states|detail/.test(text)) return 'Detail';
  if (/purpose of|serves to|function of/.test(text)) return 'Purpose';
  if (/author('|’)s attitude|tone/.test(text)) return 'Author Attitude';
  if (/organization|structure of the passage/.test(text)) return 'Organization';
  if (/application|apply.*principle|most analogous/.test(text)) return 'Application';

  return '';
}

function topicFromLineLabel(text) {
  if (!text) return '';
  const lineMatches = text.match(
    /^\s*(Inference|Weaken|Strengthen|Assumption|Boldface|Evaluate|Flaw|Parallel|Complete(?:\s+the\s+Passage)?|Method|Main\s+Idea|Detail|Purpose|Author(?:'|’)s\s+Attitude|Organization|Application|Explain)\s*$/gim
  );
  if (lineMatches?.length) {
    const direct = normalizeTopicLabel(lineMatches[0]);
    if (direct) return direct;
  }

  const typed = text.match(/(?:question\s*type|type|category)\s*:\s*([^\n\r]+)/i)?.[1];
  if (typed) return normalizeTopicLabel(typed);

  return '';
}

function extractExplanationText() {
  const selectors = [
    '[class*="explanation"]',
    '[id*="explanation"]',
    '[data-testid*="explanation"]',
    '[class*="rationale"]',
    '[class*="analysis"]',
    '[class*="review"]',
  ];

  const chunks = [];
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const node of nodes) {
      const value = node?.innerText?.trim();
      if (!value || value.length < 20) continue;
      chunks.push(value);
    }
  }

  if (!chunks.length) return '';

  const unique = [];
  const seen = new Set();
  for (const chunk of chunks) {
    if (seen.has(chunk)) continue;
    seen.add(chunk);
    unique.push(chunk);
  }
  return unique.join('\n');
}

function fallbackTopicFromExplanation(explanationText) {
  if (!explanationText) return '';

  const blocked = /^(question|answer|correct|incorrect|confidence|time spent|the question|report content errors|done reviewing|review category|purchase prep|faqs?)\b/i;
  const lines = String(explanationText)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

  for (const line of lines) {
    if (line.length > 40) continue;
    if (line.split(/\s+/).length > 5) continue;
    if (!/[a-z]/i.test(line)) continue;
    if (/[0-9]/.test(line)) continue;
    if (/[.?!,:;]/.test(line)) continue;
    if (blocked.test(line)) continue;
    return line;
  }

  return '';
}

function detectTopic(text) {
  const explanationText = extractExplanationText();
  const combined = [explanationText, text].filter(Boolean).join('\n');

  const explicitLabel = topicFromLineLabel(combined);
  if (explicitLabel) return explicitLabel;

  const normalized = normalizeTopicLabel(combined);
  if (normalized) return normalized;

  const explanationFallback = fallbackTopicFromExplanation(explanationText);
  if (explanationFallback) return explanationFallback;

  return '';
}

function normalizeAnswerLetter(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  const text = String(rawValue).trim().toUpperCase();
  if (!text) return null;
  if (/^[A-E]$/.test(text)) return text;
  if (/^[1-5]$/.test(text)) return String.fromCharCode(64 + Number(text));
  if (/^[0-4]$/.test(text)) return String.fromCharCode(65 + Number(text));
  const explicit = text.match(/\b([A-E])\b/)?.[1];
  if (explicit) return explicit;
  return null;
}

function looksLikeDiCategoryId(value) {
  const num = Number(value);
  if (!Number.isInteger(num)) return false;
  return num >= 1336700 && num < 1336800;
}

function isDiReviewContext(source, sessionSubject, catId, reviewCategoryId) {
  if (sourceFamily(source) === 'DI') return true;
  const subject = String(sessionSubject || '').trim().toUpperCase();
  if (subject === 'DI' || subject === 'TA' || subject === 'GI' || subject === 'MSR' || subject === 'TPA') {
    return true;
  }
  if (looksLikeDiCategoryId(catId)) return true;
  if (looksLikeDiCategoryId(reviewCategoryId)) return true;
  return false;
}

function extractAnswerLettersFromText(text) {
  const content = String(text || '');
  if (!content.trim()) return { my_answer: null, correct_answer: null };

  const patterns = {
    my: [
      /your answer\s*[:\-]\s*([A-E])/i,
      /you answered\s*[:\-]\s*([A-E])/i,
      /selected answer\s*[:\-]\s*([A-E])/i,
    ],
    correct: [
      /correct answer\s*[:\-]\s*([A-E])/i,
      /the correct answer is\s*\(?([A-E])\)?/i,
    ],
  };

  let myAnswer = null;
  let correctAnswer = null;
  for (const regex of patterns.my) {
    const m = content.match(regex);
    if (m?.[1]) {
      myAnswer = normalizeAnswerLetter(m[1]);
      if (myAnswer) break;
    }
  }
  for (const regex of patterns.correct) {
    const m = content.match(regex);
    if (m?.[1]) {
      correctAnswer = normalizeAnswerLetter(m[1]);
      if (correctAnswer) break;
    }
  }

  return {
    my_answer: myAnswer,
    correct_answer: correctAnswer,
  };
}

function inferChoiceLetterFromNode(el, idx) {
  const attrCandidates = [
    el?.getAttribute?.('data-choice'),
    el?.getAttribute?.('data-answer'),
    el?.getAttribute?.('data-option'),
    el?.getAttribute?.('data-letter'),
    el?.getAttribute?.('aria-label'),
    el?.querySelector?.('[data-choice]')?.getAttribute?.('data-choice'),
    el?.querySelector?.('[aria-label]')?.getAttribute?.('aria-label'),
  ];
  for (const value of attrCandidates) {
    const letter = normalizeAnswerLetter(value);
    if (letter) return letter;
  }

  const text = String(el?.innerText || '').trim();
  const leadingLetter = text.match(/^\s*([A-E])[\).:\-\s]/i)?.[1];
  if (leadingLetter) return normalizeAnswerLetter(leadingLetter);

  return ['A', 'B', 'C', 'D', 'E'][idx] ?? String.fromCharCode(65 + idx);
}

function elementLooksSelected(el) {
  if (!el) return false;
  const classText = String(el.className || '').toLowerCase();
  if (
    classText.includes('selected') ||
    classText.includes('active') ||
    classText.includes('chosen') ||
    classText.includes('incorrect')
  ) {
    return true;
  }
  const ariaChecked = String(el.getAttribute?.('aria-checked') || '').toLowerCase();
  if (ariaChecked === 'true') return true;
  if (el.querySelector?.('input:checked')) return true;
  return false;
}

function elementLooksCorrect(el) {
  if (!el) return false;
  const classText = String(el.className || '').toLowerCase();
  if (classText.includes('corrected') || classText.includes('is-correct') || classText.includes('correct-answer')) {
    return true;
  }
  if (el.querySelector?.('[class*="corrected"], [class*="is-correct"], [class*="correct-answer"]')) return true;
  return false;
}

function elementLooksIncorrect(el) {
  if (!el) return false;
  const classText = String(el.className || '').toLowerCase();
  if (classText.includes('incorrect') || classText.includes('is-incorrect')) {
    return true;
  }
  if (el.querySelector?.('[class*="incorrect"], [class*="is-incorrect"]')) return true;
  return false;
}

function extractAnswersFromChoiceDom() {
  const selectors = [
    '.question-choices-multi .multi-choice',
    '[class*="question-choices"] .multi-choice',
    '[class*="question-choices"] [class*="choice"]',
  ];

  let choiceEls = [];
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    if (nodes.length > choiceEls.length) choiceEls = nodes;
  }
  if (!choiceEls.length) return { my_answer: null, correct_answer: null, selected_answer: null };

  let myAnswer = null;
  let correctAnswer = null;
  let selectedAnswer = null;

  choiceEls.forEach((el, idx) => {
    const letter = inferChoiceLetterFromNode(el, idx);
    if (!selectedAnswer && elementLooksSelected(el)) selectedAnswer = letter;
    if (!myAnswer && elementLooksIncorrect(el)) myAnswer = letter;
    if (!correctAnswer && elementLooksCorrect(el)) correctAnswer = letter;
  });

  return {
    my_answer: normalizeAnswerLetter(myAnswer),
    correct_answer: normalizeAnswerLetter(correctAnswer),
    selected_answer: normalizeAnswerLetter(selectedAnswer),
  };
}

function derivedSubject(questions, source) {
  const subSubjects = Array.from(
    new Set(
      (questions || [])
        .map((q) => normalizeSubSubject(q))
        .filter(Boolean)
    )
  );

  if (subSubjects.length === 1) {
    const only = subSubjects[0];
    if (only === 'MSR' || only === 'TA' || only === 'GI' || only === 'TPA' || only === 'DI') return 'DI';
    if (only === 'VERBAL') return 'Verbal';
    if (only === 'QUANT') return 'Quant';
    return only;
  }
  if (subSubjects.length > 1) {
    const families = Array.from(new Set(subSubjects.map((item) => subSubjectFamily(item))));
    if (families.length === 1 && families[0] !== 'Mixed') return families[0];
    return sourceFamily(source);
  }

  return sourceFamily(source);
}

function parseReviewRoute(value) {
  if (!value) return null;
  const raw = String(value);
  const match = raw.match(/custom-quiz\/(\d+)\/review\/categories\/(\d+)\/([^/?#]+)/i);
  if (!match) return null;

  return {
    session_id: Number(match[1]),
    cat_id: Number(match[2]),
    q_id: match[3],
  };
}

function parseCategoryRoute(value) {
  if (!value) return null;
  const raw = String(value);
  const match = raw.match(/custom-quiz\/(\d+)\/categories\/(\d+)/i);
  if (!match) return null;

  return {
    session_id: Number(match[1]),
    cat_id: Number(match[2]),
  };
}

function toAbsoluteQuestionUrl(routeOrUrl) {
  if (!routeOrUrl) return null;
  const raw = String(routeOrUrl).trim().replace(/##+/g, '#');
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('#')) return `https://gmatofficialpractice.mba.com/${raw}`;
  if (raw.startsWith('/')) return `https://gmatofficialpractice.mba.com${raw}`;
  if (raw.startsWith('custom-quiz/')) return `https://gmatofficialpractice.mba.com/#${raw}`;
  return null;
}

function extractReviewTargetFromRow(row) {
  if (!row) return null;

  const directAnchor = row.querySelector('a[href*="review/categories/"]');
  if (directAnchor) {
    const href = directAnchor.getAttribute('href');
    const parsed = parseReviewRoute(href);
    if (parsed) return { ...parsed, question_url: toAbsoluteQuestionUrl(href) };
  }

  const attrs = ['href', 'data-href', 'data-url', 'data-link'];
  const nodes = [row, ...row.querySelectorAll('*')];
  for (const node of nodes) {
    for (const attr of attrs) {
      const value = node.getAttribute?.(attr);
      const parsed = parseReviewRoute(value);
      if (parsed) return { ...parsed, question_url: toAbsoluteQuestionUrl(value) };
    }

    const onclick = node.getAttribute?.('onclick');
    const parsedOnclick = parseReviewRoute(onclick);
    if (parsedOnclick) {
      return { ...parsedOnclick, question_url: toAbsoluteQuestionUrl(`#custom-quiz/${parsedOnclick.session_id}/review/categories/${parsedOnclick.cat_id}/${parsedOnclick.q_id}`) };
    }
  }

  return null;
}

function dedupeWrongRefs(items) {
  const seen = new Set();
  const output = [];
  for (const item of items || []) {
    if (!item?.q_id) continue;
    const key = `${item.q_id}_${item.cat_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function categoryRowKey(row = {}) {
  const qId = String(row.q_id || '').trim();
  const qCode = String(row.q_code || '').trim();
  const correctness = row.correct ? 1 : 0;
  const timeSec = Number(row.time_sec) || 0;
  const difficulty = String(row.difficulty || '').trim().toLowerCase();

  if (qId) return `id:${qId}:${qCode}:${correctness}:${timeSec}:${difficulty}`;
  if (qCode) return `code:${qCode}:${correctness}:${timeSec}:${difficulty}`;

  return `raw:${difficulty}:${correctness}:${timeSec}:${String(
    row.question_url || ''
  )}`;
}

function selectPreferredSubjectSub(existingValue, incomingValue) {
  const existing = String(existingValue || '').trim();
  const incoming = String(incomingValue || '').trim();
  if (!incoming) return existing || null;
  if (!existing) return incoming;
  if (existing === incoming) return existing;
  if (existing === 'DI' && incoming === 'DS') return incoming;
  return existing;
}

function mergeUniqueCategoryRows(existingRows = [], incomingRows = []) {
  const merged = [...existingRows];
  const seen = new Map();
  merged.forEach((row, idx) => {
    seen.set(categoryRowKey(row), idx);
  });

  for (const row of incomingRows) {
    const key = categoryRowKey(row);
    if (seen.has(key)) {
      const index = seen.get(key);
      const current = merged[index] || {};
      merged[index] = {
        ...current,
        q_code: current.q_code || row.q_code || null,
        q_id: current.q_id || row.q_id || null,
        cat_id: current.cat_id || row.cat_id || null,
        question_url: current.question_url || row.question_url || null,
        subject_sub: selectPreferredSubjectSub(current.subject_sub, row.subject_sub),
        subject_sub_raw: current.subject_sub_raw || row.subject_sub_raw || null,
        topic: current.topic || row.topic || null,
      };
      continue;
    }
    seen.set(key, merged.length);
    merged.push(row);
  }

  return merged;
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function enqueueCategoryCandidates(queue, seenQueued, values = []) {
  for (const value of values) {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) continue;
    if (seenQueued.has(num)) continue;
    seenQueued.add(num);
    queue.push(num);
  }
}

function dedupeNumeric(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) continue;
    if (seen.has(num)) continue;
    seen.add(num);
    out.push(num);
  }
  return out;
}

function parentCategoryFromQuestionCategory(catId) {
  const num = Number(catId);
  if (!Number.isInteger(num) || num <= 10) return null;
  return num - 10;
}

function installPageErrorTracker() {
  if (window.__gmatScraperPageErrorTrackerInstalled) return;
  window.__gmatScraperPageErrorTrackerInstalled = true;
  window.__gmatScraperPageErrors = window.__gmatScraperPageErrors || [];
  window.addEventListener('error', (event) => {
    const message = event?.error?.stack || event?.message || 'unknown page error';
    window.__gmatScraperPageErrors.push({
      at: new Date().toISOString(),
      message: String(message),
    });
    if (window.__gmatScraperPageErrors.length > 200) window.__gmatScraperPageErrors.shift();
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason?.stack || event?.reason?.message || event?.reason || 'unhandled rejection';
    window.__gmatScraperPageErrors.push({
      at: new Date().toISOString(),
      message: String(reason),
    });
    if (window.__gmatScraperPageErrors.length > 200) window.__gmatScraperPageErrors.shift();
  });
}

function pageErrorCount() {
  return Array.isArray(window.__gmatScraperPageErrors) ? window.__gmatScraperPageErrors.length : 0;
}

async function navigateHashSafe(hashValue, waitMs) {
  const beforeErrors = pageErrorCount();
  window.location.hash = hashValue;
  await wait(waitMs);
  const afterErrors = pageErrorCount();
  return {
    hadPageError: afterErrors > beforeErrors,
    newPageErrors: afterErrors - beforeErrors,
  };
}

function extractCategoryCandidatesFromCurrentPage(sessionId) {
  const values = [];
  const attrs = ['href', 'data-href', 'data-url', 'data-link', 'onclick'];
  const nodes = [document.body, ...document.querySelectorAll('*')];

  for (const node of nodes) {
    for (const attr of attrs) {
      const raw = node?.getAttribute?.(attr);
      const parsed = parseCategoryRoute(raw);
      if (!parsed) continue;
      if (Number(parsed.session_id) !== Number(sessionId)) continue;
      values.push(parsed.cat_id);
    }
  }

  return dedupeNumeric(values);
}

function extractCategorySubCodesFromCurrentPage(sessionId) {
  const out = new Map();

  const categoryRows = Array.from(document.querySelectorAll('[data-id].category.content,[data-id][class*="category"][class*="content"]'));
  for (const row of categoryRows) {
    const catId = Number(row.getAttribute('data-id'));
    if (!Number.isInteger(catId) || catId <= 0) continue;
    const text = String(row.innerText || row.textContent || '').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const code = detectSubSubjectCodeFromText(text);
    if (!code) continue;
    const current = String(out.get(catId) || '').trim().toUpperCase();
    if (!current || (current === 'DI' && code !== 'DI')) {
      out.set(catId, code);
    }
  }

  const attrs = ['href', 'data-href', 'data-url', 'data-link', 'onclick'];
  const nodes = [document.body, ...document.querySelectorAll('*')];

  for (const node of nodes) {
    let parsed = null;
    for (const attr of attrs) {
      const raw = node?.getAttribute?.(attr);
      parsed = parseCategoryRoute(raw);
      if (parsed) break;
    }
    if (!parsed) continue;
    if (Number(parsed.session_id) !== Number(sessionId)) continue;

    const textCandidates = [
      node?.innerText,
      node?.textContent,
      node?.getAttribute?.('aria-label'),
      node?.getAttribute?.('title'),
    ];

    for (const rawText of textCandidates) {
      const text = String(rawText || '').trim();
      if (!text) continue;
      if (text.length > 220) continue;
      if ((text.match(/\n/g) || []).length > 2) continue;
      const code = detectSubSubjectCodeFromText(text);
      if (!code) continue;
      const current = String(out.get(parsed.cat_id) || '').trim().toUpperCase();
      if (!current || (current === 'DI' && code !== 'DI')) {
        out.set(parsed.cat_id, code);
      }
      const parent = parentCategoryFromQuestionCategory(parsed.cat_id);
      if (parent) {
        const parentCurrent = String(out.get(parent) || '').trim().toUpperCase();
        if (!parentCurrent || (parentCurrent === 'DI' && code !== 'DI')) {
          out.set(parent, code);
        }
      }
    }
  }

  return out;
}

async function scrapeCategoryRowsFromCurrentPage(cfg = CONFIG) {
  const catQs = [];

  while (true) {
    const diffEls = document.querySelectorAll('[class*="difficulty"][class*="li-cell"]');
    diffEls.forEach(diffEl => {
      const diff = diffEl.className.match(/\b(hard|medium|easy)\b/i)?.[1];
      if (!diff) return;

      let row = diffEl.parentElement;
      for (let i = 0; i < 5; i++) {
        if (row?.querySelector('[class*="correctness"]') && row?.querySelector('[class*="difficulty faded"]')) break;
        row = row?.parentElement;
      }
      if (!row) return;

      const correct    = !row.querySelector('[class*="correctness"]')?.className?.includes('incorrect');
      const confidence = row.querySelector('[class*="confidence"]')?.getAttribute('data-confidence') ?? 'not selected';
      const preview    = row.querySelector('[class*="preview"]')?.innerText?.trim() ?? '';
      const timeStr    = row.querySelector('[class*="time"]')?.innerText?.trim() ?? '';
      const q_code     = preview.match(/^(\d{6})\b/)?.[1] ?? null;
      const reviewRef  = extractReviewTargetFromRow(row);

      catQs.push({
        q_code,
        correct,
        difficulty:  diff.charAt(0).toUpperCase() + diff.slice(1),
        confidence,
        time_sec:    parseTimeSec(timeStr),
        q_id:        reviewRef?.q_id || null,
        cat_id:      reviewRef?.cat_id || null,
        question_url: reviewRef?.question_url || null,
      });
    });

    const m = document.body.innerText.match(/Displaying (\d+) - (\d+) of (\d+)/);
    if (!m || parseInt(m[2]) >= parseInt(m[3])) break;
    const nextBtn = Array.from(document.querySelectorAll('a,button')).find(e => e.innerText?.trim() === 'Next');
    if (!nextBtn) break;
    nextBtn.click();
    await wait(cfg.nextPageWaitMs);
  }

  return catQs;
}

function countAnswerChoiceNodes() {
  const selectors = [
    '.question-choices-multi .multi-choice',
    '.question-choices-multi [class*="choice"]',
    '[class*="question-choices"] .multi-choice',
    '[class*="question-choices"] [class*="choice"]',
  ];

  for (const selector of selectors) {
    const count = document.querySelectorAll(selector).length;
    if (count > 0) return count;
  }
  return 0;
}

async function waitForReviewReady(sessionId, reviewCatId, qId, cfg = CONFIG, expectedQCode = null) {
  const timeoutMs = Number(cfg.reviewReadyTimeoutMs) || Math.max(Number(cfg.pageWaitMs || 0) * 4, 10000);
  const start = Date.now();
  const expectedRoutePart = `custom-quiz/${sessionId}/review/categories/${reviewCatId}/`;
  const normalizedExpectedQCode = expectedQCode ? String(expectedQCode) : null;

  while (Date.now() - start < timeoutMs) {
    const hash = window.location.hash || '';
    const parsedRoute = parseReviewRoute(hash);
    const routeReady =
      parsedRoute &&
      Number(parsedRoute.session_id) === Number(sessionId) &&
      Number(parsedRoute.cat_id) === Number(reviewCatId);
    const hashReady = hash.includes(expectedRoutePart);
    const choiceCount = countAnswerChoiceNodes();
    const currentQCode = document.body.innerText.match(/\b(\d{6})\b/)?.[1] ?? null;
    const qCodeReady = !normalizedExpectedQCode || currentQCode === normalizedExpectedQCode;
    const qIdReady =
      parsedRoute?.q_id
        ? String(parsedRoute.q_id) === String(qId)
        : hash.includes(`/${qId}`);

    if ((routeReady || hashReady) && choiceCount > 0 && qCodeReady && (qIdReady || !normalizedExpectedQCode)) {
      return {
        ready: true,
        routeQId: parsedRoute?.q_id ? String(parsedRoute.q_id) : String(qId),
        routeCatId: parsedRoute?.cat_id ? Number(parsedRoute.cat_id) : Number(reviewCatId),
      };
    }
    await wait(200);
  }

  return {
    ready: false,
    routeQId: null,
    routeCatId: null,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// PART 1 — Categories page scraper
//   Output: session-level stats + per-question {q_code, difficulty, correct,
//           confidence, time_sec} for ALL questions answered
// ═══════════════════════════════════════════════════════════════════════════════

async function scrapePart1(cfg = CONFIG) {
  installPageErrorTracker();
  // ── Step 1a: Fetch all answer activities via API ──────────────────────────
  const pageClientId = detectClientIdFromPage();
  const configuredClientId = Number(cfg.clientId);
  const runtimeClientId = pageClientId || (Number.isInteger(configuredClientId) ? configuredClientId : null);
  if (!runtimeClientId) throw new Error('Unable to detect client_id. Open a GMAT app tab and stay logged in.');
  if (pageClientId && configuredClientId && pageClientId !== configuredClientId) {
    console.log(`ℹ️ Using client_id ${pageClientId} from page (CONFIG had ${configuredClientId}).`);
  }

  console.log('📡 Fetching activities API…');
  const res = await fetch(`/api/v2/activities.json?since=${cfg.since}&client_id=${runtimeClientId}`);
  if (!res.ok) throw new Error(`Activities API error: ${res.status}`);
  const allActivities = await res.json();

  const rawAnswers = allActivities.filter(a => a.activity_type === 'answer');
  const answers = rawAnswers.filter(isCompletedAnswerActivity);
  const skippedIncomplete = rawAnswers.length - answers.length;
  const sampleTimestamp = answers.find((item) => item?.activity_data?.client_created_at)?.activity_data?.client_created_at;
  const gmatTimestampTimezone = inferTimestampTimezoneLabel(sampleTimestamp);
  console.log(
    `  ${answers.length} answer activities found` +
      (skippedIncomplete > 0 ? ` (${skippedIncomplete} incomplete skipped)` : '')
  );
  console.log(
    `  Timestamp basis: GMAT client_created_at=${gmatTimestampTimezone}; normalizing session dates to ${THAI_TIME_ZONE}.`
  );

  // Group by session: build sid → {date, avgSec, total, errors, catIds, questions[]}
  const apiSessions = {};
  for (const a of answers) {
    const d = a.activity_data;
    const sid = d.user_configured_quiz_session_id;
    if (!apiSessions[sid]) apiSessions[sid] = { sid, questions: [], catIds: new Set() };
    const s = apiSessions[sid];
    const idCandidates = extractIdCandidatesFromActivity(d);
    const catLabel = extractCategoryLabel(d);
    const apiSubRaw = normalizeSubSubject({
      cat_id: d.question_category_id,
      cat_label: catLabel,
    });
    const apiSub = subSubjectGroup(apiSubRaw);
    const apiDiTopic = diSubtopicFromSubSubject(apiSubRaw);
    s.questions.push({
      q_id:       idCandidates[0] || null,
      q_id_candidates: idCandidates,
      correct:    d.correct,
      user_answer: d.user_answer ?? null,
      time_sec:   d.time_taken ?? 0,
      cat_id:     d.question_category_id,
      cat_label:  catLabel,
      subject_sub: apiSub || null,
      subject_sub_raw: apiSubRaw || null,
      topic: apiDiTopic || null,
    });
    s.catIds.add(d.question_category_id);
    const activityDate = extractActivityDate(d);
    if (activityDate && (!s.date || activityDate > s.date)) {
      s.date = activityDate;
    }
  }

  // ── Step 1b: Scrape each session's categories page for difficulty + q_code ─
  const sids = Object.keys(apiSessions);
  console.log(`🔍 Scraping ${sids.length} sessions from categories page…`);

  const sessions = [];

  for (const sid of sids) {
    const apiS = apiSessions[sid];
    const apiByQId = new Map(
      (apiS.questions || [])
        .filter((q) => q?.q_id)
        .map((q) => [String(q.q_id), q])
    );
    const subGroupByCategory = new Map();
    const subCodeByCategory = new Map();
    for (const apiQ of apiS.questions || []) {
      const directCat = Number(apiQ?.cat_id);
      const directSubRaw = String(apiQ?.subject_sub_raw || normalizeSubSubject(apiQ) || '').trim().toUpperCase();
      const directSub = subSubjectGroup(directSubRaw || apiQ?.subject_sub || normalizeSubSubject(apiQ));
      if (Number.isInteger(directCat) && directSub && !subGroupByCategory.has(directCat)) {
        subGroupByCategory.set(directCat, directSub);
      }
      if (Number.isInteger(directCat) && directSubRaw && !subCodeByCategory.has(directCat)) {
        subCodeByCategory.set(directCat, directSubRaw);
      }
      const parentCat = parentCategoryFromQuestionCategory(directCat);
      if (Number.isInteger(parentCat) && directSub && !subGroupByCategory.has(parentCat)) {
        subGroupByCategory.set(parentCat, directSub);
      }
      if (Number.isInteger(parentCat) && directSubRaw && !subCodeByCategory.has(parentCat)) {
        subCodeByCategory.set(parentCat, directSubRaw);
      }
    }

    await navigateHashSafe(`custom-quiz/${sid}`, cfg.pageWaitMs);
    const discoveredCategoryIds = extractCategoryCandidatesFromCurrentPage(sid);
    const pageSubCodeHints = extractCategorySubCodesFromCurrentPage(sid);

    const apiCatIds = Array.from(apiS.catIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id))
      .sort((a, b) => a - b);
    const derivedParents = apiCatIds.map(parentCategoryFromQuestionCategory).filter(Boolean);
    const initialCategoryCandidates = dedupeNumeric([
      cfg.reviewCategoryId,
      ...discoveredCategoryIds,
      ...Array.from(pageSubCodeHints.keys()),
      ...apiCatIds,
      ...derivedParents,
    ]);

    let reviewCategoryId = null;
    let catQs = [];
    let catQsCombined = [];
    let bodyText = '';
    const attempted = [];
    const categoriesWithRows = [];
    const categoryQueue = [];
    const seenQueuedCategories = new Set();
    enqueueCategoryCandidates(categoryQueue, seenQueuedCategories, initialCategoryCandidates);

    while (categoryQueue.length) {
      const candidate = categoryQueue.shift();
      attempted.push(candidate);
      const navResult = await navigateHashSafe(`custom-quiz/${sid}/categories/${candidate}`, cfg.pageWaitMs);
      mergeCategorySubCodeHints(pageSubCodeHints, extractCategorySubCodesFromCurrentPage(sid));
      const pageSubCode =
        pageSubCodeHints.get(Number(candidate)) ||
        subCodeByCategory.get(Number(candidate)) ||
        detectSubSubjectCodeFromCurrentPage() ||
        null;
      const pageSubGroup = subSubjectGroup(pageSubCode) || subGroupByCategory.get(Number(candidate)) || null;
      const rows = (await scrapeCategoryRowsFromCurrentPage(cfg)).map((row) => {
        const fromApi = row?.q_id ? apiByQId.get(String(row.q_id)) : null;
        const rowCatId = Number(row?.cat_id);
        const rowParentCatId = parentCategoryFromQuestionCategory(rowCatId);
        const rowHintCode = String(
          pageSubCodeHints.get(rowCatId) ||
          pageSubCodeHints.get(rowParentCatId) ||
          subCodeByCategory.get(rowCatId) ||
          subCodeByCategory.get(rowParentCatId) ||
          ''
        )
          .trim()
          .toUpperCase();
        const apiSubCode = String(
          fromApi?.subject_sub_raw ||
          subCodeByCategory.get(Number(fromApi?.cat_id)) ||
          subCodeByCategory.get(parentCategoryFromQuestionCategory(fromApi?.cat_id)) ||
          normalizeSubSubject(fromApi) ||
          ''
        )
          .trim()
          .toUpperCase();
        const resolvedSubCode = rowHintCode || apiSubCode || pageSubCode || '';
        const resolvedGroup =
          subSubjectGroup(resolvedSubCode) ||
          subSubjectGroup(fromApi?.subject_sub || normalizeSubSubject(fromApi)) ||
          pageSubGroup ||
          null;
        const currentTopic = String(row?.topic || '').trim();
        const diTopic = resolvedGroup === 'DI' ? diSubtopicFromSubSubject(resolvedSubCode) : '';
        return {
          ...row,
          subject_sub: resolvedGroup,
          subject_sub_raw: resolvedSubCode || null,
          topic: currentTopic || diTopic || null,
        };
      });
      const discoveredNestedIds = extractCategoryCandidatesFromCurrentPage(sid);
      enqueueCategoryCandidates(categoryQueue, seenQueuedCategories, discoveredNestedIds);
      mergeCategorySubCodeHints(pageSubCodeHints, extractCategorySubCodesFromCurrentPage(sid));
      if (navResult.hadPageError && !rows.length) {
        console.warn(`  ⚠️ ${sid} — category ${candidate} caused page error (${navResult.newPageErrors}), trying next.`);
        continue;
      }
      if (rows.length > 0) {
        if (!reviewCategoryId) reviewCategoryId = candidate;
        categoriesWithRows.push(candidate);
        catQsCombined = mergeUniqueCategoryRows(catQsCombined, rows);
        if (!bodyText) bodyText = document.body.innerText;
      }
    }
    catQs = catQsCombined;
    if (categoriesWithRows.length > 1) {
      console.log(`  ℹ️ ${sid} — merged ${catQs.length} rows across categories: ${categoriesWithRows.join(', ')}`);
    }
    if (!initialCategoryCandidates.length) {
      console.warn(`  ⚠️ ${sid} — no category candidates discovered from page/API.`);
    }

    // Last fallback for unknown route shapes.
    if (!catQs.length) {
      await navigateHashSafe(`custom-quiz/${sid}`, cfg.pageWaitMs);
      mergeCategorySubCodeHints(pageSubCodeHints, extractCategorySubCodesFromCurrentPage(sid));
      const fallbackPageCode =
        pageSubCodeHints.get(Number(reviewCategoryId)) ||
        detectSubSubjectCodeFromCurrentPage();
      const fallbackPageGroup = subSubjectGroup(fallbackPageCode);
      catQs = (await scrapeCategoryRowsFromCurrentPage(cfg)).map((row) => {
        const fromApi = row?.q_id ? apiByQId.get(String(row.q_id)) : null;
        const rowCatId = Number(row?.cat_id);
        const rowParentCatId = parentCategoryFromQuestionCategory(rowCatId);
        const rowHintCode = String(
          pageSubCodeHints.get(rowCatId) ||
          pageSubCodeHints.get(rowParentCatId) ||
          subCodeByCategory.get(rowCatId) ||
          subCodeByCategory.get(rowParentCatId) ||
          ''
        )
          .trim()
          .toUpperCase();
        const apiSubCode = String(
          fromApi?.subject_sub_raw ||
          subCodeByCategory.get(Number(fromApi?.cat_id)) ||
          subCodeByCategory.get(parentCategoryFromQuestionCategory(fromApi?.cat_id)) ||
          normalizeSubSubject(fromApi) ||
          ''
        )
          .trim()
          .toUpperCase();
        const resolvedSubCode = rowHintCode || apiSubCode || fallbackPageCode || '';
        const resolvedGroup =
          subSubjectGroup(resolvedSubCode) ||
          subSubjectGroup(fromApi?.subject_sub || normalizeSubSubject(fromApi)) ||
          fallbackPageGroup ||
          null;
        const currentTopic = String(row?.topic || '').trim();
        const diTopic = resolvedGroup === 'DI' ? diSubtopicFromSubSubject(resolvedSubCode) : '';
        return {
          ...row,
          subject_sub: resolvedGroup,
          subject_sub_raw: resolvedSubCode || null,
          topic: currentTopic || diTopic || null,
        };
      });
      bodyText = document.body.innerText;
      if (!reviewCategoryId) {
        const categoryFromRows = dedupeNumeric(catQs.map((q) => q.cat_id))[0];
        reviewCategoryId = categoryFromRows || discoveredCategoryIds[0] || null;
      }
    }

    const catQsRaw = catQs;
    const scopedCatQs = catQsRaw.filter((q) => q?.q_id && apiByQId.has(String(q.q_id)));
    if (scopedCatQs.length > 0 && scopedCatQs.length < catQsRaw.length) {
      console.warn(
        `  ⚠️ ${sid} — categories rows (${catQsRaw.length}) exceed API-window rows (${apiS.questions.length}); preserving all category rows for review-link accuracy.`
      );
    } else if (!scopedCatQs.length && catQsRaw.length > apiS.questions.length) {
      console.warn(
        `  ⚠️ ${sid} — API window appears partial (${apiS.questions.length}) vs category rows (${catQsRaw.length}); preserving category rows.`
      );
    }

    // Parse session-level stats from the Results header
    const avgMatch  = bodyText.match(/Avg\.\s+Answer\s+Time\s+([\d:]+)/);
    const cAvgMatch = bodyText.match(/Avg\.\s+Correct\s+Answer\s+Time\s+([\d:]+)/);
    const wAvgMatch = bodyText.match(/Avg\.\s+Incorrect\s+Answer\s+Time\s+([\d:]+)/);
    const accMatch  = bodyText.match(/(\d+(?:\.\d+)?)\s*%\s*Correct/);

    // Merge API question data (q_id, user_answer) with categories data (q_code, difficulty, confidence)
    // Align by order within the session: API questions are in answered order;
    // match by correct/time as a heuristic, or just keep them separate arrays.
    // Best-effort: build q_id→q_code map for wrong answers (used in Part 2)
    const wrongFromApi = apiS.questions
      .filter(q => !q.correct && q?.q_id)
      .map((q) => ({
        q_id: q.q_id,
        q_id_candidates: q.q_id_candidates || [q.q_id],
        cat_id: q.cat_id || reviewCategoryId || parentCategoryFromQuestionCategory(q.cat_id) || null,
        review_category_id: reviewCategoryId || parentCategoryFromQuestionCategory(q.cat_id) || null,
        time_sec: Number(q.time_sec) || 0,
      }));
    const wrongFromCategories = catQs
      .filter((q) => !q.correct && q?.q_id)
      .map((q) => ({
        ...(apiByQId.get(String(q.q_id)) || {}),
        q_id: q.q_id,
        q_id_candidates: apiByQId.get(String(q.q_id))?.q_id_candidates || [q.q_id],
        cat_id:
          q.cat_id ||
          apiByQId.get(String(q.q_id))?.cat_id ||
          reviewCategoryId ||
          parentCategoryFromQuestionCategory(apiByQId.get(String(q.q_id))?.cat_id) ||
          cfg.reviewCategoryId ||
          null,
        review_category_id:
          reviewCategoryId ||
          parentCategoryFromQuestionCategory(apiByQId.get(String(q.q_id))?.cat_id) ||
          parentCategoryFromQuestionCategory(q.cat_id) ||
          null,
        q_code: q.q_code || null,
        question_url: toAbsoluteQuestionUrl(q.question_url) || null,
      }));
    const wrongRefs = dedupeWrongRefs(
      wrongFromCategories.length ? wrongFromCategories : [...wrongFromCategories, ...wrongFromApi]
    );

    const questions = [...catQs];
    const seenQIds = new Set(questions.filter((q) => q?.q_id).map((q) => String(q.q_id)));
    for (const apiQ of apiS.questions || []) {
      if (!apiQ?.q_id) continue;
      const apiQId = String(apiQ.q_id);
      if (seenQIds.has(apiQId)) continue;
      seenQIds.add(apiQId);
      const fallbackSubCode =
        String(
          pageSubCodeHints.get(Number(apiQ.cat_id)) ||
            pageSubCodeHints.get(parentCategoryFromQuestionCategory(apiQ.cat_id)) ||
            ''
        )
          .trim()
          .toUpperCase() ||
        String(apiQ.subject_sub_raw || '').trim().toUpperCase();
      const fallbackSubGroup =
        subSubjectGroup(fallbackSubCode || apiQ.subject_sub || normalizeSubSubject(apiQ)) || null;
      const fallbackDiTopic = fallbackSubGroup === 'DI' ? diSubtopicFromSubSubject(fallbackSubCode) : '';
      questions.push({
        q_code: null,
        correct: Boolean(apiQ.correct),
        difficulty: null,
        confidence: 'not selected',
        time_sec: Number(apiQ.time_sec) || 0,
        q_id: apiQId,
        cat_id: reviewCategoryId || parentCategoryFromQuestionCategory(apiQ.cat_id) || apiQ.cat_id || null,
        question_url: null,
        subject_sub: fallbackSubGroup,
        subject_sub_raw: fallbackSubCode || null,
        topic: apiQ.topic || fallbackDiTopic || null,
      });
    }

    if (!questions.length) {
      console.warn(`  ⚠️ ${sid} — skipped (no session rows found; tried categories: ${attempted.join(', ') || 'none'})`);
      continue;
    }

    const apiCorrectCount = apiS.questions.filter((q) => Boolean(q.correct)).length;
    const apiErrorCount = apiS.questions.filter((q) => !q.correct).length;
    const statsQuestions = catQs.length ? catQs : questions;
    const computedCorrect = statsQuestions.length
      ? statsQuestions.filter((q) => q.correct).length
      : apiCorrectCount;
    const computedErrors = statsQuestions.length
      ? statsQuestions.filter((q) => !q.correct).length
      : apiErrorCount;
    const computedTotal = computedCorrect + computedErrors;
    const computedAccuracyPct =
      computedTotal > 0 ? Number(((computedCorrect * 100) / computedTotal).toFixed(1)) : null;

    sessions.push({
      session_id:            parseInt(sid),
      date:                  apiS.date,
      source:                cfg.source,
      subject:               derivedSubject(apiS.questions, cfg.source),
      review_category_id:    reviewCategoryId || null,
      stats: {
        total_q_api:         apiS.questions.length,          // API total (may include 1 extra from other sub-category)
        total_q_categories:  catQs.length,                   // session-scoped categories rows (if available)
        correct:             computedCorrect,
        errors:              computedErrors,
        accuracy_pct:        computedAccuracyPct,
        avg_time_sec:        avgMatch  ? parseTimeSec(avgMatch[1])  : Math.round(apiS.questions.reduce((s,q)=>s+q.time_sec,0)/apiS.questions.length),
        avg_correct_time_sec:  cAvgMatch ? parseTimeSec(cAvgMatch[1]) : null,
        avg_incorrect_time_sec: wAvgMatch ? parseTimeSec(wAvgMatch[1]) : null,
      },
      questions,             // category rows + API fallback rows (session-scoped)
      wrong_q_ids:           wrongRefs,  // internal IDs for Part 2
    });

    console.log(`  ✓ ${sid} — ${questions.length}Q, ${questions.filter(q=>!q.correct).length} wrong (review refs: ${wrongRefs.length})`);
  }

  const result = {
    extracted_at: new Date().toISOString(),
    config: {
      since: cfg.since,
      source: cfg.source,
      clientId: runtimeClientId,
      sinceTimezone: THAI_TIME_ZONE,
      sessionDateTimezone: THAI_TIME_ZONE,
      gmatTimestampTimezone,
      gmatTimestampField: 'client_created_at',
    },
    sessions: sessions.sort((a, b) => a.date > b.date ? 1 : -1),
  };

  window._gmatPart1 = result;
  console.log(`\n✅ Part 1 done — ${sessions.length} sessions, data in window._gmatPart1`);
  console.log('   Copy with: copy(JSON.stringify(window._gmatPart1))');
  return result;
}


// ═══════════════════════════════════════════════════════════════════════════════
// PART 2 — Review page scraper (wrong answers only)
//   Input:  sessions array from Part 1 (needs wrong_q_ids)
//   Output: per-question {q_id, q_code, session_id, my_answer, correct_answer, topic}
// ═══════════════════════════════════════════════════════════════════════════════

async function scrapePart2(sessions, cfg = CONFIG) {
  installPageErrorTracker();
  // Collect all wrong questions across all sessions
  const toScrape = [];
  for (const s of sessions) {
    for (const wq of (s.wrong_q_ids || [])) {
      if (!wq?.q_id) continue;
      toScrape.push({
        session_id: s.session_id,
        session_subject: s.subject || '',
        source: s.source || cfg.source || '',
        q_id: wq.q_id,
        q_id_candidates: wq.q_id_candidates || [wq.q_id],
        cat_id: wq.cat_id,
        review_category_id: wq.review_category_id || s.review_category_id || null,
        q_code: wq.q_code || null,
        question_url: wq.question_url || null,
        api_user_answer: wq.user_answer || null,
      });
    }
  }

  const subCodeHintsBySession = new Map();
  const sessionIdsForHints = Array.from(new Set(toScrape.map((item) => Number(item.session_id)).filter((id) => Number.isInteger(id))));
  for (const sid of sessionIdsForHints) {
    await navigateHashSafe(`custom-quiz/${sid}`, cfg.pageWaitMs);
    subCodeHintsBySession.set(String(sid), extractCategorySubCodesFromCurrentPage(sid));
  }

  console.log(`📖 Scraping ${toScrape.length} wrong-answer review pages…`);

  const wrongAnswers = [];
  let skippedNotReady = 0;
  let skippedNotWrong = 0;
  let skippedMismatchedCode = 0;

  for (let i = 0; i < toScrape.length; i++) {
    const {
      session_id,
      session_subject,
      source,
      q_id,
      q_id_candidates,
      cat_id,
      review_category_id,
      q_code: expectedQCode,
      question_url: savedQuestionUrl,
      api_user_answer: apiUserAnswer,
    } = toScrape[i];
    const diContext = isDiReviewContext(source, session_subject, cat_id, review_category_id);
    const qIdCandidates = Array.from(
      new Set([q_id, ...(Array.isArray(q_id_candidates) ? q_id_candidates : [])].filter(Boolean).map((id) => String(id)))
    );
    const savedRoute = parseReviewRoute(savedQuestionUrl);
    const reviewCatCandidates = dedupeNumeric([
      savedRoute?.cat_id,
      cat_id,
      parentCategoryFromQuestionCategory(cat_id),
      review_category_id,
      parentCategoryFromQuestionCategory(review_category_id),
      parentCategoryFromQuestionCategory(savedRoute?.cat_id),
      cfg.reviewCategoryId,
    ]);

    if (!reviewCatCandidates.length) {
      skippedNotReady += 1;
      console.warn(`  ⚠️  Skipped ${session_id}/${q_id}: no valid review category id`);
      continue;
    }

    let ready = false;
    let usedReviewCatId = null;
    let usedQId = null;
    for (const reviewCatId of reviewCatCandidates) {
      for (const candidateQId of qIdCandidates) {
        const reviewHash = `custom-quiz/${session_id}/review/categories/${reviewCatId}/${candidateQId}`;
        let navResult = await navigateHashSafe(reviewHash, cfg.pageWaitMs);
        let readyState = await waitForReviewReady(
          session_id,
          reviewCatId,
          candidateQId,
          cfg,
          expectedQCode
        );

        if (!readyState?.ready && navResult.hadPageError) {
          console.warn(
            `  ↻ Retry ${session_id}/${candidateQId}: reopening same review URL after page error (${navResult.newPageErrors})`
          );
          navResult = await navigateHashSafe(reviewHash, cfg.pageWaitMs);
          readyState = await waitForReviewReady(
            session_id,
            reviewCatId,
            candidateQId,
            cfg,
            expectedQCode
          );
        }

        ready = Boolean(readyState?.ready);
        if (ready) {
          usedReviewCatId = readyState?.routeCatId || reviewCatId;
          usedQId = readyState?.routeQId || candidateQId;
          break;
        }
        if (navResult.hadPageError) {
          console.warn(
            `  ⚠️  ${session_id}/${candidateQId} cat ${reviewCatId} triggered page error (${navResult.newPageErrors}), trying next candidate.`
          );
        }
      }
      if (ready) break;
    }

    if (!ready || !usedReviewCatId || !usedQId) {
      skippedNotReady += 1;
      console.warn(`  ⚠️  Skipped ${session_id}/${q_id}: review page did not load in time`);
      continue;
    }

    // Question code (6-digit OG number)
    const q_code = document.body.innerText.match(/\b(\d{6})\b/)?.[1] ?? null;
    if (expectedQCode && q_code && String(q_code) !== String(expectedQCode)) {
      skippedMismatchedCode += 1;
      console.warn(
        `  ↷ Skipped ${session_id}/${q_id}: expected q_code ${expectedQCode}, got ${q_code}`
      );
      continue;
    }

    // Answer choices
    const pageText = document.body.innerText || '';
    const domAnswers = extractAnswersFromChoiceDom();
    const textAnswers = extractAnswerLettersFromText(pageText);
    const apiAnswer = normalizeAnswerLetter(apiUserAnswer);

    let my_answer = domAnswers.my_answer || textAnswers.my_answer || null;
    let correct_answer = domAnswers.correct_answer || textAnswers.correct_answer || null;

    if (!my_answer && domAnswers.selected_answer && correct_answer && domAnswers.selected_answer !== correct_answer) {
      my_answer = domAnswers.selected_answer;
    }
    if (!my_answer && apiAnswer && correct_answer && apiAnswer !== correct_answer) {
      my_answer = apiAnswer;
    }
    if (!my_answer && !correct_answer && apiAnswer) {
      my_answer = apiAnswer;
    }

    if (diContext && my_answer && correct_answer && my_answer === correct_answer) {
      // DI pages can contain multiple sub-answers where a single-letter parse is ambiguous.
      my_answer = null;
      correct_answer = null;
    }

    if (!my_answer && !correct_answer && !diContext) {
      skippedNotWrong += 1;
      console.warn(`  ↷ Skipped ${session_id}/${q_id}: unable to detect answers on review page`);
      continue;
    }
    if (my_answer && correct_answer && my_answer === correct_answer && !diContext) {
      skippedNotWrong += 1;
      console.warn(`  ↷ Skipped ${session_id}/${q_id}: parsed as non-incorrect (my=${my_answer}, correct=${correct_answer})`);
      continue;
    }

    // Topic from question text
    const sessionHints = subCodeHintsBySession.get(String(session_id));
    const hintedSubCode =
      sessionHints?.get(Number(usedReviewCatId || reviewCatId || cat_id)) ||
      sessionHints?.get(Number(cat_id)) ||
      null;
    const pageSubCode = hintedSubCode || detectSubSubjectCodeFromCurrentPage();
    const diTopicFromPage = diSubtopicFromSubSubject(pageSubCode);
    const inferredTopic = shouldInferTopic(source, session_subject) ? detectTopic(document.body.innerText) : '';
    const topic = inferredTopic || diTopicFromPage || '';

    wrongAnswers.push({
      session_id,
      q_id: usedQId,
      cat_id: usedReviewCatId,
      q_code,
      my_answer,
      correct_answer,
      topic,
      question_url:
        toAbsoluteQuestionUrl(savedQuestionUrl) ||
        toAbsoluteQuestionUrl(`#custom-quiz/${session_id}/review/categories/${usedReviewCatId}/${usedQId}`),
    });

    if ((i + 1) % 10 === 0) console.log(`  … ${i + 1}/${toScrape.length}`);
  }

  const result = {
    extracted_at:  new Date().toISOString(),
    total:         wrongAnswers.length,
    wrong_answers: wrongAnswers,
  };

  window._gmatPart2 = result;
  console.log(`\n✅ Part 2 done — ${wrongAnswers.length} wrong answers, data in window._gmatPart2`);
  if (skippedNotReady || skippedNotWrong || skippedMismatchedCode) {
    console.log(
      `   Skipped: ${skippedNotReady} not-ready pages, ${skippedNotWrong} non-incorrect pages, ${skippedMismatchedCode} code-mismatch pages`
    );
  }
  console.log('   Copy with: copy(JSON.stringify(window._gmatPart2))');
  return result;
}


// ═══════════════════════════════════════════════════════════════════════════════
// COMBINED RUNNER  (convenience wrapper)
// ═══════════════════════════════════════════════════════════════════════════════

async function runScraper(cfg = CONFIG) {
  if (window.__gmatScraperRunning) {
    throw new Error('Scraper is already running in this tab. Wait for completion or reload the GMAT tab and retry.');
  }
  window.__gmatScraperRunning = true;
  try {
    const part1 = await scrapePart1(cfg);
    const part2 = await scrapePart2(part1.sessions, cfg);

    // Merge: annotate wrong questions from review-page details.
    const detailByQCode = {};
    const detailByQId = {};
    for (const w of part2.wrong_answers) {
      detailByQId[`${w.session_id}_${w.q_id}`] = w;
      if (!w.q_code) continue;
      const key = `${w.session_id}_${w.q_code}`;
      if (!detailByQCode[key]) detailByQCode[key] = [];
      detailByQCode[key].push(w);
    }

    for (const s of part1.sessions) {
      const byCodeCounter = {};
      for (const q of s.questions) {
        if (q.correct) continue;

        let detail = null;

        // Primary match by question code, which exists in categories rows + review page.
        if (q.q_code) {
          const codeKey = `${s.session_id}_${q.q_code}`;
          const idx = byCodeCounter[codeKey] || 0;
          detail = detailByQCode[codeKey]?.[idx] || null;
          if (detailByQCode[codeKey]?.length) byCodeCounter[codeKey] = idx + 1;
        }

        // Fallback: use first unmatched detail by q_id for this session.
        if (!detail) {
          const fallback = (s.wrong_q_ids || []).find(x => detailByQId[`${s.session_id}_${x.q_id}`]);
          if (fallback) {
            detail = detailByQId[`${s.session_id}_${fallback.q_id}`];
            delete detailByQId[`${s.session_id}_${fallback.q_id}`];
          }
        }

        if (detail) {
          q.my_answer      = detail.my_answer;
          q.correct_answer = detail.correct_answer;
          q.topic          = detail.topic || q.topic || null;
          q.q_id           = detail.q_id || null;
          q.cat_id         = detail.cat_id || null;
          q.question_url   = detail.question_url || null;
        }
      }

      const existingQIds = new Set(
        (s.questions || [])
          .map((q) => q?.q_id)
          .filter(Boolean)
          .map((id) => String(id))
      );
      const unmatchedWrongDetails = (part2.wrong_answers || []).filter(
        (w) => w.session_id === s.session_id && (!w.q_id || !existingQIds.has(String(w.q_id)))
      );
      for (const detail of unmatchedWrongDetails) {
        s.questions.push({
          q_code: detail.q_code || null,
          correct: false,
          difficulty: null,
          confidence: 'not selected',
          time_sec: null,
          my_answer: detail.my_answer,
          correct_answer: detail.correct_answer,
          topic: detail.topic || '',
          q_id: detail.q_id || null,
          cat_id: detail.cat_id || null,
          question_url: detail.question_url || null,
        });
        if (detail.q_id) existingQIds.add(String(detail.q_id));
      }
    }

    window._gmatData = part1;
    console.log('\n🎉 Full scrape complete. All data in window._gmatData');
    console.log('   Copy with: copy(JSON.stringify(window._gmatData))');
    return part1;
  } finally {
    window.__gmatScraperRunning = false;
  }
}


// ── Usage hint ────────────────────────────────────────────────────────────────
console.log(`
GMAT Scraper loaded ✅
────────────────────────────────────────────────────────
Full run (Part 1 + Part 2):
  const data = await runScraper()

Part 1 only (fast — session stats + difficulty):
  const data = await scrapePart1()

Part 2 only (pass Part 1 sessions):
  const details = await scrapePart2(window._gmatPart1.sessions)

Override config for a different practice set:
  await runScraper({
    ...CONFIG,
    since: '20260315000000',
    reviewCategoryId: <YOUR_CATEGORY_ID>,
  })

After running, copy data to clipboard:
  copy(JSON.stringify(window._gmatData))
────────────────────────────────────────────────────────
`);
