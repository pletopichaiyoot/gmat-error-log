import { Fragment, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { Select } from './components/ui/select';
import TodayPlan from './TodayPlan';
import PassageLines from './PassageLines';
// Heavy route-level views — lazy-loaded so they don't bloat the initial bundle.
// The dashboard (default route) loads without them; they fetch on demand when
// the user navigates to #lsat or #study-plan.
const LsatPractice = lazy(() => import('./LsatPractice'));
const StudyPlan = lazy(() => import('./StudyPlan'));

function RouteFallback() {
  return (
    <main className="page-shell">
      <div style={{ padding: '24px', color: '#6b7280' }}>Loading…</div>
    </main>
  );
}

const DEFAULT_CDP_URL = 'http://localhost:9222';

// Lean 12-tag taxonomy (v3, 2026-05-26). Designed for fast tagging during
// review: 3 orthogonal dimensions, multi-select-friendly. Each tag points to
// a distinct remediation.
//
// Why v3: v2 had 22 tags but 14 of them fired <=2 times in 30 days, and
// tagging compliance was only ~11%. Most micro RC-trap tags and the
// DI-specific tags never got picked because the question's `subcategory`
// column already captures sub-type; tags should add cognitive/trap/process
// signal on top.
//
// Migration (v2 -> v3) — handled by scripts/migrate-tags-v3.js:
//   Misread (Passage/Question/Condition)               -> Misread
//   CR: Missed Negation/Qualifier                       -> Misread
//   Chart/Table Misread                                 -> Misread
//   Multi-Source: Missed Cross-Link                     -> Misread
//   Wrong Setup (Variable/Equation/Structure)           -> Wrong Setup
//   Composite/Multi-Select: Wrong Slot                  -> Wrong Setup
//   Two-Part: Pairing/Order Error                       -> Wrong Setup
//   Invalid Assumption                                  -> Logic Slip
//   Logic Breakdown (Wrong Inference or Relationship)   -> Logic Slip
//   RC Trap: Wrong Paragraph                            -> Logic Slip
//   CR: Confused Author Tone                            -> Logic Slip
//   CR: Scope Shift (Premise vs Conclusion)             -> Trap: Scope/Strength
//   RC Trap: Too Extreme                                -> Trap: Scope/Strength
//   RC Trap: Out of Scope                               -> Trap: Scope/Strength
//   RC Trap: Half-Right                                 -> Trap: Half-Right
//   RC Trap: Opposite Direction                         -> Trap: Reversed
//   Incomplete Casework                                 -> Calc/Casework Slip
//   Calculation Slip (...)                              -> Calc/Casework Slip
//   Chose Too Early                                     -> Time Trap
//   Overinvested Time (>2x median)                      -> Time Trap
//   Re-read Loop (Got Stuck Re-reading)                 -> No Plan / Stuck
//   Could Not Start / No Plan                           -> No Plan / Stuck
//   Pre-phrase Mismatch (Skipped Pre-phrasing)          -> dropped (not a workflow Pleto uses)
// Restored: "Concept Gap" (was retired in v2 but real entries still ask for it).
// "Trap: Plausible-but-Unstated" is new in v3 — the world-knowledge-leak trap.
//
// Old/legacy rows that didn't get migrated still render in the chips list
// (free-text); they just won't appear pre-selected in the picker.
const MISTAKE_TYPES = {
  // "Why I Missed It" = the on-the-merits cause (drives the fix). NOTE: 'Wrong Setup'
  // and 'Calc/Casework Slip' are Quant/DI execution tags — hidden on Verbal questions
  // via TAG_SUBJECTS below.
  'Why I Missed It': [
    'Misread',
    'Modifier/Connective Miss',
    'Concept Gap',
    'Wrong Setup',
    'Logic Slip',
    'Calc/Casework Slip',
  ],
  // Trap Type = what the wrong answer was doing (a descriptor, not a fix). Verbal/
  // verbal-DI only via TAG_SUBJECTS.
  'Trap Type': [
    'Trap: Scope/Strength',
    'Trap: Half-Right',
    'Trap: Reversed',
    'Trap: Plausible-but-Unstated',
    'Trap: True-but-Irrelevant',
    'Trap: Distortion/Familiar-Language',
    'Trap: Premise Repeat',
  ],
  // Timing & Process — the clock decision or workflow failure. 'Time Trap' was split
  // into three actionable modes (its biggest weakness: it lumped opposite fixes).
  // Legacy 'Time Trap' rows still render as free-text pills (TAG_DESCRIPTIONS keeps
  // its tooltip) but it's no longer offered as a fresh pick.
  'Timing & Process': [
    'No Plan / Stuck',
    'Chose Too Early / Rushed-Guess',
    'Overinvested (>2× median)',
    'Ran Out of Time',
  ],
};

// When-to-use hints shown on hover (native title attribute).
const TAG_DESCRIPTIONS = {
  // Why I Missed It
  'Misread':
    'Missed or misinterpreted a content word, condition, chart value, or part of the stem ("each", "ensure", "at least", a number). Fix: slow down on key words and restate the question in your own words before solving.',
  'Modifier/Connective Miss':
    'Missed a small qualifier or connective word that carries the logical relationship — "instead", "directly/indirectly", "whereas", "only", "but", "however", "rather than", negations, scope-limiters. Fix: treat these as logical operators, not filler — circle them on first read of a passage or answer choice.',
  'Concept Gap':
    "Didn't actually know the rule, formula, or concept being tested. Different from Wrong Setup — this is a knowledge hole, not an execution miss. Fix: revisit the concept and add to flashcards.",
  'Wrong Setup':
    'Knew the concept, but framed the problem incorrectly — wrong variable, wrong equation, missing matrix/table, bad translation from words to math. Fix: practice the canonical setup for that problem type before computing.',
  'Logic Slip':
    'Reasoning chain broke: wrong inference, missed implication, premise/conclusion confusion, paragraph-role miss, scope error in your own logic. Fix: write the chain step-by-step instead of jumping.',
  'Calc/Casework Slip':
    'Computation, sign, unit, or casework error — including only testing favorable cases or making a careless arithmetic mistake. Fix: enumerate cases systematically; double-check signs and units.',
  // Trap Type — what the wrong answer was doing
  'Trap: Scope/Strength':
    'The wrong answer added an unstated qualifier or pushed strength too far — "constant", "always", "only", "primarily". Common on RC Inference and CR Scope shifts. Fix: reject any choice that adds an unstated quality the passage never claims.',
  'Trap: Half-Right':
    'The wrong answer was partially correct but one element was off — right idea, wrong scope/agent/object/timeframe. Fix: verify every clause of the answer choice, not just the first half.',
  'Trap: Reversed':
    'Wrong direction, polarity, or causation — answer flipped cause/effect, increased vs. decreased, supports vs. weakens. Fix: explicitly note the direction of the relationship before reading choices.',
  'Trap: Plausible-but-Unstated':
    "The wrong answer sounded right from real-world intuition or general knowledge but wasn't supported by the passage/stem. Fix: ask 'where does the text say this?' for every candidate answer.",
  'Trap: True-but-Irrelevant':
    'The choice is accurate per the passage but doesn\'t answer the question asked — a real detail offered for an inference or main-idea question. Distinct from Half-Right (on-task but partly wrong) and Plausible-but-Unstated (unsupported): this one IS supported, just off-task. Fix: after confirming a choice is true, ask "does it answer THIS stem?"',
  'Trap: Distortion/Familiar-Language':
    'Reuses the passage\'s exact words but recombines or subtly twists their meaning so it rings a bell. Fix: don\'t reward familiar wording — re-check that the relationship the choice asserts is the one the text actually states.',
  'Trap: Premise Repeat':
    'A CR choice that restates a premise you were already given instead of supplying the assumption, new support, or inference the question needs — true, straight from the argument, but does no work. Fix: ask "does this ADD something, or just echo a given?"',
  // Timing & Process
  'No Plan / Stuck':
    "Couldn't start, no setup move (no matrix, no passage map, no equation), or got stuck mid-problem. Also: messy scratchwork that confused you. Fix: build the standard setup for that problem type before solving.",
  'Chose Too Early / Rushed-Guess':
    'Committed before fully working the question — fast + wrong. Took the first plausible choice, or guessed to keep moving. Fix: force one verification pass before locking; don\'t answer on first instinct.',
  'Overinvested (>2× median)':
    'Spent far longer than the question was worth (>2× your median for the type), regardless of outcome — the clock leak that starves later questions. Fix: set a per-question cap; at the limit, make your best choice, mark it, and move.',
  'Ran Out of Time':
    'End-of-section clock pressure — a ≤10s blind guess or a question skipped because time ran out. A pacing failure, not a skill gap. Fix: pacing checkpoints (question N by time T) so you never arrive at the end starved.',
  // Legacy (split into the three modes above; kept so old rows keep a tooltip).
  'Time Trap':
    'Any timing failure mode: chose too early, overinvested time (>2× median), rushed-guess, or ran out of time. Fix: enforce a per-question budget; bail and mark for review at the budget limit.',
};

const ALL_MISTAKE_TAGS = Object.values(MISTAKE_TYPES).flat();

const MISTAKE_CATEGORY_ORDER = Object.keys(MISTAKE_TYPES);

const SUBJECT_TAG_PRIORITY = {
  Q: ['Why I Missed It', 'Timing & Process', 'Trap Type'],
  V: ['Trap Type', 'Why I Missed It', 'Timing & Process'],
  DI: ['Why I Missed It', 'Trap Type', 'Timing & Process'],
};

// Subject-scoping for the annotation picker: a tag listed here renders ONLY for the
// given subjects (Verbal questions don't show Quant execution tags; Quant questions
// don't show Verbal trap types). Tags not listed are universal. An active tag search
// overrides this, so a hidden tag is still reachable by typing its name.
const TAG_SUBJECTS = {
  'Wrong Setup': ['Q', 'DI'],
  'Calc/Casework Slip': ['Q', 'DI'],
  'Trap: Scope/Strength': ['V', 'DI'],
  'Trap: Half-Right': ['V', 'DI'],
  'Trap: Reversed': ['V', 'DI'],
  'Trap: Plausible-but-Unstated': ['V', 'DI'],
  'Trap: True-but-Irrelevant': ['V', 'DI'],
  'Trap: Distortion/Familiar-Language': ['V', 'DI'],
  'Trap: Premise Repeat': ['V', 'DI'],
};

function tagAllowedForSubject(tag, subjCode) {
  if (!['Q', 'V', 'DI'].includes(subjCode)) return true;
  const allowed = TAG_SUBJECTS[tag];
  return !allowed || allowed.includes(subjCode);
}

function parseMistakeTags(value) {
  if (!value) return [];
  if (typeof value === 'string' && value.startsWith('[')) {
    try {
      return JSON.parse(value);
    } catch {
      // fall through
    }
  }
  return [value];
}

function formatDate(value) {
  if (!value) return '-';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleDateString();
}

function formatIsoDate(value) {
  if (!value) return '-';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatMaybe(value) {
  return value === null || value === undefined || value === '' ? '-' : value;
}

function formatDurationSeconds(value) {
  if (value === null || value === undefined || value === '') return '-';

  const totalSeconds = Number(value);
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '-';

  const roundedSeconds = Math.floor(totalSeconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatPercent(value) {
  if (value === null || value === undefined || value === '') return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return `${num}%`;
}

function formatDifficultyStat(total, accuracy, avgTimeSec) {
  const count = Number(total);
  if (!Number.isFinite(count) || count <= 0) return '0 (- / -)';
  return `${count} (${formatPercent(accuracy)} / ${formatDurationSeconds(avgTimeSec)})`;
}

function getSessionPlannedTotal(session) {
  const categories = Number(session?.total_q_categories);
  const api = Number(session?.total_q_api);
  const candidates = [categories, api].filter((value) => Number.isFinite(value) && value > 0);
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

function getSessionQuestionCount(session) {
  const answered = getSessionAnsweredCount(session);
  if (Number.isFinite(answered) && answered >= 0) return answered;
  return getSessionPlannedTotal(session);
}

function getSessionAnsweredCount(session) {
  const attempts = Number(session?.attempt_total);
  if (Number.isFinite(attempts) && attempts > 0) return attempts;

  const correct = Number(session?.correct_count);
  const wrong = Number(session?.error_count);
  const safeCorrect = Number.isFinite(correct) && correct >= 0 ? correct : 0;
  const safeWrong = Number.isFinite(wrong) && wrong >= 0 ? wrong : 0;
  const total = safeCorrect + safeWrong;
  if (total > 0) return total;

  return null;
}

function getSessionCorrectCount(session) {
  const attemptsCorrect = Number(session?.attempt_correct);
  if (Number.isFinite(attemptsCorrect) && attemptsCorrect >= 0) return attemptsCorrect;

  const correct = Number(session?.correct_count);
  if (Number.isFinite(correct) && correct >= 0) return correct;

  return null;
}

function getSessionErrorCount(session) {
  const attemptsWrong = Number(session?.attempt_wrong);
  if (Number.isFinite(attemptsWrong) && attemptsWrong >= 0) return attemptsWrong;

  const errors = Number(session?.error_count);
  if (Number.isFinite(errors) && errors >= 0) return errors;

  return null;
}

function getSessionUnansweredCount(session) {
  const total = getSessionPlannedTotal(session);
  if (!Number.isFinite(total) || total < 0) return null;

  const answered = getSessionAnsweredCount(session);
  if (!Number.isFinite(answered) || answered < 0) return total;

  return Math.max(0, total - answered);
}

function getSessionAnsweredAccuracy(session) {
  const answered = getSessionAnsweredCount(session);
  const correct = getSessionCorrectCount(session);
  if (Number.isFinite(answered) && answered > 0 && Number.isFinite(correct) && correct >= 0) {
    return Number(((correct * 100) / answered).toFixed(1));
  }

  const fallback = Number(session?.accuracy_pct);
  if (Number.isFinite(fallback)) return fallback;
  return null;
}

function getSessionCompletionRate(session) {
  const total = getSessionPlannedTotal(session);
  const answered = getSessionAnsweredCount(session);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(answered) || answered < 0) return null;
  const boundedAnswered = Math.min(answered, total);
  return Number(((boundedAnswered * 100) / total).toFixed(1));
}

function formatNotePreview(value, maxLength = 42) {
  if (!value) return '-';
  const text = String(value).trim();
  if (!text) return '-';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function normalizeQuestionText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

// OPE renders inline math (fractions, radicals, symbols) as inline raster images
// with no alt text; the scraper preserves them as self-contained data: <img> in
// question_stem_html so we can show the real equations. The scraper already
// emits a tight subset, but stored HTML is never rendered blindly: this strips
// everything except sup/sub/i/b/br/p and <img> with a data: src (dropping all
// attributes, so no event handlers survive) before dangerouslySetInnerHTML.
const STEM_ALLOWED_TAGS = new Set(['SUP', 'SUB', 'I', 'EM', 'B', 'STRONG', 'BR', 'P']);
function sanitizeStemHtmlNode(node) {
  Array.from(node.childNodes).forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) return;
    if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); return; }
    if (child.tagName === 'IMG') {
      const src = child.getAttribute('src') || '';
      if (!/^data:image\//i.test(src)) { child.remove(); return; }
      Array.from(child.attributes).forEach((a) => { if (a.name.toLowerCase() !== 'src') child.removeAttribute(a.name); });
      return;
    }
    if (!STEM_ALLOWED_TAGS.has(child.tagName)) {
      sanitizeStemHtmlNode(child);                       // clean subtree first
      child.replaceWith(...Array.from(child.childNodes)); // then unwrap
      return;
    }
    Array.from(child.attributes).forEach((a) => child.removeAttribute(a.name));
    sanitizeStemHtmlNode(child);
  });
}
function sanitizeStemHtml(html) {
  const raw = String(html || '');
  if (!raw.trim() || typeof document === 'undefined') return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = raw;
  sanitizeStemHtmlNode(tpl.content);
  return tpl.innerHTML.trim();
}

// Renders a question stem: the math-image-bearing HTML (OPE) when present,
// otherwise the plain-text stem. All non-OPE sources have no question_stem_html,
// so they fall through to the original plain-text <p> render unchanged.
function StemContent({ row }) {
  const html = sanitizeStemHtml(row?.question_stem_html);
  if (html) {
    return <div className="question-stem-html" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <p>{normalizeQuestionText(row?.question_stem) || 'No locally scraped stem yet.'}</p>;
}

// Split a passage into display paragraphs. Splits on blank lines (the paragraph
// break both LSAT JSON and StartTest enrichment use), drops a leading "Passage:"
// label, and collapses intra-paragraph whitespace so each <p> wraps cleanly.
// normalizeQuestionText can't be used directly here because it flattens every
// newline into a space, which would erase the paragraph boundaries.
function splitPassageParagraphs(value) {
  return String(value || '')
    .replace(/^\s*passage\s*:\s*/i, '')
    .split(/\n{2,}/)
    .map((para) => para.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// True when a review row has passage content to render — either the structured
// LSAT lines[] or a flat passage_text. Drives the two-column review layout (passage
// on the left, stem + choices on the right); falls back to a single column when there's
// no passage (CR / LR / most Quant & DI).
function rowHasPassage(row) {
  if (Array.isArray(row?.passage_lines) && row.passage_lines.length > 0) return true;
  return splitPassageParagraphs(row?.passage_text).length > 0;
}

function parseAnswerChoices(value) {
  if (Array.isArray(value)) return value;
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseResponseDetails(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getResponseSlots(row) {
  const details = parseResponseDetails(row?.response_details);
  return Array.isArray(details?.slots) ? details.slots : [];
}

// Decode a matrix item's selections into display-ready structures.
//
// Per-cell `isCorrect` is unreliable for matrix questions: StartTest's review
// DOM rarely color-codes matrix cells, so the Phase 2 scraper leaves isCorrect
// unset (color=null) on nearly every cell. The authoritative correct answer is
// `correctCsv` (the row's correct_answer, sourced from the Key1 form field).
// We decode it orientation-aware, because TPA and MSR tables transpose it:
//   - per-column (len === colCount): value i = correct ROW number for column i   (Two-Part Analysis)
//   - per-row    (len === rowCount): value i = correct COLUMN number for row i    (some MSR tables)
// User picks come from the reliable per-cell isUserSelected flags (radiochecked.gif).
// Returns 1-indexed structures so callers can render row/column numbers directly.
function decodeMatrixSelections(choices, correctCsv) {
  const rowCount = Array.isArray(choices) ? choices.length : 0;
  const colCount = choices?.[0]?.options?.length ?? 0;
  const headers = Array.isArray(choices?.[0]?.headers) ? choices[0].headers : [];
  const correctCells = new Set();              // "row,col" keys, 1-indexed
  const correctByCol = new Array(colCount).fill(null);
  const userByCol = new Array(colCount).fill(null);
  const ck = String(correctCsv || '').split(/\s*,\s*/);
  if (ck.length === colCount && colCount > 0) {
    ck.forEach((rowNum, ci) => {
      const r = Number(rowNum);
      if (rowNum && Number.isFinite(r) && r >= 1) {
        correctCells.add(`${r},${ci + 1}`);
        correctByCol[ci] = r;
      }
    });
  } else if (ck.length === rowCount && rowCount > 0) {
    ck.forEach((colNum, ri) => {
      const c = Number(colNum);
      if (colNum && Number.isFinite(c) && c >= 1 && c <= colCount) {
        correctCells.add(`${ri + 1},${c}`);
        correctByCol[c - 1] = ri + 1;
      }
    });
  }
  (choices || []).forEach((row, ri) => (row?.options || []).forEach((o, ci) => {
    if (o?.isUserSelected && ci < colCount) userByCol[ci] = ri + 1;
  }));
  return { rowCount, colCount, headers, correctCells, correctByCol, userByCol };
}

function formatResponseFormat(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'single_select') return 'Single Select';
  if (text === 'composite') return 'Composite';
  return value;
}

function formatSlotType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'choice-grid') return 'Choice Grid';
  if (text === 'table-cell') return 'Table Cell';
  if (text === 'single_select') return 'Single Select';
  return text
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function findResponseOption(slot, value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const options = Array.isArray(slot?.options) ? slot.options : [];
  return options.find((option) => String(option?.id || '').trim() === normalized) || null;
}

function formatResponseValue(slot, value) {
  const matched = findResponseOption(slot, value);
  return normalizeQuestionText(matched?.text || matched?.label || value || '');
}

function summarizeStructuredResponse(row, key = 'user_value') {
  const slots = getResponseSlots(row);
  if (!slots.length) return '';
  const parts = slots
    .map((slot, index) => {
      const valueText = formatResponseValue(slot, slot?.[key]);
      if (!valueText) return '';
      const prompt = normalizeQuestionText(slot?.prompt || '') || `Part ${index + 1}`;
      return `${prompt}: ${valueText}`;
    })
    .filter(Boolean);
  const summary = parts.join(' | ');
  if (summary.length <= 140) return summary;
  return `${summary.slice(0, 139)}…`;
}

function hasScrapedQuestionContent(row) {
  return (
    Boolean(normalizeQuestionText(row?.question_stem)) ||
    parseAnswerChoices(row?.answer_choices).length > 0 ||
    getResponseSlots(row).length > 0
  );
}

function formatQuestionActionLabel(row) {
  return hasScrapedQuestionContent(row) ? 'Review' : 'Open';
}

function formatTopicSource(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === 'llm') return 'LLM';
  if (text === 'heuristic') return 'Heuristic';
  return text;
}

function formatContentDomain(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'non_math') return 'Non-math';
  if (text === 'math') return 'Math';
  return value;
}

function normalizedSubjectCode(row) {
  const inferredCategory = normalizedCategoryCode(row);
  const inferredCategoryUpper = String(inferredCategory || '').trim().toUpperCase();
  if (inferredCategoryUpper === 'PS') return 'Q';
  if (['CR', 'RC'].includes(inferredCategoryUpper)) return 'V';
  if (['DS', 'MSR', 'TPA', 'GI', 'TA', 'DI', 'UNKNOWN DI'].includes(inferredCategoryUpper)) return 'DI';

  const raw = String(row?.subject_code || '').trim().toUpperCase();
  if (raw) return raw;
  const fallback = mapSubjectFamily(row?.subject || row?.subject_sub || row?.subject_sub_raw || '');
  if (fallback === 'Quant') return 'Q';
  if (fallback === 'Verbal') return 'V';
  if (fallback === 'DI') return 'DI';
  return fallback || '-';
}

function normalizedCategoryCode(row) {
  const raw = String(row?.category_code || row?.subject_sub_raw || row?.subject_sub || '').trim();
  const upper = raw.toUpperCase();
  if (['QUANT', 'Q', 'PS'].includes(upper)) return 'PS';
  if (['CR', 'RC', 'DS', 'MSR', 'TPA', 'GI', 'TA'].includes(upper)) return upper;

  const catId = Number(row?.cat_id);
  if (Number.isInteger(catId)) {
    if ([1337013, 1336833, 1336853].includes(catId)) return 'RC';
    if ([1337023, 1336843, 1336863].includes(catId)) return 'CR';
    if ([1336733, 1336743].includes(catId)) return 'DS';
    if (catId === 1336753) return 'MSR';
    if (catId === 1336763) return 'TA';
    if (catId === 1336773) return 'GI';
    if (catId === 1336783) return 'TPA';
    if ([1336803, 1336813].includes(catId)) return 'PS';
  }

  const topic = String(row?.subcategory || row?.topic || '').trim().toUpperCase();
  if (topic === 'DATA SUFFICIENCY') return 'DS';
  if (topic === 'MULTI-SOURCE REASONING' || topic === 'MSR MATH RELATED' || topic === 'MSR NON-MATH RELATED') return 'MSR';
  if (topic === 'TABLE ANALYSIS' || topic === 'G&T TABLES') return 'TA';
  if (topic === 'GRAPHICS INTERPRETATION' || topic === 'G&T GRAPHS' || topic === 'G&T MATH RELATED' || topic === 'G&T NON-MATH RELATED') return 'GI';
  if (topic === 'TWO-PART ANALYSIS' || topic === 'TPA MATH RELATED' || topic === 'TPA NON-MATH RELATED') return 'TPA';

  // Data Insights rows with no specific DS/MSR/TA/GI/TPA question-type. The
  // "OG Data Insights" product tags questions by theme (e.g. "Tradeoffs",
  // "Practical Constraints") rather than by question-type, so the scraper
  // leaves category_code empty. Show the broad "Data Insights" category here
  // instead of echoing the topic — echoing it would duplicate the subcategory
  // column. The specific theme stays in the subcategory column.
  if (upper === 'DI' || upper === 'DATA') return 'Data Insights';
  if (!raw) return '-';
  return raw;
}

function normalizeVerbalSubcategoryDisplay(value, categoryCode) {
  const text = String(value || '').trim();
  const normalized = text.toLowerCase();
  const category = String(categoryCode || '').trim().toUpperCase();

  if (!text) return '';

  if (category === 'CR') {
    if (/^(support|strengthen)$/i.test(text) || /strengthen|support/.test(normalized)) return 'Support';
    if (/^(attack|weaken|flaw)$/i.test(text) || /weaken|flaw/.test(normalized)) return 'Attack';
    if (/^(assumption|evaluate)$/i.test(text) || /assumption|evaluate|relevant to know/.test(normalized)) return 'Assumption';
    if (/^(inference|complete)$/i.test(text) || /inference|must be true|best supported|complete/.test(normalized)) return 'Inference';
    if (/^(resolve|explain)$/i.test(text) || /resolve|explain|paradox|discrepancy/.test(normalized)) return 'Resolve';
    if (
      /^(argument structure|boldface|method|parallel)$/i.test(text) ||
      /boldface|method|technique|strategy|parallel|argument structure/.test(normalized)
    ) {
      return 'Argument Structure';
    }
  }

  if (category === 'RC') {
    if (
      /^(main idea \/ purpose|main idea|purpose)$/i.test(text) ||
      /main idea|main point|primary purpose|central idea|purpose/.test(normalized)
    ) {
      return 'Main Idea / Purpose';
    }
    if (/^detail$/i.test(text) || /detail|according to the passage/.test(normalized)) return 'Detail';
    if (/^inference$/i.test(text) || /inference|must be true|best supported/.test(normalized)) return 'Inference';
    if (
      /^(structure \/ function|organization)$/i.test(text) ||
      /organization|structure of the passage|serves to|function of|structure \/ function/.test(normalized)
    ) {
      return 'Structure / Function';
    }
    if (/^(author view|author attitude)$/i.test(text) || /author('|’)s attitude|tone|author view/.test(normalized)) {
      return 'Author View';
    }
    if (/^application$/i.test(text) || /application|apply.*principle|analogous/.test(normalized)) return 'Application';
  }

  return text;
}

function normalizeQuantSubcategoryDisplay(value, categoryCode) {
  const text = String(value || '').trim();
  const normalized = text.toLowerCase();
  const category = String(categoryCode || '').trim().toUpperCase();

  if (!text) return '';
  if (!['PS', 'DS'].includes(category)) return '';

  if (category === 'DS' && /data sufficiency/.test(normalized)) return 'Unclear Topic';
  if (/unclear topic|poor quality|bad question|ambiguous/.test(normalized)) return 'Unclear Topic';
  if (/overlapping sets|venn|set theory/.test(normalized)) return 'Overlapping Sets';
  if (/statistics|mean|median|standard deviation|variance/.test(normalized)) return 'Statistics';
  if (/combin|permut|probab|counting/.test(normalized)) return 'Counting & Probability';
  if (/distance|speed|rate|work|time/.test(normalized)) return 'Rates, Work & Motion';
  if (/functions?|sequence|inequal|absolute value|custom character/.test(normalized)) return 'Functions, Sequences & Inequalities';
  if (/word problem|age problem|digit problem|mixture|problem solving/.test(normalized)) return 'General Word Problems';
  if (/percent|interest|fraction|ratio|proportion|arithmetic|decimal|average|fdp|remainder|multiple|factor/.test(normalized)) {
    return 'Arithmetic, FDP & Ratios';
  }
  if (/geometry|triangle|circle|area|volume|coordinate/.test(normalized)) return 'Geometry';
  if (/number properties|divis|integer|odd|even|prime/.test(normalized)) return 'Number Properties';
  if (/algebra|equation|quadratic|linear/.test(normalized)) return 'Algebra & Equations';

  return text;
}

function normalizeDiSubcategoryDisplay(value, categoryCode, contentDomain) {
  const text = String(value || '').trim();
  const normalized = text.toLowerCase();
  const category = String(categoryCode || '').trim().toUpperCase();
  const domain = String(contentDomain || '').trim().toLowerCase();

  if (!text) return '';

  if (category === 'GI') {
    if (/graphs|graphics interpretation|graph|chart|plot|axis/.test(normalized)) return 'Graphs';
    if (domain === 'math') return 'Math-Based Interpretation';
    if (domain === 'non_math') return 'Non-Math Interpretation';
    if (/non[- ]?math|verbal|reading|inference|author|purpose/.test(normalized)) return 'Non-Math Interpretation';
    if (/math[- ]?based|math[- ]?related|algebra|arithmetic|rate|probab|geometry|number properties|statistics/.test(normalized)) {
      return 'Math-Based Interpretation';
    }
  }

  if (category === 'TA') {
    if (/tables|table analysis|table/.test(normalized)) return 'Tables';
    if (domain === 'math') return 'Math-Based Analysis';
    if (domain === 'non_math') return 'Non-Math Analysis';
    if (/non[- ]?math|verbal|reading|inference|author|purpose/.test(normalized)) return 'Non-Math Analysis';
    if (/math[- ]?based|math[- ]?related|algebra|arithmetic|rate|probab|geometry|number properties|statistics/.test(normalized)) {
      return 'Math-Based Analysis';
    }
  }

  if (category === 'MSR' || category === 'TPA') {
    if (domain === 'math') return 'Math-Based Reasoning';
    if (domain === 'non_math') return 'Non-Math Reasoning';
    if (category === 'MSR' && /multi-source reasoning/.test(normalized)) return 'Unknown';
    if (category === 'TPA' && /two-part analysis/.test(normalized)) return 'Unknown';
    if (/non[- ]?math|verbal|reading|inference|author|purpose/.test(normalized)) return 'Non-Math Reasoning';
    if (/math[- ]?based|math[- ]?related|algebra|arithmetic|rate|probab|geometry|statistics/.test(normalized)) {
      return 'Math-Based Reasoning';
    }
  }

  return text;
}

// StartTest stores subcategory as a short abbreviation ("VEO", "ARI", "COR",
// also underscored ones like "R_P", "P_S") while the human-readable name
// lives in `topic`. Prefer `topic` whenever `subcategory` looks
// abbreviation-shaped (all-caps, ≤5 chars, only letters/digits/underscores).
function pickReadableSubcategory(row) {
  const sub = String(row?.subcategory || '').trim();
  const topic = String(row?.topic || '').trim();
  const looksAbbrev = sub.length > 0 && sub.length <= 5 && /^[A-Z0-9_]+$/.test(sub);
  if (looksAbbrev && topic) return topic;
  return sub || topic || '';
}

function normalizedSubcategory(row) {
  const category = normalizedCategoryCode(row);
  const raw = pickReadableSubcategory(row);
  if (!raw) return '-';
  const contentDomain = String(row?.content_domain || '').trim();
  return (
    normalizeVerbalSubcategoryDisplay(raw, category) ||
    normalizeQuantSubcategoryDisplay(raw, category) ||
    normalizeDiSubcategoryDisplay(raw, category, contentDomain) ||
    raw
  );
}

function normalizeSubjectCodeValue(value) {
  const upper = String(value || '').trim().toUpperCase();
  if (!upper) return '';
  if (['Q', 'QUANT', 'PS'].includes(upper)) return 'Q';
  if (['V', 'VERBAL', 'CR', 'RC'].includes(upper)) return 'V';
  if (['DI', 'DS', 'MSR', 'TPA', 'GI', 'TA'].includes(upper)) return 'DI';
  return upper;
}

function normalizeSubjectFamilyDisplay(value) {
  const normalized = normalizeSubjectCodeValue(value);
  if (normalized === 'Q') return 'Quant';
  if (normalized === 'V') return 'Verbal';
  if (normalized === 'DI') return 'Data Insights';
  return String(value || '').trim() || 'Other';
}

function truncateTableText(value, maxLength = 44) {
  const text = normalizeQuestionText(value);
  if (!text) return '-';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function SubjectCell({ row }) {
  const subjectCode = normalizedSubjectCode(row);
  const subjectDisplay = normalizeSubjectFamilyDisplay(subjectCode);
  const source = String(row?.source || '');
  // LSAT rows carry their own subject (RC / CR) which the GMAT subject normalizer
  // would collapse into "Verbal" — show it verbatim instead.
  if (/lsat/i.test(source)) {
    return (
      <div className="section-cell">
        <span className="section-chip" title={source}>{row?.subject || '—'}</span>
      </div>
    );
  }
  const isOpe = /official\s*practice\s*exam/i.test(source);
  // OPE sessions span all 3 sections, so the row-level subject is "Mixed"/"Other".
  // Replace that with the exam set name parsed out of the source label — much
  // more useful than a meaningless "OTHER" chip.
  if (isOpe && (!subjectCode || subjectDisplay === 'Other' || subjectDisplay === 'Mixed')) {
    const match = source.match(/practice\s*exam\s*(\d+)/i);
    const label = match ? `OPE #${match[1]}` : 'Practice Exam';
    return (
      <div className="section-cell">
        <span className="section-chip section-chip--ope" title={source}>{label}</span>
      </div>
    );
  }
  return (
    <div className="section-cell">
      <span className="section-chip">{subjectDisplay}</span>
    </div>
  );
}

function getSourcePlatform(sourceLabel) {
  const raw = String(sourceLabel || '').trim();
  if (!raw) return null;
  if (/lsat/i.test(raw)) return 'lsat';
  if (/gmat\s*club\s*cat/i.test(raw)) return 'gmatclub-cat';
  if (/gmat\s*club/i.test(raw)) return 'gmatclub';
  if (/target\s*test\s*prep/i.test(raw)) return 'ttp';
  if (/official\s*practice\s*exam/i.test(raw)) return 'ope-mock';
  return 'starttest';
}

function SourceBadge({ source }) {
  const platform = getSourcePlatform(source);
  if (!platform) return <span className="muted">-</span>;
  const label =
    platform === 'lsat' ? 'LSAT' :
    platform === 'gmatclub-cat' ? 'GMAT Club CAT' :
    platform === 'gmatclub' ? 'GMAT Club' :
    platform === 'ttp' ? 'Target Test Prep' :
    platform === 'ope-mock' ? 'Practice Exam' :
    'Official Guide';
  return (
    <span className={`source-chip source-${platform}`} title={source || ''}>
      {label}
    </span>
  );
}

// OPE scaled-score chip: "535 · Q78 V80 DI72". Renders nothing if no
// total_score is set (Phase 2 score-summary scrape hasn't run for this row).
function ScoreChip({ row }) {
  if (!row || row.total_score == null) return null;
  const parts = [];
  if (row.quant_score != null) parts.push(`Q${row.quant_score}`);
  if (row.verbal_score != null) parts.push(`V${row.verbal_score}`);
  if (row.di_score != null) parts.push(`DI${row.di_score}`);
  const title = [
    row.total_percentile != null ? `Total ${row.total_score} (${row.total_percentile}th %ile)` : `Total ${row.total_score}`,
    row.quant_score != null ? `Quant ${row.quant_score}${row.quant_percentile != null ? ` (${row.quant_percentile}th)` : ''}` : null,
    row.verbal_score != null ? `Verbal ${row.verbal_score}${row.verbal_percentile != null ? ` (${row.verbal_percentile}th)` : ''}` : null,
    row.di_score != null ? `DI ${row.di_score}${row.di_percentile != null ? ` (${row.di_percentile}th)` : ''}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <span className="score-chip" title={title}>
      <strong>{row.total_score}</strong>
      {parts.length > 0 && <span className="score-chip-sub"> · {parts.join(' ')}</span>}
    </span>
  );
}

function mapSubjectFamily(subject) {
  const raw = String(subject || '').trim();
  const upper = raw.toUpperCase();
  if (['V', 'CR', 'RC', 'VERBAL'].includes(upper)) return 'Verbal';
  if (['Q', 'PS', 'QUANT'].includes(upper)) return 'Quant';
  if (['DI', 'DS', 'TA', 'GI', 'MSR', 'TPA', 'DATA INSIGHTS'].includes(upper)) return 'DI';
  return 'Other';
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  let data = {};
  let rawBody = '';
  try {
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      rawBody = await response.text();
      if (rawBody) {
        try {
          data = JSON.parse(rawBody);
        } catch (_parseError) {
          data = {};
        }
      }
    }
  } catch (_error) {
    data = {};
  }

  if (!response.ok) {
    const fallbackMessage = rawBody
      ? `Request failed (${response.status}): ${String(rawBody).replace(/\s+/g, ' ').trim().slice(0, 220)}`
      : `Request failed (${response.status})`;
    const error = new Error(data.error || fallbackMessage);
    error.status = response.status;
    error.hint = data.hint || '';
    error.details = data.details || rawBody || '';
    error.debug = data.debug || null;
    throw error;
  }
  return data;
}

function formatRequestError(error) {
  const parts = [error?.message || 'Request failed', error?.hint || ''].filter(Boolean);
  return parts.join(' ');
}

const AI_COACH_QUICK_PROMPTS = [
  'What are my top 3 weak areas right now?',
  'Give me a 45-minute drill for today.',
  'How should I improve timing without hurting accuracy?',
  'Which mistakes should I fix first for score gain?',
];

function buildCoachGreeting(scopeLabel) {
  const scope = scopeLabel === 'All runs' ? 'your whole practice record' : scopeLabel;
  return {
    role: 'assistant',
    content: `Ready when you are — I’ve read ${scope}. Ask where you’re losing the most points, what to drill next, or how to steady your timing, and I’ll give it to you straight.`,
  };
}

// Per-platform domains used to detect (best-effort) whether the user's
// debug-Chrome already has the right practice tab open, so step 2 can confirm.
const FIRST_RUN_PLATFORM_DOMAINS = {
  starttest: ['starttest.com'],
  gmatclub: ['gmatclub.com'],
  ttp: ['targettestprep.com'],
  'ope-mock': ['mba.com'],
};

function firstRunPracticeTabOpen(tabs, platform) {
  const domains = FIRST_RUN_PLATFORM_DOMAINS[platform] || [];
  if (!domains.length || !Array.isArray(tabs)) return false;
  return tabs.some((t) => domains.some((d) => String(t.url || '').includes(d)));
}

// First-run activation panel. Shown only when the database is genuinely empty
// (no runs, no sessions, no errors) so a returning user never sees it. It is a
// live checklist, not a static teach card: the CTA fires step 1 (open
// debug-Chrome), the steps light up from a polled CDP status, and the scrape
// runs inline so the warm first-run moment never hands off to a cold modal.
function FirstRunWelcome({
  cdpStatus,
  sources,
  selectedSource,
  onSelectSource,
  onOpenChrome,
  isOpening,
  onOpenProduct,
  isOpeningProduct,
  onScrape,
  isScraping,
  onOpenSyncPanel,
  status,
}) {
  const headingRef = useRef(null);
  useEffect(() => {
    // Land keyboard / screen-reader focus on the panel when it first appears.
    headingRef.current?.focus();
  }, []);

  const preset = sources.find((s) => s.id === selectedSource);
  const platform = preset?.platform || 'starttest';
  const cdpUp = Boolean(cdpStatus?.connected);
  const practiceTabOpen = cdpUp && firstRunPracticeTabOpen(cdpStatus?.tabs, platform);
  const isOpe = platform === 'ope-mock';

  const step1 = cdpUp ? 'done' : 'active';
  const step2 = practiceTabOpen ? 'done' : cdpUp ? 'active' : 'pending';
  const step3 = cdpUp ? 'active' : 'pending';
  const busy = isOpening || isOpeningProduct || isScraping;

  return (
    <section className="first-run" aria-labelledby="first-run-title">
      <div className="first-run-card">
        <h2 id="first-run-title" className="first-run-title" tabIndex={-1} ref={headingRef}>
          Let’s get your first session in.
        </h2>
        <p className="first-run-lede">
          This is your private GMAT record. Connect your practice, run one scrape, and
          your sessions, errors, and weak spots fill in below.
        </p>

        <ol className="first-run-steps">
          <li className={`first-run-step is-${step1}`}>
            <span className="first-run-step-num" aria-hidden="true">{step1 === 'done' ? '✓' : '1'}</span>
            <div className="first-run-step-body">
              <strong>Open Chrome with debugging on</strong>
              <p>Launches your logged-in Chrome on port 9222 so the scraper can read your history.</p>
              <div className="first-run-step-action">
                <Button
                  type="button"
                  size="sm"
                  variant={cdpUp ? 'outline' : undefined}
                  onClick={onOpenChrome}
                  disabled={isOpening}
                >
                  {isOpening ? 'Opening…' : cdpUp ? 'Reopen Chrome' : 'Open Chrome'}
                </Button>
                <span className={`first-run-dot ${cdpUp ? 'is-on' : 'is-off'}`} role="status">
                  {cdpUp ? 'Chrome connected on :9222' : 'Not detected yet'}
                </span>
              </div>
            </div>
          </li>

          <li className={`first-run-step is-${step2}`}>
            <span className="first-run-step-num" aria-hidden="true">{step2 === 'done' ? '✓' : '2'}</span>
            <div className="first-run-step-body">
              <strong>Log in and open your practice</strong>
              <p>Pick your source, then open it in that Chrome window.</p>
              <div className="first-run-step-action">
                <Select
                  className="first-run-source"
                  value={selectedSource}
                  onChange={(e) => onSelectSource(e.target.value)}
                  aria-label="Practice source"
                >
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </Select>
                {platform === 'starttest' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onOpenProduct}
                    disabled={!cdpUp || isOpeningProduct}
                  >
                    {isOpeningProduct ? 'Opening…' : 'Open in GMAT'}
                  </Button>
                ) : (
                  <span className="first-run-note">Log in to {preset?.label || 'your practice'} in the Chrome window.</span>
                )}
                {practiceTabOpen && <span className="first-run-dot is-on" role="status">Practice tab open</span>}
              </div>
            </div>
          </li>

          <li className={`first-run-step is-${step3}`}>
            <span className="first-run-step-num" aria-hidden="true">3</span>
            <div className="first-run-step-body">
              <strong>Run the scrape</strong>
              <p>Your sessions, errors, and topic breakdowns fill in here. It takes about a minute.</p>
              <div className="first-run-step-action">
                {isOpe ? (
                  <>
                    <Button type="button" size="sm" onClick={onOpenSyncPanel}>Open Sync panel</Button>
                    <span className="first-run-note">Mock exams need a take picked in the full panel.</span>
                  </>
                ) : (
                  <Button type="button" size="sm" onClick={onScrape} disabled={!cdpUp || isScraping}>
                    {isScraping ? 'Scraping…' : 'Run scrape'}
                  </Button>
                )}
              </div>
            </div>
          </li>
        </ol>

        {status?.message && (
          <p
            className={`first-run-status${status.isError ? ' is-error' : ''}`}
            role={status.isError ? 'alert' : 'status'}
            aria-busy={busy || undefined}
          >
            {status.message}
          </p>
        )}

        <button type="button" className="first-run-advanced" onClick={onOpenSyncPanel}>
          Use the full Sync panel
        </button>
      </div>
    </section>
  );
}

function modeFromHash(hash) {
  if (hash === '#lsat') return 'lsat';
  if (hash === '#study-plan' || hash === '#plan') return 'study-plan';
  return 'gmat';
}

function App() {
  const [appMode, setAppMode] = useState(() => {
    if (typeof window === 'undefined') return 'gmat';
    return modeFromHash(window.location.hash);
  });
  useEffect(() => {
    function onHashChange() {
      setAppMode(modeFromHash(window.location.hash));
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  // App stays mounted while the LSAT / study-plan surfaces are shown, so the
  // dashboard data goes stale (e.g. an LSAT session practiced just now is
  // missing from Performance by Session). Refetch on return to the dashboard.
  const prevAppModeRef = useRef(appMode);
  useEffect(() => {
    const prev = prevAppModeRef.current;
    prevAppModeRef.current = appMode;
    if (appMode === 'gmat' && prev !== 'gmat') {
      loadDashboard().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appMode]);
  const [status, setStatus] = useState({ message: 'Loading...', isError: false });
  const [bootError, setBootError] = useState(null);
  const [isDashboardLoading, setIsDashboardLoading] = useState(true);
  const [sources, setSources] = useState([]);
  const [selectedSource, setSelectedSource] = useState('');
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [scrapeWindow, setScrapeWindow] = useState('today');
  const [customSince, setCustomSince] = useState('');
  const [sessions, setSessions] = useState([]);
  const [errors, setErrors] = useState([]);
  const [patterns, setPatterns] = useState({
    bySubject: [],
    byDifficulty: [],
    confidenceMismatch: [],
    subjectProgress: [],
    categoryBreakdown: [],
    subtopicBreakdown: [],
  });
  const [filters, setFilters] = useState({ subject: '', difficulty: '', topic: '', confidence: '', search: '', mistakeTag: '', platform: '' });
  const [syncCenterOpen, setSyncCenterOpen] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [isOpeningProduct, setIsOpeningProduct] = useState(false);
  const [isScraping, setIsScraping] = useState(false);
  // Live debug-Chrome status for the first-run checklist (polled while empty-DB).
  const [cdpStatus, setCdpStatus] = useState({ connected: false, tabs: [], checked: false });
  const [isEnriching, setIsEnriching] = useState(false);
  const [lastEnrichResult, setLastEnrichResult] = useState(null);
  // Session id pending enrich confirmation. We use an in-app dialog instead of a
  // native window.confirm(): the dashboard typically runs in the same Chrome the
  // scraper drives over CDP, and any attached Playwright/CDP client auto-dismisses
  // native JS dialogs the instant they open — which made the confirm flash and
  // vanish so enrich never ran. Plain DOM can't be auto-dismissed.
  const [enrichConfirmId, setEnrichConfirmId] = useState(null);
  // OPE (mock exam) take-picker state. Populated when the selected source is
  // an ope-mock platform; cleared otherwise.
  const [opeTakes, setOpeTakes] = useState([]);
  const [selectedTakeIdx, setSelectedTakeIdx] = useState('');
  const [isLoadingOpeTakes, setIsLoadingOpeTakes] = useState(false);
  const [opeTakesError, setOpeTakesError] = useState('');
  // Wipe any previously-loaded OPE takes whenever the selected source changes
  // so stale rows from another OPE don't leak into the new pick.
  useEffect(() => {
    setOpeTakes([]);
    setSelectedTakeIdx('');
    setOpeTakesError('');
  }, [selectedSource]);
  const [syncDebug, setSyncDebug] = useState(null);
  const [patternDrilldown, setPatternDrilldown] = useState({
    open: false,
    loading: false,
    error: '',
    title: '',
    criteria: { subject: '', difficulty: '', topic: '', confidence: '' },
    rows: [],
  });
  const [sessionAnalysis, setSessionAnalysis] = useState({
    open: false,
    loading: false,
    error: '',
    data: null,
  });
  const [annotation, setAnnotation] = useState({
    open: false,
    saving: false,
    error: '',
    row: null,
    mistakeTags: [],
    notes: '',
  });
  const [questionReview, setQuestionReview] = useState({
    open: false,
    row: null,
  });
  const [openingQuestionKey, setOpeningQuestionKey] = useState('');
  const [sessionSubjectFilter, setSessionSubjectFilter] = useState('');
  const [sessionPlatformFilter, setSessionPlatformFilter] = useState('');
  const [sessionSort, setSessionSort] = useState({ key: 'session_date', order: 'desc' });
  const [sessionAnalysisSort, setSessionAnalysisSort] = useState({ key: 'correct', order: 'asc' });
  const [sessionAnalysisSubjectFilter, setSessionAnalysisSubjectFilter] = useState('');
  const [sessionAnalysisCategoryFilter, setSessionAnalysisCategoryFilter] = useState('');
  const [sessionAnalysisResultFilter, setSessionAnalysisResultFilter] = useState('');
  const [errorSort, setErrorSort] = useState({ key: 'session_date', order: 'desc' });
  const [categoryBreakdownSort, setCategoryBreakdownSort] = useState({ key: 'subject_family', order: 'asc' });
  const [subcategoryBreakdownSort, setSubcategoryBreakdownSort] = useState({ key: 'total_questions', order: 'desc' });
  const [sessionDateRange, setSessionDateRange] = useState({ start: '', end: '' });
  const [expandedCategoryKey, setExpandedCategoryKey] = useState('');
  const [expandedErrorId, setExpandedErrorId] = useState(null);
  const [errorFiltersOpen, setErrorFiltersOpen] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [aiReview, setAiReview] = useState('');
  const [isGeneratingAiReview, setIsGeneratingAiReview] = useState(false);
  const [aiFocus, setAiFocus] = useState('');
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiMessages, setAiMessages] = useState([]);
  const [isAskingAi, setIsAskingAi] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [coachTab, setCoachTab] = useState('chat');
  const [chatSessionId, setChatSessionId] = useState(null);
  const [chatSessions, setChatSessions] = useState([]);
  const [showSessionList, setShowSessionList] = useState(false);
  const aiChatEndRef = useRef(null);

  const [showDifficultyCols, setShowDifficultyCols] = useState(false);
  const [showSessionDifficultyCols, setShowSessionDifficultyCols] = useState(false);

  // Collapsible sections state
  const [collapsedSections, setCollapsedSections] = useState({
    today: false,
    topicDashboard: false,
    categoryBreakdown: false,
    performanceBySession: false,
    errorLog: false,
  });

  const toggleSection = (section) => {
    setCollapsedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  // Pagination state
  const [sessionPagination, setSessionPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
  const [errorPagination, setErrorPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 0 });

  const summary = useMemo(() => {
    if (!runs.length) {
      return { id: '-', total_sessions: 0, total_questions: 0, total_errors: 0 };
    }
    if (selectedRunId) {
      const run = runs.find((row) => String(row.id) === String(selectedRunId));
      return run || { id: '-', total_sessions: 0, total_questions: 0, total_errors: 0 };
    }
    return {
      id: 'All',
      total_sessions: runs.reduce((sum, row) => sum + (row.total_sessions || 0), 0),
      total_questions: runs.reduce((sum, row) => sum + (row.total_questions || 0), 0),
      total_errors: runs.reduce((sum, row) => sum + (row.total_errors || 0), 0),
    };
  }, [runs, selectedRunId]);

  const sourceAppUrlByLabel = useMemo(() => {
    const map = new Map();
    for (const source of sources) {
      const label = String(source?.label || '').trim().toLowerCase();
      const appUrl = String(source?.appUrl || '').trim();
      if (label && appUrl) map.set(label, appUrl);
    }
    return map;
  }, [sources]);

  const aiRunId = useMemo(() => {
    if (!selectedRunId) return null;
    const parsed = Number(selectedRunId);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, [selectedRunId]);

  const aiScopeLabel = aiRunId ? `Run ${aiRunId}` : 'All runs';

  async function loadCoachSessions() {
    try {
      const data = await fetchJson('/api/ai/sessions?limit=30');
      setChatSessions(data.sessions || []);
      return data.sessions || [];
    } catch {
      return [];
    }
  }

  async function loadSessionMessages(sessionId) {
    try {
      const data = await fetchJson(`/api/ai/sessions/${sessionId}`);
      const msgs = (data.messages || []).map((m) => ({ role: m.role, content: m.content }));
      setAiMessages([buildCoachGreeting(aiScopeLabel), ...msgs]);
      setChatSessionId(sessionId);
    } catch {
      setChatSessionId(null);
      setAiMessages([buildCoachGreeting(aiScopeLabel)]);
    }
  }

  async function startNewSession() {
    try {
      const data = await fetchJson('/api/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: aiRunId }),
      });
      setChatSessionId(data.session?.id || null);
      setAiMessages([buildCoachGreeting(aiScopeLabel)]);
      setAiQuestion('');
      loadCoachSessions();
    } catch {
      setChatSessionId(null);
      setAiMessages([buildCoachGreeting(aiScopeLabel)]);
    }
  }

  async function handleSelectSession(sessionId) {
    await loadSessionMessages(sessionId);
    setShowSessionList(false);
  }

  async function handleDeleteSession(sessionId) {
    if (!window.confirm('Delete this chat session? This cannot be undone.')) return;
    try {
      await fetchJson(`/api/ai/sessions/${sessionId}`, { method: 'DELETE' });
      setChatSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (chatSessionId === sessionId) {
        startNewSession();
      }
    } catch {
      // ignore
    }
  }

  async function loadSources() {
    const data = await fetchJson('/api/sources');
    const rows = data.sources || [];
    setSources(rows);
    if (!selectedSource && rows[0]?.id) {
      setSelectedSource(rows[0].id);
    }
  }

  async function loadRuns() {
    const data = await fetchJson('/api/runs');
    setRuns(data.runs || []);
  }

  async function loadDashboard(runId = selectedRunId) {
    // Initial load: fetch first page of sessions and first page of errors
    await Promise.all([
      loadSessions(1, runId),
      loadErrors(1, runId),
      (async () => {
        const runQuery = runId ? `?runId=${runId}` : '';
        const patternsRes = await fetchJson(`/api/patterns${runQuery}`);
        setPatterns({
          bySubject: patternsRes.bySubject || [],
          byDifficulty: patternsRes.byDifficulty || [],
          confidenceMismatch: patternsRes.confidenceMismatch || [],
          subjectProgress: patternsRes.subjectProgress || [],
          categoryBreakdown: patternsRes.categoryBreakdown || [],
          subtopicBreakdown: patternsRes.subtopicBreakdown || [],
        });
      })(),
    ]);
  }

  async function loadSessions(
    page,
    runId = selectedRunId,
    platform = sessionPlatformFilter,
    subject = sessionSubjectFilter,
    dateRange = sessionDateRange,
  ) {
    const params = new URLSearchParams();
    if (runId) params.set('runId', runId);
    params.set('page', page);
    params.set('pageSize', sessionPagination.pageSize);
    if (platform) params.set('platform', platform);
    if (subject) params.set('subject', subject);
    if (dateRange?.start) params.set('startDate', dateRange.start);
    if (dateRange?.end) params.set('endDate', dateRange.end);
    const data = await fetchJson(`/api/sessions?${params.toString()}`);
    setSessions(data.sessions || []);
    setSessionPagination({
      page: data.page,
      pageSize: data.pageSize,
      total: data.total,
      totalPages: data.totalPages,
    });
  }

  async function loadErrors(page, runId = selectedRunId, customFilters = filters, customSort = errorSort) {
    const params = new URLSearchParams();
    if (runId) params.set('runId', runId);
    params.set('page', page);
    params.set('pageSize', errorPagination.pageSize);
    if (customFilters.subject) params.set('subject', customFilters.subject);
    if (customFilters.difficulty) params.set('difficulty', customFilters.difficulty);
    if (customFilters.topic) params.set('topic', customFilters.topic);
    if (customFilters.confidence) params.set('confidence', customFilters.confidence);
    if (customFilters.search) params.set('search', customFilters.search);
    if (customFilters.mistakeTag) params.set('mistakeTag', customFilters.mistakeTag);
    if (customFilters.platform) params.set('platform', customFilters.platform);
    params.set('sortKey', customSort.key);
    params.set('sortOrder', customSort.order);

    const data = await fetchJson(`/api/errors?${params.toString()}`);
    const rows = Array.isArray(data.errors) ? data.errors : [];
    setErrors(rows);
    setErrorPagination({
      page: data.page,
      pageSize: data.pageSize,
      total: data.total,
      totalPages: data.totalPages,
    });
    return rows;
  }

  async function runBoot() {
    setIsDashboardLoading(true);
    setBootError(null);
    setStatus({ message: 'Loading…', isError: false });
    try {
      await loadSources();
      await loadRuns();
      await loadDashboard('');
      setStatus({ message: 'Ready. Start by opening Chrome and running scrape.', isError: false });
    } catch (error) {
      setBootError({ message: formatRequestError(error), status: error?.status || null });
      setStatus({ message: formatRequestError(error), isError: true });
    } finally {
      setIsDashboardLoading(false);
    }
  }

  useEffect(() => {
    runBoot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!sessionAnalysis.open && !patternDrilldown.open && !syncCenterOpen && !annotation.open && !questionReview.open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [sessionAnalysis.open, patternDrilldown.open, syncCenterOpen, annotation.open, questionReview.open]);

  useEffect(() => {
    function handleEscape(event) {
      if (event.key !== 'Escape') return;
      if (annotation.open) { handleCloseAnnotation(); return; }
      if (questionReview.open) { handleCloseQuestionReview(); return; }
      if (patternDrilldown.open) { setPatternDrilldown((prev) => ({ ...prev, open: false })); return; }
      if (sessionAnalysis.open) { handleCloseSessionAnalysis(); return; }
      if (syncCenterOpen) { setSyncCenterOpen(false); return; }
      if (coachOpen) { setCoachOpen(false); return; }
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [annotation.open, questionReview.open, patternDrilldown.open, sessionAnalysis.open, syncCenterOpen, coachOpen]);

  useEffect(() => {
    setAiReview('');
    setAiQuestion('');
    setAiMessages([buildCoachGreeting(aiScopeLabel)]);
    setChatSessionId(null);
    // Load most recent session or create one
    loadCoachSessions().then((sessions) => {
      if (sessions.length > 0) {
        loadSessionMessages(sessions[0].id);
      }
    });
  }, [aiScopeLabel]);

  useEffect(() => {
    // Scroll only the coach chat log to its newest message — NOT the whole document.
    // scrollIntoView() bubbles to every scrollable ancestor (incl. the window), so on
    // dashboard load (when coach messages arrive) it yanked the page down. Scrolling the
    // container's own scrollTop keeps the chat pinned to the bottom without moving the page.
    const log = aiChatEndRef.current?.closest('.coach-chat-log');
    if (log) log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
  }, [aiMessages, isAskingAi]);

  // Auto-apply error log filters on change (debounced for search input)
  useEffect(() => {
    const id = setTimeout(() => {
      loadErrorsByFilters(filters).catch(() => {});
    }, filters.search ? 350 : 0);
    return () => clearTimeout(id);
  }, [filters.subject, filters.difficulty, filters.confidence, filters.search, filters.mistakeTag, filters.topic, filters.platform]);

  // Reload sessions list when any server-side filter changes — resets to page 1
  // so pagination totals stay in sync with what's rendered.
  useEffect(() => {
    loadSessions(1, selectedRunId, sessionPlatformFilter, sessionSubjectFilter, sessionDateRange).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPlatformFilter, sessionSubjectFilter, sessionDateRange.start, sessionDateRange.end]);

  async function handleOpenChrome() {
    if (!selectedSource) return;
    setIsOpening(true);
    setStatus({ message: 'Opening Chrome with remote debugging...', isError: false });
    try {
      const result = await fetchJson('/api/open-chrome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cdpUrl: DEFAULT_CDP_URL,
          source: selectedSource,
        }),
      });
      setStatus({
        message: `Chrome launched on port ${result.port} for ${result.source}. Log in and run scrape.`,
        isError: false,
      });
      setSyncDebug({
        action: 'open-chrome',
        ok: true,
        at: new Date().toISOString(),
        source: result.source,
        appUrl: result.appUrl,
        port: result.port,
        profileDir: result.profileDir,
      });
    } catch (error) {
      setStatus({ message: formatRequestError(error), isError: true });
      setSyncDebug({
        action: 'open-chrome',
        ok: false,
        at: new Date().toISOString(),
        error: error?.message || 'Open Chrome failed',
        hint: error?.hint || '',
        details: error?.details || '',
      });
    } finally {
      setIsOpening(false);
    }
  }

  // Navigate the user's already-logged-in Chrome tab to the selected GMAT
  // product's home page. Used before Run Scrape so the scraper finds the
  // right product's session table without having to switch products itself.
  async function handleOpenProduct() {
    if (!selectedSource) return;
    setIsOpeningProduct(true);
    setStatus({ message: `Navigating your GMAT tab to "${selectedSource}"...`, isError: false });
    try {
      const result = await fetchJson('/api/open-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cdpUrl: DEFAULT_CDP_URL, source: selectedSource }),
      });
      const mismatch = result.matches === false;
      setStatus({
        message: mismatch
          ? `Tab did not switch to "${result.expectedHeading}" (tab shows "${result.activeHeading}"). Check your GMAT account owns this book.`
          : `GMAT tab is on "${result.activeHeading || result.expectedHeading || result.source}". Ready to scrape.`,
        isError: mismatch,
      });
      setSyncDebug({
        action: 'open-product',
        ok: true,
        at: new Date().toISOString(),
        source: result.source,
        expectedHeading: result.expectedHeading,
        activeHeading: result.activeHeading,
        matches: result.matches,
        tabUrl: result.tabUrl,
        debug: result.debug || null,
      });
    } catch (error) {
      setStatus({ message: formatRequestError(error), isError: true });
      setSyncDebug({
        action: 'open-product',
        ok: false,
        at: new Date().toISOString(),
        error: error?.message || 'Open product failed',
        hint: error?.hint || '',
        details: error?.details || '',
        debug: error?.debug || null,
      });
    } finally {
      setIsOpeningProduct(false);
    }
  }

  // Phase 2 (per-session deep enrichment). Long-running (~3–5 min for 20 items).
  // Hits each item's review page sequentially with human-like jitter; saves
  // stem/choices/passage/precise time/user-answer to the existing rows.
  async function handleEnrichSession(sessionId) {
    if (!sessionId || isEnriching) return;
    setIsEnriching(true);
    setLastEnrichResult(null);
    setStatus({
      message: 'Phase 2 enrichment running. This may take a few minutes — keep your GMAT tab on the matching product home and don\'t click around in it.',
      isError: false,
    });
    try {
      const result = await fetchJson(`/api/sessions/${sessionId}/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cdpUrl: DEFAULT_CDP_URL }),
      });
      const summary = result.aborted
        ? `Phase 2 aborted at ${result.dbUpdated}/${result.qhTotal} items: ${result.abortReason}. Saved partial data.`
        : `Phase 2 complete: ${result.dbUpdated}/${result.qhTotal} items enriched.`;
      setStatus({ message: summary, isError: !!result.aborted });
      setLastEnrichResult(result);
      // Refresh the session analysis modal so newly-enriched fields show up.
      if (sessionAnalysis.data?.session?.id === sessionId) {
        await handleOpenSessionAnalysis(sessionAnalysis.data.session);
      }
      // Phase 2 rewrites per-question time_sec from vPreviousTimeSpent, so the
      // session-list aggregates can shift. Refresh the table so its avg_time
      // matches the modal's freshly fetched value.
      loadSessions(sessionPagination.page, selectedRunId, sessionPlatformFilter).catch(() => {});
    } catch (error) {
      setStatus({ message: formatRequestError(error), isError: true });
      setLastEnrichResult({
        ok: false,
        error: error?.message || 'Enrich failed',
        hint: error?.hint || '',
        details: error?.details || '',
        debug: error?.debug || null,
      });
    } finally {
      setIsEnriching(false);
    }
  }

  // OPE-only: list the user's completed takes for the selected OPE so they can
  // pick which take to scrape. Backend reads the Take # table on the OPE
  // landing page via CDP.
  async function loadOpeTakes() {
    if (!selectedSource) return;
    setIsLoadingOpeTakes(true);
    setOpeTakesError('');
    setOpeTakes([]);
    setSelectedTakeIdx('');
    try {
      const result = await fetchJson(
        `/api/ope/attempts?source=${encodeURIComponent(selectedSource)}&cdpUrl=${encodeURIComponent(DEFAULT_CDP_URL)}`,
      );
      const completed = (result.takes || []).filter((t) => t.status === 'completed' && t.hasReport);
      setOpeTakes(completed);
      // Auto-select the most recently completed take (last in the list per StartTest's row order).
      if (completed.length) setSelectedTakeIdx(String(completed[completed.length - 1].takeIdx));
    } catch (error) {
      setOpeTakesError(error?.message || 'Failed to load takes.');
    } finally {
      setIsLoadingOpeTakes(false);
    }
  }

  async function handleScrape() {
    if (!selectedSource) return;
    const currentPreset = sources.find((s) => s.id === selectedSource);
    const isOpe = currentPreset?.platform === 'ope-mock';
    if (isOpe && !selectedTakeIdx) {
      setStatus({ message: 'Pick a take to scrape (Load Takes → choose one).', isError: true });
      return;
    }
    setIsScraping(true);
    setStatus({ message: 'Scrape running. Keep GMAT tab open until complete...', isError: false });
    try {
      const result = await fetchJson('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: selectedSource,
          cdpUrl: DEFAULT_CDP_URL,
          scrapeWindow,
          customSince: scrapeWindow === 'custom' ? customSince : '',
          ...(isOpe ? { takeIdx: Number(selectedTakeIdx) } : {}),
        }),
      });
      setSelectedRunId('');
      await loadRuns();
      await loadDashboard('');
      const diagnostics = result?.debug?.diagnostics || null;
      const warningText = result.warning ? ` ${result.warning}` : '';
      const diagnosticsText = diagnostics
        ? ` sessions=${diagnostics.sessions}, questions=${diagnostics.questions}, errors=${diagnostics.errors}.`
        : '';
      setStatus({
        message: `Run ${result.run.id} complete (${result.source}, ${result.scrapeWindowUsed}, since ${result.sinceUsed} ICT/UTC+7).${diagnosticsText}${warningText}`,
        isError: Boolean(result.warning),
      });
      setSyncDebug({
        action: 'scrape',
        ok: true,
        at: new Date().toISOString(),
        source: result.source,
        sinceUsed: result.sinceUsed,
        scrapeWindowUsed: result.scrapeWindowUsed,
        runId: result?.run?.id,
        tabUrl: result.tabUrl,
        warning: result.warning || '',
        debug: result.debug || null,
      });
    } catch (error) {
      setStatus({ message: formatRequestError(error), isError: true });
      setSyncDebug({
        action: 'scrape',
        ok: false,
        at: new Date().toISOString(),
        error: error?.message || 'Scrape failed',
        hint: error?.hint || '',
        details: error?.details || '',
        debug: error?.debug || null,
      });
      // Keep full context in browser devtools as well.
      // eslint-disable-next-line no-console
      console.error('Scrape request failed', error);
    } finally {
      setIsScraping(false);
    }
  }

  // Probe the local debug-Chrome. Never throws to the caller; a down browser is
  // a normal state, not an error, so the first-run checklist just shows it.
  async function checkCdpStatus() {
    try {
      const result = await fetchJson('/api/cdp-status');
      setCdpStatus({
        connected: Boolean(result?.connected),
        tabs: Array.isArray(result?.tabs) ? result.tabs : [],
        checked: true,
      });
      return result;
    } catch {
      setCdpStatus({ connected: false, tabs: [], checked: true });
      return null;
    }
  }

  async function handleRunChange(event) {
    const runId = event.target.value;
    setSelectedRunId(runId);
    try {
      await loadDashboard(runId);
    } catch (error) {
      setStatus({ message: error.message, isError: true });
    }
  }

  async function loadErrorsByFilters(customFilters = filters) {
    return loadErrors(1, selectedRunId, customFilters);
  }

  async function handleApplyFilter(event) {
    event.preventDefault();
    try {
      await loadErrorsByFilters(filters);
    } catch (error) {
      setStatus({ message: error.message, isError: true });
    }
  }

  async function handleOpenPatternDrilldown(type, value, extra = {}) {
    const criteria = { subject: '', difficulty: '', topic: '', confidence: '' };
    if (type === 'topic') criteria.topic = value;
    if (type === 'difficulty') criteria.difficulty = value;
    if (type === 'confidence') criteria.confidence = value;
    if (type === 'subject') criteria.subject = value;
    if (extra.subject) criteria.subject = extra.subject;

    setPatternDrilldown({
      open: true,
      loading: true,
      error: '',
      title: `${type[0].toUpperCase()}${type.slice(1)}: ${value}`,
      criteria,
      rows: [],
    });

    try {
      const rows = await loadErrorsByFilters(criteria);
      setPatternDrilldown({
        open: true,
        loading: false,
        error: '',
        title: `${type[0].toUpperCase()}${type.slice(1)}: ${value}`,
        criteria,
        rows,
      });
    } catch (error) {
      setPatternDrilldown({
        open: true,
        loading: false,
        error: error.message,
        title: `${type[0].toUpperCase()}${type.slice(1)}: ${value}`,
        criteria,
        rows: [],
      });
    }
  }

  const subjectCards = useMemo(() => {
    const groups = new Map();
    for (const row of patterns.subjectProgress || []) {
      const family = normalizeSubjectFamilyDisplay(row.subject_family || row.subject_sub);
      if (!groups.has(family)) {
        groups.set(family, {
          family,
          total: 0,
          correct: 0,
          wrong: 0,
          weightedTime: 0,
          subs: [],
        });
      }
      const group = groups.get(family);
      const total = Number(row.total || 0);
      const correct = Number(row.correct || 0);
      const wrong = Number(row.wrong || 0);
      const avgTime = Number(row.avg_time_sec || 0);

      group.total += total;
      group.correct += correct;
      group.wrong += wrong;
      group.weightedTime += avgTime * total;
      group.subs.push({
        subject_sub: row.subject_sub,
        total,
        correct,
        wrong,
        accuracy_pct: Number(row.accuracy_pct || 0),
      });
    }

    const order = ['Verbal', 'Quant', 'Data Insights', 'Other'];
    return Array.from(groups.values())
      .sort((a, b) => order.indexOf(a.family) - order.indexOf(b.family))
      .map((group) => ({
        ...group,
        accuracy_pct: group.total ? Number(((group.correct * 100) / group.total).toFixed(1)) : 0,
        avg_time_sec: group.total ? Math.round(group.weightedTime / group.total) : 0,
        subs: group.subs.sort((a, b) => b.total - a.total),
      }));
  }, [patterns.subjectProgress]);

  const categoryRows = useMemo(() => {
    const groups = new Map();
    for (const row of patterns.categoryBreakdown || []) {
      const subjectFamily = normalizeSubjectFamilyDisplay(row.subject_family);
      const category = normalizedCategoryCode(row);
      const key = `${subjectFamily}|${category}`;
      if (!groups.has(key)) {
        groups.set(key, {
          subject_family: subjectFamily,
          subject_sub: category,
          total_questions: 0,
          correct_count: 0,
          incorrect_count: 0,
          weighted_avg_time_sec: 0,
          hard_total: 0,
          hard_correct_estimate: 0,
          hard_weighted_avg_time_sec: 0,
          medium_total: 0,
          medium_correct_estimate: 0,
          medium_weighted_avg_time_sec: 0,
          easy_total: 0,
          easy_correct_estimate: 0,
          easy_weighted_avg_time_sec: 0,
        });
      }

      const group = groups.get(key);
      const total = Number(row.total_questions || 0);
      const correct = Number(row.correct_count || 0);
      const incorrect = Number(row.incorrect_count || 0);
      const avgTime = Number(row.avg_time_sec || 0);
      const hardTotal = Number(row.hard_total || 0);
      const hardAccuracyPct = Number(row.hard_accuracy_pct || 0);
      const hardAvgTime = Number(row.hard_avg_time_sec || 0);
      const mediumTotal = Number(row.medium_total || 0);
      const mediumAccuracyPct = Number(row.medium_accuracy_pct || 0);
      const mediumAvgTime = Number(row.medium_avg_time_sec || 0);
      const easyTotal = Number(row.easy_total || 0);
      const easyAccuracyPct = Number(row.easy_accuracy_pct || 0);
      const easyAvgTime = Number(row.easy_avg_time_sec || 0);

      group.total_questions += total;
      group.correct_count += correct;
      group.incorrect_count += incorrect;
      group.weighted_avg_time_sec += avgTime * total;

      group.hard_total += hardTotal;
      group.hard_correct_estimate += (hardAccuracyPct / 100) * hardTotal;
      group.hard_weighted_avg_time_sec += hardAvgTime * hardTotal;

      group.medium_total += mediumTotal;
      group.medium_correct_estimate += (mediumAccuracyPct / 100) * mediumTotal;
      group.medium_weighted_avg_time_sec += mediumAvgTime * mediumTotal;

      group.easy_total += easyTotal;
      group.easy_correct_estimate += (easyAccuracyPct / 100) * easyTotal;
      group.easy_weighted_avg_time_sec += easyAvgTime * easyTotal;
    }

    const order = ['Verbal', 'Quant', 'Data Insights', 'Other'];
    return Array.from(groups.values())
      .map((group) => ({
        subject_family: group.subject_family,
        subject_sub: group.subject_sub,
        total_questions: group.total_questions,
        correct_count: group.correct_count,
        incorrect_count: group.incorrect_count,
        accuracy_pct: group.total_questions ? Number(((group.correct_count * 100) / group.total_questions).toFixed(1)) : 0,
        avg_time_sec: group.total_questions ? Math.round(group.weighted_avg_time_sec / group.total_questions) : 0,
        hard_total: group.hard_total,
        hard_accuracy_pct: group.hard_total ? Number(((group.hard_correct_estimate * 100) / group.hard_total).toFixed(1)) : 0,
        hard_avg_time_sec: group.hard_total ? Math.round(group.hard_weighted_avg_time_sec / group.hard_total) : 0,
        medium_total: group.medium_total,
        medium_accuracy_pct: group.medium_total ? Number(((group.medium_correct_estimate * 100) / group.medium_total).toFixed(1)) : 0,
        medium_avg_time_sec: group.medium_total ? Math.round(group.medium_weighted_avg_time_sec / group.medium_total) : 0,
        easy_total: group.easy_total,
        easy_accuracy_pct: group.easy_total ? Number(((group.easy_correct_estimate * 100) / group.easy_total).toFixed(1)) : 0,
        easy_avg_time_sec: group.easy_total ? Math.round(group.easy_weighted_avg_time_sec / group.easy_total) : 0,
      }))
      .sort((a, b) => {
        const familyDiff = order.indexOf(a.subject_family) - order.indexOf(b.subject_family);
        if (familyDiff !== 0) return familyDiff;
        return String(a.subject_sub || '').localeCompare(String(b.subject_sub || ''));
      });
  }, [patterns.categoryBreakdown]);
  const subcategoryRowsByCategory = useMemo(() => {
    const groups = new Map();
    for (const row of patterns.subtopicBreakdown || []) {
      const subjectFamily = normalizeSubjectFamilyDisplay(row.subject_family);
      const category = normalizedCategoryCode(row);
      const key = `${subjectFamily}|${category}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return groups;
  }, [patterns.subtopicBreakdown]);

  const sortedCategoryRows = useMemo(() => {
    const rows = [...categoryRows];
    const { key, order } = categoryBreakdownSort;

    rows.sort((a, b) => {
      let cmp = 0;
      switch (key) {
        case 'subject_family':
          cmp = compareBasicSortValues(normalizeSubjectFamilyDisplay(a.subject_family), normalizeSubjectFamilyDisplay(b.subject_family), order);
          break;
        case 'category':
          cmp = compareBasicSortValues(normalizedCategoryCode(a), normalizedCategoryCode(b), order);
          break;
        case 'total_questions':
        case 'correct_count':
        case 'incorrect_count':
        case 'accuracy_pct':
        case 'avg_time_sec':
          cmp = compareBasicSortValues(a?.[key] || 0, b?.[key] || 0, order);
          break;
        case 'hard':
        case 'medium':
        case 'easy':
          cmp = compareDifficultyBucket(a, b, key, order);
          break;
        case 'status':
          cmp = compareBasicSortValues(statusLabelFromAccuracy(a.accuracy_pct), statusLabelFromAccuracy(b.accuracy_pct), order);
          break;
        default:
          cmp = 0;
      }

      if (cmp !== 0) return cmp;
      const familyCmp = compareBasicSortValues(normalizeSubjectFamilyDisplay(a.subject_family), normalizeSubjectFamilyDisplay(b.subject_family), 'asc');
      if (familyCmp !== 0) return familyCmp;
      return compareBasicSortValues(normalizedCategoryCode(a), normalizedCategoryCode(b), 'asc');
    });

    return rows;
  }, [categoryRows, categoryBreakdownSort]);

  const sortedSubcategoryRowsByCategory = useMemo(() => {
    const groups = new Map();
    const { key, order } = subcategoryBreakdownSort;

    for (const [groupKey, rows] of subcategoryRowsByCategory.entries()) {
      const sortedRows = [...rows].sort((a, b) => {
        let cmp = 0;
        switch (key) {
          case 'subtopic':
            cmp = compareBasicSortValues(a?.subtopic || '', b?.subtopic || '', order);
            break;
          case 'total_questions':
          case 'correct_count':
          case 'incorrect_count':
          case 'accuracy_pct':
          case 'avg_time_sec':
            cmp = compareBasicSortValues(a?.[key] || 0, b?.[key] || 0, order);
            break;
          case 'hard':
          case 'medium':
          case 'easy':
            cmp = compareDifficultyBucket(a, b, key, order);
            break;
          case 'status':
            cmp = compareBasicSortValues(statusLabelFromAccuracy(a.accuracy_pct), statusLabelFromAccuracy(b.accuracy_pct), order);
            break;
          default:
            cmp = 0;
        }

        if (cmp !== 0) return cmp;
        return compareBasicSortValues(a?.subtopic || '', b?.subtopic || '', 'asc');
      });

      groups.set(groupKey, sortedRows);
    }

    return groups;
  }, [subcategoryRowsByCategory, subcategoryBreakdownSort]);

  const overallMastery = useMemo(() => {
    const total = subjectCards.reduce((sum, card) => sum + Number(card.total || 0), 0);
    const correct = subjectCards.reduce((sum, card) => sum + Number(card.correct || 0), 0);
    if (!total) return 0;
    return Number(((correct * 100) / total).toFixed(1));
  }, [subjectCards]);

  const wrongCategoryRows = useMemo(() => {
    const counts = new Map();
    for (const row of sessionAnalysis.data?.slowWrongQuestions || []) {
      if (Number(row?.correct) === 1) continue;
      const category = normalizedCategoryCode(row);
      counts.set(category, (counts.get(category) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([category, mistakes]) => ({ category, mistakes }))
      .sort((a, b) => b.mistakes - a.mistakes || a.category.localeCompare(b.category));
  }, [sessionAnalysis.data?.slowWrongQuestions]);

  const totalWrongCategoryMistakes = useMemo(
    () => wrongCategoryRows.reduce((sum, row) => sum + Number(row?.mistakes || 0), 0),
    [wrongCategoryRows]
  );

  const isOpeSession = useMemo(() => {
    const src = String(sessionAnalysis.data?.session?.source || '');
    return /official\s*practice\s*exam/i.test(src);
  }, [sessionAnalysis.data?.session?.source]);

  // Pacing thresholds for OPE pacing diagnostic.
  // GMAT pacing rule of thumb: ~2:00/Q on Quant+Verbal, ~2:30/Q on DI.
  // <60s wrong = "rushed"; >180s wrong = "stuck"; >180s correct = "burned".
  const opeAnalysis = useMemo(() => {
    if (!isOpeSession) return null;
    const session = sessionAnalysis.data?.session;
    const allQ = sessionAnalysis.data?.slowWrongQuestions || [];
    const examMatch = String(session?.source || '').match(/practice\s*exam\s*(\d+)/i);
    const examNumber = examMatch ? Number(examMatch[1]) : null;

    const sectionDefs = [
      { code: 'Q', name: 'Quant', scoreField: 'quant_score' },
      { code: 'V', name: 'Verbal', scoreField: 'verbal_score' },
      { code: 'DI', name: 'Data Insights', scoreField: 'di_score' },
    ];
    const sections = sectionDefs
      .map(({ code, name, scoreField }) => {
        const rows = allQ.filter((r) => r.subject_code === code);
        const total = rows.length;
        const correct = rows.filter((r) => Number(r.correct) === 1).length;
        const wrong = total - correct;
        const totalTime = rows.reduce((acc, r) => acc + (Number(r.time_sec) || 0), 0);
        const avgTime = total ? totalTime / total : 0;
        const accuracy = total ? (100 * correct) / total : null;
        const rawScore = Number(session?.[scoreField]);
        const score = Number.isFinite(rawScore) && rawScore >= 60 && rawScore <= 90 ? rawScore : null;
        const rushedWrong = rows.filter((r) => Number(r.correct) === 0 && Number(r.time_sec) > 0 && Number(r.time_sec) < 60).length;
        const stuckWrong = rows.filter((r) => Number(r.correct) === 0 && Number(r.time_sec) > 180).length;
        const burnedCorrect = rows.filter((r) => Number(r.correct) === 1 && Number(r.time_sec) > 180).length;
        return { code, name, total, correct, wrong, totalTime, avgTime, accuracy, score, rushedWrong, stuckWrong, burnedCorrect };
      })
      .filter((s) => s.total > 0);

    const suggestions = [];
    // Weakest section is keyed off the scaled score (60-90) when available,
    // falling back to accuracy when scores haven't been scraped yet. Thresholds:
    // < 75 is a real weakness (high priority); < 78 needs work (med priority).
    const scored = sections.filter((s) => s.score != null);
    if (scored.length) {
      const weakest = [...scored].sort((a, b) => a.score - b.score)[0];
      if (weakest.score < 78) {
        const weakestRows = allQ.filter((r) => r.subject_code === weakest.code && Number(r.correct) === 0);
        const topicCounts = new Map();
        for (const r of weakestRows) {
          const t = String(r.topic || '').trim() || 'Unknown';
          topicCounts.set(t, (topicCounts.get(t) || 0) + 1);
        }
        const worstTopic = Array.from(topicCounts.entries()).sort((a, b) => b[1] - a[1])[0];
        const isWeakness = weakest.score < 75;
        suggestions.push({
          priority: isWeakness ? 'high' : 'med',
          title: isWeakness
            ? `${weakest.name} is your weakest section`
            : `${weakest.name} needs work`,
          body: worstTopic
            ? `Scaled score ${weakest.score}. ${worstTopic[0]} drove ${worstTopic[1]} mistake${worstTopic[1] === 1 ? '' : 's'} — drill that subcategory next.`
            : `Scaled score ${weakest.score}. Review every miss in this section before your next mock.`,
        });
      }
    } else {
      const ranked = sections.filter((s) => s.accuracy != null).sort((a, b) => a.accuracy - b.accuracy);
      const weakest = ranked[0];
      if (weakest && weakest.accuracy < 75) {
        const weakestRows = allQ.filter((r) => r.subject_code === weakest.code && Number(r.correct) === 0);
        const topicCounts = new Map();
        for (const r of weakestRows) {
          const t = String(r.topic || '').trim() || 'Unknown';
          topicCounts.set(t, (topicCounts.get(t) || 0) + 1);
        }
        const worstTopic = Array.from(topicCounts.entries()).sort((a, b) => b[1] - a[1])[0];
        suggestions.push({
          priority: 'high',
          title: `${weakest.name} is your weakest section`,
          body: worstTopic
            ? `Accuracy ${weakest.accuracy.toFixed(1)}%. ${worstTopic[0]} drove ${worstTopic[1]} mistake${worstTopic[1] === 1 ? '' : 's'} — drill that subcategory next.`
            : `Accuracy ${weakest.accuracy.toFixed(1)}%. Review every miss in this section before your next mock.`,
        });
      }
    }

    const totalRushed = sections.reduce((acc, s) => acc + s.rushedWrong, 0);
    const totalStuck = sections.reduce((acc, s) => acc + s.stuckWrong, 0);
    if (totalRushed >= 3) {
      suggestions.push({
        priority: 'med',
        title: 'Rushed-and-wrong pattern',
        body: `${totalRushed} answered in under 60s came back wrong. Slow the first 30s and re-read the prompt before committing.`,
      });
    }
    if (totalStuck >= 3) {
      suggestions.push({
        priority: 'med',
        title: 'Stuck-and-wrong pattern',
        body: `${totalStuck} ran over 3:00 and still missed. Practice cut-loss decisions around the 2:30 mark.`,
      });
    }

    const mistakeCounts = new Map();
    for (const r of allQ) {
      if (Number(r.correct) === 1) continue;
      const tags = String(r.mistake_type || '').split(',').map((t) => t.trim()).filter(Boolean);
      for (const t of tags) mistakeCounts.set(t, (mistakeCounts.get(t) || 0) + 1);
    }
    const topMistake = Array.from(mistakeCounts.entries()).sort((a, b) => b[1] - a[1])[0];
    if (topMistake && topMistake[1] >= 2) {
      suggestions.push({
        priority: 'low',
        title: `Recurring mistake: ${topMistake[0]}`,
        body: `Tagged ${topMistake[1]} times across this exam. Pattern-train before the next practice block.`,
      });
    }

    const completion = Number(session?.attempt_total || 0) / Number(session?.total_q_api || session?.attempt_total || 1);
    if (completion < 0.95 && Number(session?.total_q_api || 0) > 0) {
      const unanswered = Number(session?.total_q_api || 0) - Number(session?.attempt_total || 0);
      suggestions.push({
        priority: 'high',
        title: 'Section ran out of time',
        body: `${unanswered} question${unanswered === 1 ? '' : 's'} unanswered. Build a timing plan that reserves a guess for the last 90 seconds.`,
      });
    }

    return { examNumber, sections, suggestions };
  }, [isOpeSession, sessionAnalysis.data]);

  // Distinct subjects present in this session's questions, used to populate the
  // subject filter dropdown (only offer subjects that actually appear, with counts).
  const sessionAnalysisSubjectOptions = useMemo(() => {
    const counts = new Map();
    for (const row of sessionAnalysis.data?.slowWrongQuestions || []) {
      const code = normalizedSubjectCode(row);
      if (!code || code === '-') continue;
      counts.set(code, (counts.get(code) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([code, count]) => ({ code, label: normalizeSubjectFamilyDisplay(code), count }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [sessionAnalysis.data?.slowWrongQuestions]);

  // Distinct categories (PS/CR/RC/DS/MSR/TA/GI/TPA) present, for the category filter.
  const sessionAnalysisCategoryOptions = useMemo(() => {
    const counts = new Map();
    for (const row of sessionAnalysis.data?.slowWrongQuestions || []) {
      const code = normalizedCategoryCode(row);
      if (!code || code === '-') continue;
      counts.set(code, (counts.get(code) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [sessionAnalysis.data?.slowWrongQuestions]);

  // Correct/wrong tallies, so the result filter only appears when both exist.
  const sessionAnalysisResultCounts = useMemo(() => {
    let correct = 0;
    let wrong = 0;
    for (const row of sessionAnalysis.data?.slowWrongQuestions || []) {
      if (Number(row?.correct) === 1) correct += 1;
      else wrong += 1;
    }
    return { correct, wrong };
  }, [sessionAnalysis.data?.slowWrongQuestions]);

  const sortedSessionAnalysisWrongQuestions = useMemo(() => {
    let rows = [...(sessionAnalysis.data?.slowWrongQuestions || [])];
    if (sessionAnalysisSubjectFilter) {
      rows = rows.filter((row) => normalizedSubjectCode(row) === sessionAnalysisSubjectFilter);
    }
    if (sessionAnalysisCategoryFilter) {
      rows = rows.filter((row) => normalizedCategoryCode(row) === sessionAnalysisCategoryFilter);
    }
    if (sessionAnalysisResultFilter) {
      const wantCorrect = sessionAnalysisResultFilter === 'correct' ? 1 : 0;
      rows = rows.filter((row) => (Number(row?.correct) === 1 ? 1 : 0) === wantCorrect);
    }
    const { key, order } = sessionAnalysisSort;
    const difficultyRank = {
      unknown: 0,
      easy: 1,
      medium: 2,
      hard: 3,
    };

    rows.sort((a, b) => {
      let valA = a?.[key];
      let valB = b?.[key];

      if (key === 'difficulty') {
        valA = difficultyRank[String(valA || 'unknown').toLowerCase()] || 0;
        valB = difficultyRank[String(valB || 'unknown').toLowerCase()] || 0;
      } else if (key === 'correct') {
        valA = Number(valA) === 1 ? 1 : 0;
        valB = Number(valB) === 1 ? 1 : 0;
      } else if (key === 'time_sec') {
        valA = Number.isFinite(Number(valA)) ? Number(valA) : -1;
        valB = Number.isFinite(Number(valB)) ? Number(valB) : -1;
      } else if (key === 'q_code') {
        valA = String(valA || '');
        valB = String(valB || '');
      } else {
        valA = String(valA || '').toLowerCase();
        valB = String(valB || '').toLowerCase();
      }

      if (typeof valA === 'number' && typeof valB === 'number') {
        if (valA < valB) return order === 'asc' ? -1 : 1;
        if (valA > valB) return order === 'asc' ? 1 : -1;
      } else {
        const cmp = String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
        if (cmp !== 0) return order === 'asc' ? cmp : -cmp;
      }

      return (Number(a?.id || 0) - Number(b?.id || 0)) * (order === 'asc' ? 1 : -1);
    });

    return rows;
  }, [sessionAnalysis.data?.slowWrongQuestions, sessionAnalysisSort, sessionAnalysisSubjectFilter, sessionAnalysisCategoryFilter, sessionAnalysisResultFilter]);

  const questionReviewNav = useMemo(() => {
    const empty = { index: -1, total: 0, prev: null, next: null };
    if (!questionReview.open || !questionReview.row) return empty;
    const list = sortedSessionAnalysisWrongQuestions || [];
    if (!list.length) return empty;
    const currentId = questionReview.row.id;
    const index = list.findIndex((r) => r?.id === currentId);
    if (index < 0) return empty;
    return {
      index,
      total: list.length,
      prev: index > 0 ? list[index - 1] : null,
      next: index < list.length - 1 ? list[index + 1] : null,
    };
  }, [questionReview.open, questionReview.row, sortedSessionAnalysisWrongQuestions]);

  useEffect(() => {
    if (!questionReview.open || annotation.open) return undefined;
    function handleArrows(event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const tag = String(event.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || event.target?.isContentEditable) return;
      if (event.key === 'ArrowRight' && questionReviewNav.next) {
        event.preventDefault();
        handleOpenQuestionReview(questionReviewNav.next);
      } else if (event.key === 'ArrowLeft' && questionReviewNav.prev) {
        event.preventDefault();
        handleOpenQuestionReview(questionReviewNav.prev);
      }
    }
    document.addEventListener('keydown', handleArrows);
    return () => document.removeEventListener('keydown', handleArrows);
  }, [questionReview.open, annotation.open, questionReviewNav]);

  const processedSessions = useMemo(() => {
    let list = sessions.map((session) => ({
      ...session,
      question_count_display: getSessionQuestionCount(session),
      answered_count_display: getSessionAnsweredCount(session),
      unanswered_count_display: getSessionUnansweredCount(session),
      error_count_display: getSessionErrorCount(session),
      answered_accuracy_pct: getSessionAnsweredAccuracy(session),
      completion_rate_pct: getSessionCompletionRate(session),
    }));

    // Subject + date filters are applied server-side via /api/sessions params,
    // so the slice we get back is already filtered. Only local sort below.

    // Sort
    const { key, order } = sessionSort;
    list.sort((a, b) => {
      let valA = a[key] ?? '';
      let valB = b[key] ?? '';

      if (key === 'session_date') {
        // session_date is date-only (LSAT rows carry a full timestamp). Tie-break
        // same-day rows by created_at (record time) then id below, so the table
        // sorts by date AND time, not date alone.
        valA = new Date(valA).getTime();
        valB = new Date(valB).getTime();
      } else if (typeof valA === 'string') {
        valA = valA.toLowerCase();
        valB = valB.toLowerCase();
      }

      if (valA < valB) return order === 'asc' ? -1 : 1;
      if (valA > valB) return order === 'asc' ? 1 : -1;

      // Deterministic tie-break: most-recently-recorded first, then id.
      const tA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tB = b.created_at ? new Date(b.created_at).getTime() : 0;
      if (tA !== tB) return order === 'asc' ? tA - tB : tB - tA;
      const idA = Number(a.id) || 0;
      const idB = Number(b.id) || 0;
      return order === 'asc' ? idA - idB : idB - idA;
    });

    return list;
  }, [sessions, sessionSort]);

  function handleSessionSort(key) {
    setSessionSort((prev) => ({
      key,
      order: prev.key === key && prev.order === 'desc' ? 'asc' : 'desc',
    }));
  }

  function handleSessionAnalysisSort(key) {
    setSessionAnalysisSort((prev) => ({
      key,
      order: prev.key === key && prev.order === 'desc' ? 'asc' : 'desc',
    }));
  }

  function handleErrorSort(key) {
    const newSort = {
      key,
      order: errorSort.key === key && errorSort.order === 'desc' ? 'asc' : 'desc',
    };
    setErrorSort(newSort);
    loadErrors(1, selectedRunId, filters, newSort);
  }

  function handleCategoryBreakdownSort(key) {
    setCategoryBreakdownSort((prev) => ({
      key,
      order: prev.key === key && prev.order === 'desc' ? 'asc' : 'desc',
    }));
  }

  function handleSubcategoryBreakdownSort(key) {
    setSubcategoryBreakdownSort((prev) => ({
      key,
      order: prev.key === key && prev.order === 'desc' ? 'asc' : 'desc',
    }));
  }

  function sortIndicator(sortState, key) {
    return sortState.key === key ? (sortState.order === 'asc' ? '↑' : '↓') : '';
  }

  function compareBasicSortValues(valA, valB, order = 'asc') {
    const bothNumbers = Number.isFinite(Number(valA)) && Number.isFinite(Number(valB));
    if (bothNumbers) {
      const numA = Number(valA);
      const numB = Number(valB);
      if (numA < numB) return order === 'asc' ? -1 : 1;
      if (numA > numB) return order === 'asc' ? 1 : -1;
      return 0;
    }

    const cmp = String(valA ?? '').localeCompare(String(valB ?? ''), undefined, { numeric: true, sensitivity: 'base' });
    return order === 'asc' ? cmp : -cmp;
  }

  function compareDifficultyBucket(a, b, bucket, order = 'asc') {
    const totalCmp = compareBasicSortValues(a?.[`${bucket}_total`] || 0, b?.[`${bucket}_total`] || 0, order);
    if (totalCmp !== 0) return totalCmp;

    const accuracyCmp = compareBasicSortValues(a?.[`${bucket}_accuracy_pct`] || 0, b?.[`${bucket}_accuracy_pct`] || 0, order);
    if (accuracyCmp !== 0) return accuracyCmp;

    return compareBasicSortValues(a?.[`${bucket}_avg_time_sec`] || 0, b?.[`${bucket}_avg_time_sec`] || 0, order);
  }

  function statusLabelFromAccuracy(accuracyPct) {
    const score = Number(accuracyPct || 0);
    if (score >= 80) return 'Strong';
    if (score >= 65) return 'Improving';
    return 'Needs Focus';
  }

  function statusVariantFromAccuracy(accuracyPct) {
    const label = statusLabelFromAccuracy(accuracyPct);
    if (label === 'Strong') return 'success';
    if (label === 'Improving') return 'info';
    return 'warning';
  }

  function categoryDrilldownKey(row) {
    return `${normalizeSubjectFamilyDisplay(row?.subject_family)}|${normalizedCategoryCode(row)}`;
  }

  function toggleCategoryDrilldown(row) {
    const nextKey = categoryDrilldownKey(row);
    setExpandedCategoryKey((prev) => (prev === nextKey ? '' : nextKey));
  }

  function handleClosePatternDrilldown() {
    setPatternDrilldown({
      open: false,
      loading: false,
      error: '',
      title: '',
      criteria: { subject: '', difficulty: '', topic: '', confidence: '' },
      rows: [],
    });
  }

  async function handleApplyPatternToErrorLog() {
    const merged = { ...filters, ...patternDrilldown.criteria };
    setFilters(merged);
    try {
      await loadErrorsByFilters(merged);
      handleClosePatternDrilldown();
    } catch (error) {
      setStatus({ message: error.message, isError: true });
    }
  }

  async function handleOpenSessionAnalysis(row) {
    if (!row?.id) return;
    setSessionAnalysisSubjectFilter('');
    setSessionAnalysisCategoryFilter('');
    setSessionAnalysisResultFilter('');
    setSessionAnalysis({
      open: true,
      loading: true,
      error: '',
      data: null,
    });

    try {
      const result = await fetchJson(`/api/sessions/${row.id}/analysis`);
      const analysis = result.analysis || null;
      const nextAnalysis = analysis
        ? {
            ...analysis,
            slowWrongQuestions: Array.isArray(analysis.slowWrongQuestions)
              ? analysis.slowWrongQuestions
                  .map((item) => ({
                    ...item,
                    session_external_id: item?.session_external_id || analysis?.session?.session_external_id || '',
                    session_date: item?.session_date || analysis?.session?.session_date || '',
                    subject: item?.subject || analysis?.session?.subject || '',
                  }))
              : [],
          }
        : null;
      setSessionAnalysis({
        open: true,
        loading: false,
        error: '',
        data: nextAnalysis,
      });
    } catch (error) {
      setSessionAnalysis({
        open: true,
        loading: false,
        error: error.message,
        data: null,
      });
    }
  }

  function handleCloseSessionAnalysis() {
    setSessionAnalysis({
      open: false,
      loading: false,
      error: '',
      data: null,
    });
    setSessionAnalysisSubjectFilter('');
    setSessionAnalysisCategoryFilter('');
    setSessionAnalysisResultFilter('');
    // Drop any prior enrich outcome / pending confirm so neither resurfaces on
    // the next session opened (the status block renders on lastEnrichResult alone).
    setLastEnrichResult(null);
    setEnrichConfirmId(null);
  }

  function handleOpenAnnotation(row) {
    if (!row?.id) return;
    setTagSearch('');
    setAnnotation({
      open: true,
      saving: false,
      error: '',
      row,
      mistakeTags: parseMistakeTags(row.mistake_type),
      notes: row.notes || '',
    });
  }

  function handleCloseAnnotation() {
    setTagSearch('');
    setAnnotation({
      open: false,
      saving: false,
      error: '',
      row: null,
      mistakeTags: [],
      notes: '',
    });
  }

  function handleToggleMistakeTag(tag) {
    setAnnotation((prev) => ({
      ...prev,
      mistakeTags: prev.mistakeTags.includes(tag)
        ? prev.mistakeTags.filter((t) => t !== tag)
        : [...prev.mistakeTags, tag],
    }));
  }

  function handleOpenQuestionReview(row) {
    if (!row) return;
    setQuestionReview({
      open: true,
      row: {
        ...row,
        answer_choices: parseAnswerChoices(row?.answer_choices),
        response_details: parseResponseDetails(row?.response_details),
      },
    });
  }

  function handleCloseQuestionReview() {
    setQuestionReview({
      open: false,
      row: null,
    });
  }

  function applyAnnotationLocally(updated) {
    if (!updated?.id) return;
    setErrors((prev) =>
      prev.map((row) =>
        row.id === updated.id
          ? { ...row, mistake_type: updated.mistake_type || '', notes: updated.notes || '' }
          : row
      )
    );

    setPatternDrilldown((prev) => ({
      ...prev,
      rows: (prev.rows || []).map((row) =>
        row.id === updated.id
          ? { ...row, mistake_type: updated.mistake_type || '', notes: updated.notes || '' }
          : row
      ),
    }));

    setSessionAnalysis((prev) => {
      if (!prev?.data?.slowWrongQuestions) return prev;
      return {
        ...prev,
        data: {
          ...prev.data,
          slowWrongQuestions: prev.data.slowWrongQuestions.map((row) =>
            row.id === updated.id
              ? { ...row, mistake_type: updated.mistake_type || '', notes: updated.notes || '' }
              : row
          ),
        },
      };
    });

    setQuestionReview((prev) => {
      if (!prev?.row || prev.row.id !== updated.id) return prev;
      return {
        ...prev,
        row: { ...prev.row, mistake_type: updated.mistake_type || '', notes: updated.notes || '' },
      };
    });
  }

  async function handleSaveAnnotation() {
    if (!annotation.row?.id || annotation.saving) return;
    setAnnotation((prev) => ({ ...prev, saving: true, error: '' }));
    try {
      const result = await fetchJson(`/api/errors/${annotation.row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mistakeType: annotation.mistakeTags.length ? JSON.stringify(annotation.mistakeTags) : '',
          notes: annotation.notes,
        }),
      });
      applyAnnotationLocally(result.error);
      handleCloseAnnotation();
      setStatus({ message: `Saved notes for Q ${annotation.row.q_code || annotation.row.id}.`, isError: false });
    } catch (error) {
      setAnnotation((prev) => ({ ...prev, saving: false, error: error.message }));
    }
  }

  function canonicalQuestionUrl(row) {
    const rawUrl = String(row?.question_url || '').trim();
    const sessionId = String(row?.session_external_id || '').trim();
    const catId = String(row?.cat_id || '').trim();
    const qId = String(row?.q_id || '').trim();
    const sourceLabel = String(row?.source || '').trim().toLowerCase();
    const reviewHash = `#custom-quiz/${sessionId}/review/categories/${catId}/${qId}`;

    if (sessionId && catId && qId) {
      if (rawUrl) {
        try {
          const parsed = new URL(rawUrl);
          if (parsed.pathname && parsed.pathname !== '/') {
            return `${parsed.origin}${parsed.pathname}${reviewHash}`;
          }
          const sourceAppUrl = sourceAppUrlByLabel.get(sourceLabel);
          if (sourceAppUrl) {
            const sourceParsed = new URL(sourceAppUrl);
            return `${sourceParsed.origin}${sourceParsed.pathname}${reviewHash}`;
          }
          return `${parsed.origin}${parsed.pathname}${reviewHash}`;
        } catch (_error) {
          const originPath = rawUrl.replace(/[#?].*$/, '');
          if (originPath) return `${originPath}${reviewHash}`;
        }
      }
      const sourceAppUrl = sourceAppUrlByLabel.get(sourceLabel);
      if (sourceAppUrl) {
        try {
          const parsed = new URL(sourceAppUrl);
          return `${parsed.origin}${parsed.pathname}${reviewHash}`;
        } catch (_error) {
          // Fallback below.
        }
      }
      return `https://gmatofficialpractice.mba.com/${reviewHash}`;
    }
    return rawUrl;
  }

  function questionOpenKey(row, scope = '') {
    if (!row) return scope || 'unknown';
    if (row.id) return `${scope}-${row.id}`;
    return `${scope}-${row.session_external_id || 'session'}-${row.q_code || 'q'}-${row.time_sec || 't'}`;
  }

  async function handleOpenQuestionInGmat(row, scope = '') {
    const questionUrl = canonicalQuestionUrl(row);
    if (!questionUrl) return;
    const key = questionOpenKey(row, scope);
    setOpeningQuestionKey(key);
    try {
      const result = await fetchJson('/api/open-question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionUrl,
          cdpUrl: DEFAULT_CDP_URL,
          source: row?.source || '',
        }),
      });
      setStatus({ message: `Opened question in Chrome CDP: ${result.openedUrl || questionUrl}`, isError: false });
    } catch (error) {
      setStatus({ message: formatRequestError(error), isError: true });
    } finally {
      setOpeningQuestionKey((prev) => (prev === key ? '' : prev));
    }
  }

  function handleQuestionAction(row, scope = '') {
    if (hasScrapedQuestionContent(row)) {
      handleOpenQuestionReview(row);
      return;
    }
    handleOpenQuestionInGmat(row, scope);
  }

  async function handleGenerateAiReview() {
    if (isGeneratingAiReview) return;
    setIsGeneratingAiReview(true);
    try {
      const result = await fetchJson('/api/ai/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: aiRunId,
          focus: aiFocus,
        }),
      });

      const reviewText = String(result.review || '').trim();
      setAiReview(reviewText || 'No review generated.');
      setStatus({ message: `AI review ready for ${aiScopeLabel}.`, isError: false });
    } catch (error) {
      setStatus({ message: formatRequestError(error), isError: true });
    } finally {
      setIsGeneratingAiReview(false);
    }
  }

  function handleResetAiChat() {
    startNewSession();
  }

  function handleAiComposerKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleAskAi();
    }
  }

  async function handleAskAi(questionOverride = '') {
    if (isAskingAi) return;
    const question = String(questionOverride || aiQuestion || '').trim();
    if (!question) return;

    const nextUserMessage = { role: 'user', content: question };
    setAiMessages((prev) => [...prev, nextUserMessage]);
    setAiQuestion('');
    setIsAskingAi(true);

    try {
      const result = await fetchJson('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: aiRunId,
          question,
          sessionId: chatSessionId,
        }),
      });

      // Store session ID from response (auto-created if none was sent)
      if (result.sessionId && result.sessionId !== chatSessionId) {
        setChatSessionId(result.sessionId);
        loadCoachSessions();
      }

      const answer = String(result.answer || '').trim() || 'No answer generated.';
      setAiMessages((prev) => [...prev, { role: 'assistant', content: answer }]);
    } catch (error) {
      setStatus({ message: formatRequestError(error), isError: true });
      setAiMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Error: ${formatRequestError(error)}`,
        },
      ]);
    } finally {
      setIsAskingAi(false);
    }
  }

  // True only on a genuinely empty database — drives the first-run welcome and
  // suppresses the four empty data sections. Runs are never filtered, so they
  // are the most reliable "has anything ever been scraped" signal. Computed
  // before the appMode early returns so the polling hook below stays
  // unconditional (rules-of-hooks).
  const hasEverScraped =
    runs.length > 0
    || (sessionPagination.total || 0) > 0
    || (errorPagination.total || 0) > 0;
  const isFirstRun = !isDashboardLoading && !bootError && !hasEverScraped;

  // Filter-aware empty states: "filtered to nothing" (offer Clear) vs
  // "no data yet" (offer Sync) read very differently to the user.
  const hasActiveErrorFilters = Boolean(
    filters.subject || filters.difficulty || filters.topic
    || filters.confidence || filters.search || filters.mistakeTag || filters.platform,
  );
  const hasActiveSessionFilters = Boolean(
    sessionPlatformFilter || sessionSubjectFilter
    || sessionDateRange.start || sessionDateRange.end,
  );
  function clearErrorFilters() {
    setFilters({ subject: '', difficulty: '', topic: '', confidence: '', search: '', mistakeTag: '', platform: '' });
  }
  function clearSessionFilters() {
    setSessionPlatformFilter('');
    setSessionSubjectFilter('');
    setSessionDateRange({ start: '', end: '' });
  }

  // Poll debug-Chrome status only while the first-run checklist is on screen so
  // its step dots stay live. Cheap HTTP probe; stops the moment data exists.
  useEffect(() => {
    if (!isFirstRun || appMode !== 'gmat') return undefined;
    checkCdpStatus();
    const id = setInterval(() => { checkCdpStatus(); }, 4000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFirstRun, appMode]);

  if (appMode === 'lsat') {
    return (
      <Suspense fallback={<RouteFallback />}>
        <LsatPractice onExit={() => { window.location.hash = ''; }} />
      </Suspense>
    );
  }
  if (appMode === 'study-plan') {
    return (
      <Suspense fallback={<RouteFallback />}>
        <StudyPlan onExit={() => { window.location.hash = ''; }} />
      </Suspense>
    );
  }

  return (
    <main className="page-shell">
      <header className="top-bar">
        <div className="top-bar-left">
          <h1 className="top-bar-title">GMAT Analytics</h1>
          {status.message && !bootError && (
            <span
              className={`top-bar-status${status.isError ? ' error' : ''}`}
              role={status.isError ? 'alert' : 'status'}
            >
              {status.message}
            </span>
          )}
        </div>
        <div className="top-bar-actions">
          <Button size="sm" type="button" onClick={() => setSyncCenterOpen(true)}>
            Sync Practice
          </Button>
          <Button variant="outline" size="sm" type="button" onClick={() => { window.location.hash = '#study-plan'; }}>
            Study Plan
          </Button>
          <Button variant="outline" size="sm" type="button" onClick={() => { window.location.hash = '#lsat'; }}>
            LSAT Practice
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a
              href="https://gmat.targettestprep.com/gmat_focus_score_chart_and_calculator"
              target="_blank"
              rel="noopener noreferrer"
            >
              Score Calculator
            </a>
          </Button>
        </div>
      </header>

      {bootError && (
        <div className="status error boot-error-banner" role="alert">
          <span className="boot-error-text">
            <strong>Couldn’t reach your data.</strong> {bootError.message}{' '}
            If the local API isn’t running, start it with <code>npm run dev:api</code>, then retry.
          </span>
          <Button variant="outline" size="sm" type="button" onClick={() => runBoot()}>
            Retry
          </Button>
        </div>
      )}

      {/* Section nav — hidden on first run when there is nothing to jump to */}
      {!isFirstRun && (
        <nav className="section-nav" aria-label="Jump to section">
          <a href="#today" className="section-nav-link">Today</a>
          <a href="#dashboard" className="section-nav-link">Dashboard</a>
          <a href="#categories" className="section-nav-link">Categories</a>
          <a href="#sessions" className="section-nav-link">Sessions</a>
          <a href="#errors" className="section-nav-link">Error Log</a>
        </nav>
      )}

      {/* Floating AI Coach FAB */}
      <button
        type="button"
        className={`coach-fab ${coachOpen ? 'coach-fab--open' : ''}`}
        onClick={() => setCoachOpen((v) => !v)}
        aria-label={coachOpen ? 'Close Coach' : 'Open Coach'}
      >
        {coachOpen ? (
          '\u2715'
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
          </svg>
        )}
      </button>

      {/* Coach floating panel */}
      <div className={`coach-panel ${coachOpen ? 'coach-panel--open' : ''}`} role="dialog" aria-label="Coach" aria-modal={coachOpen} inert={coachOpen ? undefined : ''}>
        <div className="coach-panel-header">
          <div className="coach-panel-title">
            <span className="coach-panel-badge">Coach</span>
            <span className="coach-panel-scope">{aiScopeLabel}</span>
          </div>
          <div className="coach-panel-actions">
            <button
              type="button"
              className="coach-sessions-toggle"
              onClick={() => { setShowSessionList((v) => !v); if (!showSessionList) loadCoachSessions(); }}
              aria-label="Session history"
              title="Session history"
            >
              {'\u2630'}
            </button>
            <button type="button" className="coach-panel-close" onClick={() => setCoachOpen(false)} aria-label="Close">
              {'\u2715'}
            </button>
          </div>
        </div>

        {showSessionList && (
          <div className="coach-session-list">
            <div className="coach-session-list-header">
              <strong>Sessions</strong>
              <button type="button" className="coach-new-session-btn" onClick={() => { startNewSession(); setShowSessionList(false); }}>
                + New Chat
              </button>
            </div>
            <div className="coach-session-list-items">
              {chatSessions.length === 0 && <p className="muted" style={{ padding: '8px 12px', fontSize: '0.8rem' }}>No sessions yet.</p>}
              {chatSessions.map((s) => (
                <div
                  key={s.id}
                  className={`coach-session-item ${s.id === chatSessionId ? 'coach-session-item--active' : ''}`}
                >
                  <button
                    type="button"
                    className="coach-session-item-btn"
                    onClick={() => handleSelectSession(s.id)}
                    title={s.title || 'Untitled session'}
                  >
                    <span className="coach-session-item-title">{s.title || 'Untitled session'}</span>
                    <span className="coach-session-item-meta">
                      {s.message_count || 0} msgs &middot; {s.updated_at ? new Date(s.updated_at + 'Z').toLocaleDateString() : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="coach-session-item-delete"
                    onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
                    aria-label="Delete session"
                    title="Delete session"
                  >
                    {'\u2715'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <nav className="coach-tabs">
          <button
            type="button"
            className={`coach-tab ${coachTab === 'chat' ? 'coach-tab--active' : ''}`}
            onClick={() => setCoachTab('chat')}
          >
            Chat
          </button>
          <button
            type="button"
            className={`coach-tab ${coachTab === 'review' ? 'coach-tab--active' : ''}`}
            onClick={() => setCoachTab('review')}
          >
            Review
          </button>
        </nav>

        <div className="coach-panel-body">
          {coachTab === 'chat' && (
            <>
              <div className="coach-chat-log" role="log" aria-live="polite">
                {aiMessages.map((message, idx) => (
                  <article key={`ai-${idx}`} className={`ai-message ${message.role === 'assistant' ? 'assistant' : 'user'}`}>
                    <strong>{message.role === 'assistant' ? 'Coach' : 'You'}</strong>
                    <p>{message.content}</p>
                  </article>
                ))}
                {isAskingAi && (
                  <article className="ai-message assistant typing">
                    <strong>Coach</strong>
                    <p>Thinking...</p>
                  </article>
                )}
                <div ref={aiChatEndRef} />
              </div>
              <div className="coach-quick-prompts">
                {AI_COACH_QUICK_PROMPTS.map((prompt) => (
                  <button key={prompt} type="button" className="ai-chip" onClick={() => handleAskAi(prompt)}>
                    {prompt}
                  </button>
                ))}
              </div>
            </>
          )}

          {coachTab === 'review' && (
            <div className="coach-review-body">
              <label>
                Review focus (optional)
                <Textarea
                  rows={2}
                  value={aiFocus}
                  placeholder="Example: Focus on Data Insights timing and low-confidence misses."
                  onChange={(event) => setAiFocus(event.target.value)}
                />
              </label>
              <Button type="button" className="btn-primary" onClick={handleGenerateAiReview} disabled={isGeneratingAiReview}>
                {isGeneratingAiReview ? 'Generating...' : 'Generate Review'}
              </Button>
              <div className="coach-review-output">
                {aiReview ? <pre>{aiReview}</pre> : <p className="muted">Generate a review to get personalized recommendations.</p>}
              </div>
            </div>
          )}
        </div>

        <div className="coach-panel-footer">
          {coachTab === 'chat' && (
            <div className="coach-composer">
              <Textarea
                rows={1}
                value={aiQuestion}
                placeholder="Ask your coach..."
                onChange={(event) => setAiQuestion(event.target.value)}
                onKeyDown={handleAiComposerKeyDown}
              />
              <button
                type="button"
                className="coach-send-btn"
                onClick={() => handleAskAi()}
                disabled={isAskingAi || !String(aiQuestion || '').trim()}
                aria-label="Send"
              >
                {isAskingAi ? '...' : '\u2191'}
              </button>
            </div>
          )}
          {coachTab === 'chat' && (
            <button type="button" className="coach-reset-link" onClick={handleResetAiChat}>
              New Chat
            </button>
          )}
        </div>
      </div>

      {coachOpen && <div className="coach-backdrop" onClick={() => setCoachOpen(false)} />}

      {isFirstRun && (
        <FirstRunWelcome
          cdpStatus={cdpStatus}
          sources={sources}
          selectedSource={selectedSource}
          onSelectSource={setSelectedSource}
          onOpenChrome={handleOpenChrome}
          isOpening={isOpening}
          onOpenProduct={handleOpenProduct}
          isOpeningProduct={isOpeningProduct}
          onScrape={handleScrape}
          isScraping={isScraping}
          onOpenSyncPanel={() => setSyncCenterOpen(true)}
          status={status}
        />
      )}

      {!isFirstRun && (
      <>
      <TodayPlan
        collapsed={collapsedSections.today}
        onToggleCollapse={() => toggleSection('today')}
      />

      <section id="dashboard" className="page-section topic-dashboard">
        <div className="section-header">
          <h2>Performance by Subject</h2>
          <button
            type="button"
            className="collapse-toggle"
            onClick={() => toggleSection('topicDashboard')}
            aria-expanded={!collapsedSections.topicDashboard}
            aria-label="Toggle Topic Dashboard section"
          >
            {collapsedSections.topicDashboard ? '\u002B' : '\u2212'}
          </button>
        </div>

        {!collapsedSections.topicDashboard && (
          <div className="dashboard-strip">
            {!subjectCards.length && <p className="muted">Sync a practice session to see subject performance here.</p>}
            {subjectCards.length > 0 && (
              <div className="dashboard-overall">
                <span className="dashboard-overall-label">Overall</span>
                <strong className="dashboard-overall-value">{formatPercent(overallMastery)}</strong>
              </div>
            )}
            {subjectCards.map((card) => {
              const accuracy = Math.max(0, Math.min(100, Number(card.accuracy_pct || 0)));
              return (
                <article key={card.family} className="dashboard-subject">
                  <div className="dashboard-subject-head">
                    <span className="dashboard-subject-name">{normalizeSubjectFamilyDisplay(card.family)}</span>
                    <strong className="dashboard-subject-pct">{formatPercent(accuracy)}</strong>
                  </div>
                  <div className="dashboard-subject-bar">
                    <div className="dashboard-subject-fill" style={{ width: `${accuracy}%` }} />
                  </div>
                  <span className="dashboard-subject-meta">{card.correct}/{card.total} · {formatDurationSeconds(card.avg_time_sec)} avg</span>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section id="categories" className="page-section">
        <div className="section-header">
          <h2>Category Breakdown</h2>
          <div className="section-header-actions">
            <button
              type="button"
              className={`difficulty-toggle ${showDifficultyCols ? 'difficulty-toggle--active' : ''}`}
              onClick={() => setShowDifficultyCols((v) => !v)}
              aria-pressed={showDifficultyCols}
            >
              {showDifficultyCols ? 'Hide' : 'Show'} Difficulty
            </button>
            <button
              type="button"
              className="collapse-toggle"
              onClick={() => toggleSection('categoryBreakdown')}
              aria-expanded={!collapsedSections.categoryBreakdown}
              aria-label="Toggle Category Detailed Breakdown section"
            >
              {collapsedSections.categoryBreakdown ? '\u002B' : '\u2212'}
            </button>
          </div>
        </div>
        {!collapsedSections.categoryBreakdown && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('subject_family')}>Subject {sortIndicator(categoryBreakdownSort, 'subject_family')}</th>
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('category')}>Category {sortIndicator(categoryBreakdownSort, 'category')}</th>
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('total_questions')}>Total {sortIndicator(categoryBreakdownSort, 'total_questions')}</th>
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('correct_count')}>Correct {sortIndicator(categoryBreakdownSort, 'correct_count')}</th>
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('incorrect_count')}>Wrong {sortIndicator(categoryBreakdownSort, 'incorrect_count')}</th>
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('accuracy_pct')}>Accuracy {sortIndicator(categoryBreakdownSort, 'accuracy_pct')}</th>
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('avg_time_sec')}>Avg Time {sortIndicator(categoryBreakdownSort, 'avg_time_sec')}</th>
                  {showDifficultyCols && <th className="sortable" onClick={() => handleCategoryBreakdownSort('hard')}>Hard {sortIndicator(categoryBreakdownSort, 'hard')}</th>}
                  {showDifficultyCols && <th className="sortable" onClick={() => handleCategoryBreakdownSort('medium')}>Medium {sortIndicator(categoryBreakdownSort, 'medium')}</th>}
                  {showDifficultyCols && <th className="sortable" onClick={() => handleCategoryBreakdownSort('easy')}>Easy {sortIndicator(categoryBreakdownSort, 'easy')}</th>}
                  <th className="sortable" onClick={() => handleCategoryBreakdownSort('status')}>Status {sortIndicator(categoryBreakdownSort, 'status')}</th>
                  <th>Drilldown</th>
                </tr>
              </thead>
              <tbody>
                {!categoryRows.length && (
                  <tr>
                    <td colSpan={showDifficultyCols ? 12 : 9}>Sync practice sessions to see category-level breakdowns.</td>
                  </tr>
                )}
                {sortedCategoryRows.map((row) => {
                  const statusLabel = statusLabelFromAccuracy(row.accuracy_pct);
                  const drilldownKey = categoryDrilldownKey(row);
                  const subcategoryRows = sortedSubcategoryRowsByCategory.get(drilldownKey) || [];
                  const isExpanded = expandedCategoryKey === drilldownKey;
                  return (
                    <Fragment key={drilldownKey}>
                      <tr>
                        <td className="section-col"><SubjectCell row={row} /></td>
                        <td>{formatMaybe(normalizedCategoryCode(row))}</td>
                        <td>{formatMaybe(row.total_questions)}</td>
                        <td>{formatMaybe(row.correct_count)}</td>
                        <td>{formatMaybe(row.incorrect_count)}</td>
                        <td>{formatPercent(row.accuracy_pct)}</td>
                        <td>{formatDurationSeconds(row.avg_time_sec)}</td>
                        {showDifficultyCols && <td>{formatDifficultyStat(row.hard_total, row.hard_accuracy_pct, row.hard_avg_time_sec)}</td>}
                        {showDifficultyCols && <td>{formatDifficultyStat(row.medium_total, row.medium_accuracy_pct, row.medium_avg_time_sec)}</td>}
                        {showDifficultyCols && <td>{formatDifficultyStat(row.easy_total, row.easy_accuracy_pct, row.easy_avg_time_sec)}</td>}
                        <td>
                          <Badge
                            variant={statusVariantFromAccuracy(row.accuracy_pct)}
                            className={`status-pill ${String(statusLabel).toLowerCase().replace(/\s+/g, '-')}`}
                          >
                            {statusLabel}
                          </Badge>
                        </td>
                        <td className="category-drilldown-cell">
                          {subcategoryRows.length ? (
                            <Button
                              variant="outline"
                              size="sm"
                              type="button"
                              className="readmore-btn"
                              onClick={() => toggleCategoryDrilldown(row)}
                            >
                              {isExpanded ? 'Hide' : `View ${subcategoryRows.length}`}
                            </Button>
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="category-drilldown-row">
                          <td colSpan={showDifficultyCols ? 12 : 9}>
                            <div className="subcategory-drilldown-panel">
                              <div className="subcategory-drilldown-head">
                                <strong>
                                  {formatMaybe(normalizeSubjectFamilyDisplay(row.subject_family))} / {formatMaybe(normalizedCategoryCode(row))}
                                </strong>
                                <span className="muted">{subcategoryRows.length} subcategories</span>
                              </div>
                              <div className="table-wrap subcategory-drilldown-wrap">
                                <table className="subcategory-drilldown-table">
                                  <thead>
                                    <tr>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('subtopic')}>
                                        Subcategory {sortIndicator(subcategoryBreakdownSort, 'subtopic')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('total_questions')}>
                                        Total {sortIndicator(subcategoryBreakdownSort, 'total_questions')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('correct_count')}>
                                        Correct {sortIndicator(subcategoryBreakdownSort, 'correct_count')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('incorrect_count')}>
                                        Incorrect {sortIndicator(subcategoryBreakdownSort, 'incorrect_count')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('accuracy_pct')}>
                                        Accuracy {sortIndicator(subcategoryBreakdownSort, 'accuracy_pct')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('avg_time_sec')}>
                                        Avg Time {sortIndicator(subcategoryBreakdownSort, 'avg_time_sec')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('hard')}>
                                        Hard (Q / Acc / Avg) {sortIndicator(subcategoryBreakdownSort, 'hard')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('medium')}>
                                        Medium (Q / Acc / Avg) {sortIndicator(subcategoryBreakdownSort, 'medium')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('easy')}>
                                        Easy (Q / Acc / Avg) {sortIndicator(subcategoryBreakdownSort, 'easy')}
                                      </th>
                                      <th className="sortable" onClick={() => handleSubcategoryBreakdownSort('status')}>
                                        Status {sortIndicator(subcategoryBreakdownSort, 'status')}
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {subcategoryRows.map((subRow) => {
                                      const subStatus = statusLabelFromAccuracy(subRow.accuracy_pct);
                                      return (
                                        <tr key={`${drilldownKey}|${subRow.subtopic}`}>
                                          <td>{formatMaybe(subRow.subtopic)}</td>
                                          <td>{formatMaybe(subRow.total_questions)}</td>
                                          <td>{formatMaybe(subRow.correct_count)}</td>
                                          <td>{formatMaybe(subRow.incorrect_count)}</td>
                                          <td>{formatPercent(subRow.accuracy_pct)}</td>
                                          <td>{formatDurationSeconds(subRow.avg_time_sec)}</td>
                                          <td>{formatDifficultyStat(subRow.hard_total, subRow.hard_accuracy_pct, subRow.hard_avg_time_sec)}</td>
                                          <td>{formatDifficultyStat(subRow.medium_total, subRow.medium_accuracy_pct, subRow.medium_avg_time_sec)}</td>
                                          <td>{formatDifficultyStat(subRow.easy_total, subRow.easy_accuracy_pct, subRow.easy_avg_time_sec)}</td>
                                          <td>
                                            <Badge
                                              variant={statusVariantFromAccuracy(subRow.accuracy_pct)}
                                              className={`status-pill ${String(subStatus).toLowerCase().replace(/\s+/g, '-')}`}
                                            >
                                              {subStatus}
                                            </Badge>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section id="sessions" className="page-section">
        <div className="section-header-filters">
          <h2>Performance by Session</h2>
          <div className="filter-row session-filters">
            <Select
              className="filter-select"
              value={sessionPlatformFilter}
              onChange={(e) => setSessionPlatformFilter(e.target.value)}
            >
              <option value="">All sources</option>
              <option value="starttest">Official Guide</option>
              <option value="ope-mock">Practice Exam</option>
              <option value="gmatclub">GMAT Club</option>
              <option value="gmatclub-cat">GMAT Club CAT</option>
              <option value="ttp">Target Test Prep</option>
              <option value="lsat">LSAT</option>
            </Select>
            <Select
              className="filter-select"
              value={sessionSubjectFilter}
              onChange={(e) => setSessionSubjectFilter(e.target.value)}
            >
              <option value="">All Subjects</option>
              <option value="Q">Quant</option>
              <option value="V">Verbal</option>
              <option value="DI">Data Insights</option>
              <option value="RC">RC (LSAT)</option>
              <option value="CR">CR (LSAT)</option>
            </Select>
            <div className="date-filter-group">
              <Input
                type="date"
                aria-label="Start date"
                placeholder="Start Date"
                max={sessionDateRange.end || undefined}
                value={sessionDateRange.start}
                onChange={(e) => setSessionDateRange((prev) => ({ ...prev, start: e.target.value }))}
              />
              <span>to</span>
              <Input
                type="date"
                aria-label="End date"
                placeholder="End Date"
                min={sessionDateRange.start || undefined}
                value={sessionDateRange.end}
                onChange={(e) => setSessionDateRange((prev) => ({ ...prev, end: e.target.value }))}
              />
            </div>
            {(sessionSubjectFilter || sessionPlatformFilter || sessionDateRange.start || sessionDateRange.end) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSessionSubjectFilter('');
                  setSessionPlatformFilter('');
                  setSessionDateRange({ start: '', end: '' });
                }}
              >
                Clear
              </Button>
            )}
            <button
              type="button"
              className={`difficulty-toggle ${showSessionDifficultyCols ? 'difficulty-toggle--active' : ''}`}
              onClick={() => setShowSessionDifficultyCols((v) => !v)}
              aria-pressed={showSessionDifficultyCols}
            >
              {showSessionDifficultyCols ? 'Hide' : 'Show'} Difficulty
            </button>
            <button
              type="button"
              className="collapse-toggle"
              onClick={() => toggleSection('performanceBySession')}
              aria-expanded={!collapsedSections.performanceBySession}
              aria-label="Toggle Performance by Session section"
            >
              {collapsedSections.performanceBySession ? '\u002B' : '\u2212'}
            </button>
          </div>
        </div>
        {!collapsedSections.performanceBySession && (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => handleSessionSort('session_date')}>Date {sortIndicator(sessionSort, 'session_date')}</th>
                    <th className="sortable" onClick={() => handleSessionSort('source')}>Source {sortIndicator(sessionSort, 'source')}</th>
                    <th className="sortable" onClick={() => handleSessionSort('subject')}>Subject {sortIndicator(sessionSort, 'subject')}</th>
                    <th className="sortable" onClick={() => handleSessionSort('question_count_display')}>Questions {sortIndicator(sessionSort, 'question_count_display')}</th>
                    <th className="sortable" onClick={() => handleSessionSort('error_count_display')}>Errors {sortIndicator(sessionSort, 'error_count_display')}</th>
                    <th className="sortable" onClick={() => handleSessionSort('answered_accuracy_pct')}>Accuracy % {sortIndicator(sessionSort, 'answered_accuracy_pct')}</th>
                    <th className="sortable" onClick={() => handleSessionSort('avg_time_sec')}>Avg Time {sortIndicator(sessionSort, 'avg_time_sec')}</th>
                    {showSessionDifficultyCols && <th title="Questions / Accuracy / Average time">Hard (Q / Acc / Avg)</th>}
                    {showSessionDifficultyCols && <th title="Questions / Accuracy / Average time">Medium (Q / Acc / Avg)</th>}
                    {showSessionDifficultyCols && <th title="Questions / Accuracy / Average time">Easy (Q / Acc / Avg)</th>}
                    <th>Session Analysis</th>
                  </tr>
                </thead>
                <tbody>
                  {processedSessions.length === 0 && (
                    <tr>
                      <td colSpan={showSessionDifficultyCols ? 11 : 8}>
                        {isDashboardLoading ? (
                          <span className="table-empty-loading">Loading your sessions…</span>
                        ) : bootError ? (
                          <span className="table-empty-loading">Couldn’t load sessions. See the message above and retry.</span>
                        ) : hasActiveSessionFilters ? (
                          <div className="table-empty">
                            <p className="table-empty-title">No sessions match these filters.</p>
                            <p className="table-empty-sub">Widen the date range or clear the source and subject filters to see more.</p>
                            <Button variant="outline" size="sm" type="button" onClick={clearSessionFilters}>Clear filters</Button>
                          </div>
                        ) : (
                          <div className="table-empty">
                            <p className="table-empty-title">No sessions yet.</p>
                            <p className="table-empty-sub">Sync a practice session to start tracking your accuracy and timing.</p>
                            <Button size="sm" type="button" onClick={() => setSyncCenterOpen(true)}>Sync a session</Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                  {processedSessions.map((row) => (
                    <tr key={`${row.session_external_id}-${row.run_id}`}>
                      <td>{formatDate(row.session_date)}</td>
                      <td>
                        <SourceBadge source={row.source} />
                        <ScoreChip row={row} />
                      </td>
                      <td className="section-col"><SubjectCell row={row} /></td>
                      <td>{formatMaybe(row.question_count_display)}</td>
                      <td>{formatMaybe(row.error_count_display)}</td>
                      <td>{formatPercent(row.answered_accuracy_pct)}</td>
                      <td>{formatDurationSeconds(row.avg_time_sec)}</td>
                      {showSessionDifficultyCols && <td>{formatDifficultyStat(row.hard_total, row.hard_accuracy_pct, row.hard_avg_time_sec)}</td>}
                      {showSessionDifficultyCols && <td>{formatDifficultyStat(row.medium_total, row.medium_accuracy_pct, row.medium_avg_time_sec)}</td>}
                      {showSessionDifficultyCols && <td>{formatDifficultyStat(row.easy_total, row.easy_accuracy_pct, row.easy_avg_time_sec)}</td>}
                      <td>
                        <Button
                          variant="outline"
                          size="sm"
                          className="readmore-btn"
                          type="button"
                          onClick={() => handleOpenSessionAnalysis(row)}
                        >
                          Open
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination-controls">
              <Button
                variant="outline"
                size="sm"
                disabled={sessionPagination.page <= 1}
                onClick={() => loadSessions(sessionPagination.page - 1)}
              >
                Previous
              </Button>
              <span className="pagination-info">
                Page {sessionPagination.page} of {sessionPagination.totalPages || 1} ({sessionPagination.total} total sessions)
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={sessionPagination.page >= sessionPagination.totalPages}
                onClick={() => loadSessions(sessionPagination.page + 1)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </section>

      <section id="errors" className="page-section">
        <div className="section-header">
          <h2>Error Log</h2>
          <button
            type="button"
            className="collapse-toggle"
            onClick={() => toggleSection('errorLog')}
            aria-expanded={!collapsedSections.errorLog}
            aria-label="Toggle Error Log section"
          >
            {collapsedSections.errorLog ? '\u002B' : '\u2212'}
          </button>
        </div>
        {!collapsedSections.errorLog && (
          <>
            {(() => {
              const advancedActiveCount =
                (filters.difficulty ? 1 : 0) +
                (filters.confidence ? 1 : 0) +
                (filters.mistakeTag ? 1 : 0);
              const anyActive =
                filters.subject || filters.difficulty || filters.confidence ||
                filters.search || filters.mistakeTag || filters.platform;
              return (
                <div className="error-filter-bar">
                  <div className="error-filter-primary">
                    <Select
                      className="filter-select"
                      value={filters.platform}
                      onChange={(event) => setFilters((prev) => ({ ...prev, platform: event.target.value }))}
                    >
                      <option value="">All sources</option>
                      <option value="starttest">Official Guide</option>
                      <option value="gmatclub">GMAT Club</option>
                      <option value="gmatclub-cat">GMAT Club CAT</option>
                      <option value="ttp">Target Test Prep</option>
                      <option value="lsat">LSAT</option>
                    </Select>
                    <Select
                      className="filter-select"
                      value={filters.subject}
                      onChange={(event) => setFilters((prev) => ({ ...prev, subject: event.target.value }))}
                    >
                      <option value="">All subjects</option>
                      <option value="Q">Quant</option>
                      <option value="V">Verbal</option>
                      <option value="DI">Data Insights</option>
                      <option value="RC">RC (LSAT)</option>
                      <option value="CR">CR (LSAT)</option>
                    </Select>
                    <Input
                      className="error-filter-search"
                      placeholder="Search subcategory, Q Code, or stem..."
                      value={filters.search}
                      onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
                    />
                    <button
                      type="button"
                      className={`error-filter-more${errorFiltersOpen ? ' is-open' : ''}${advancedActiveCount ? ' has-active' : ''}`}
                      onClick={() => setErrorFiltersOpen((v) => !v)}
                      aria-expanded={errorFiltersOpen}
                    >
                      More filters{advancedActiveCount ? ` (${advancedActiveCount})` : ''}
                    </button>
                    {anyActive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setFilters({ subject: '', difficulty: '', topic: '', confidence: '', search: '', mistakeTag: '', platform: '' });
                          setErrorFiltersOpen(false);
                        }}
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                  {errorFiltersOpen && (
                    <div className="error-filter-secondary">
                      <Select
                        className="filter-select"
                        value={filters.difficulty}
                        onChange={(event) => setFilters((prev) => ({ ...prev, difficulty: event.target.value }))}
                      >
                        <option value="">All difficulty</option>
                        <option value="Hard">Hard</option>
                        <option value="Medium">Medium</option>
                        <option value="Easy">Easy</option>
                        <option value="Unknown">Unknown</option>
                      </Select>
                      <Select
                        className="filter-select"
                        value={filters.confidence}
                        onChange={(event) => setFilters((prev) => ({ ...prev, confidence: event.target.value }))}
                      >
                        <option value="">All confidence</option>
                        <option value="high">high</option>
                        <option value="medium">medium</option>
                        <option value="low">low</option>
                        <option value="not selected">not selected</option>
                      </Select>
                      <Select
                        className="filter-select"
                        value={filters.mistakeTag}
                        onChange={(event) => setFilters((prev) => ({ ...prev, mistakeTag: event.target.value }))}
                      >
                        <option value="">All mistake tags</option>
                        {ALL_MISTAKE_TAGS.map((tag) => (
                          <option key={tag} value={tag}>{tag}</option>
                        ))}
                      </Select>
                    </div>
                  )}
                </div>
              );
            })()}

            <div className="table-wrap error-log-table-wrap">
              <table className="review-table error-log-table">
                <thead>
                  <tr>
                    <th className="sortable err-col-date" onClick={() => handleErrorSort('session_date')}>Date {sortIndicator(errorSort, 'session_date')}</th>
                    <th className="sortable section-col" onClick={() => handleErrorSort('subject')}>Subject {sortIndicator(errorSort, 'subject')}</th>
                    <th className="sortable category-col" onClick={() => handleErrorSort('category')}>Category {sortIndicator(errorSort, 'category')}</th>
                    <th className="sortable topic-col" onClick={() => handleErrorSort('topic')}>Subcategory {sortIndicator(errorSort, 'topic')}</th>
                    <th className="sortable" onClick={() => handleErrorSort('difficulty')}>Diff {sortIndicator(errorSort, 'difficulty')}</th>
                    <th className="sortable" onClick={() => handleErrorSort('time_sec')}>Time {sortIndicator(errorSort, 'time_sec')}</th>
                    <th className="sortable" onClick={() => handleErrorSort('mistake_type')}>Mistake Tags {sortIndicator(errorSort, 'mistake_type')}</th>
                    <th className="action-col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.length === 0 && (
                    <tr>
                      <td colSpan="8">
                        {isDashboardLoading ? (
                          <span className="table-empty-loading">Loading your error log…</span>
                        ) : bootError ? (
                          <span className="table-empty-loading">Couldn’t load the error log. See the message above and retry.</span>
                        ) : hasActiveErrorFilters ? (
                          <div className="table-empty">
                            <p className="table-empty-title">No errors match these filters.</p>
                            <p className="table-empty-sub">Adjust or clear the filters above to see more of your log.</p>
                            <Button variant="outline" size="sm" type="button" onClick={clearErrorFilters}>Clear filters</Button>
                          </div>
                        ) : (
                          <div className="table-empty">
                            <p className="table-empty-title">No errors logged yet.</p>
                            <p className="table-empty-sub">Sync a session, then every wrong answer collects here for review.</p>
                            <Button size="sm" type="button" onClick={() => setSyncCenterOpen(true)}>Sync a session</Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                  {errors.map((row) => {
                    const isExpanded = expandedErrorId === row.id;
                    const platform = getSourcePlatform(row.source);
                    const tags = parseMistakeTags(row.mistake_type);
                    const hasNotes = !!(row.notes && String(row.notes).trim());
                    const canReview = hasScrapedQuestionContent(row) || row.question_url;
                    return (
                      <Fragment key={row.id}>
                        <tr
                          className={`error-row${isExpanded ? ' error-row--expanded' : ''}`}
                          onClick={(event) => {
                            if (event.target.closest('button, a')) return;
                            setExpandedErrorId(isExpanded ? null : row.id);
                          }}
                        >
                          <td className="err-col-date">
                            <span className="err-col-date-inner">
                              <button
                                type="button"
                                className="error-row-toggle"
                                aria-expanded={isExpanded}
                                aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
                                onClick={(event) => { event.stopPropagation(); setExpandedErrorId(isExpanded ? null : row.id); }}
                              >
                                {isExpanded ? '−' : '+'}
                              </button>
                              {platform && <span className={`source-dot source-dot--${platform}`} title={row.source || ''} aria-hidden="true" />}
                              <span className="err-date-text">{formatDate(row.session_date)}</span>
                            </span>
                          </td>
                          <td className="section-col"><SubjectCell row={row} /></td>
                          <td className="category-col">{formatMaybe(normalizedCategoryCode(row))}</td>
                          <td className="topic-col">{formatMaybe(normalizedSubcategory(row))}</td>
                          <td>
                            {row.difficulty ? (
                              <span className={`difficulty-chip difficulty-chip--${String(row.difficulty).toLowerCase()}`}>
                                {row.difficulty}
                                {row.difficulty_theta != null && (
                                  <span className="difficulty-chip__theta">{Number(row.difficulty_theta).toFixed(2)}</span>
                                )}
                              </span>
                            ) : <span className="muted">-</span>}
                          </td>
                          <td>{formatDurationSeconds(row.time_sec)}</td>
                          <td className="mistake-tags-cell">
                            {tags.length > 0
                              ? tags.map((tag) => (
                                  <span key={tag} className="mistake-tag-pill">{tag}</span>
                                ))
                              : <span className="muted">-</span>}
                            {hasNotes && <span className="err-notes-marker" title="Has notes" aria-label="Has notes">●</span>}
                          </td>
                          <td className="action-col">
                            <div className="error-row-actions">
                              <Button
                                variant="outline"
                                size="sm"
                                className="readmore-btn"
                                type="button"
                                onClick={() => handleOpenAnnotation(row)}
                              >
                                Note
                              </Button>
                              {canReview ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  type="button"
                                  className="readmore-btn"
                                  onClick={() => handleQuestionAction(row, 'error-log')}
                                  disabled={openingQuestionKey === questionOpenKey(row, 'error-log')}
                                >
                                  {openingQuestionKey === questionOpenKey(row, 'error-log')
                                    ? '...'
                                    : formatQuestionActionLabel(row)}
                                </Button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="error-expand-row">
                            <td colSpan="8">
                              <div className="error-expand-grid">
                                <div className="error-expand-field">
                                  <span>Source</span>
                                  <SourceBadge source={row.source} />
                                </div>
                                <div className="error-expand-field">
                                  <span>Q Code</span>
                                  <strong>{formatMaybe(row.q_code)}</strong>
                                </div>
                                <div className="error-expand-field">
                                  <span>Redo</span>
                                  {Number(row.corrected_later || 0) === 1 ? (
                                    <Badge variant="success" className="redo-pill">Corrected</Badge>
                                  ) : (
                                    <span className="muted">Not yet</span>
                                  )}
                                </div>
                                {hasNotes && (
                                  <div className="error-expand-field error-expand-notes">
                                    <span>Notes</span>
                                    <p>{row.notes}</p>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pagination-controls">
              <Button
                variant="outline"
                size="sm"
                disabled={errorPagination.page <= 1}
                onClick={() => loadErrors(errorPagination.page - 1)}
              >
                Previous
              </Button>
              <span className="pagination-info">
                Page {errorPagination.page} of {errorPagination.totalPages || 1} ({errorPagination.total} total errors)
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={errorPagination.page >= errorPagination.totalPages}
                onClick={() => loadErrors(errorPagination.page + 1)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </section>
      </>
      )}

      {syncCenterOpen && (
        <div
          className="analysis-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Sync GMAT Practice"
          onClick={() => setSyncCenterOpen(false)}
        >
          <div className="analysis-dialog sync-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="analysis-shell">
              <div className="analysis-header">
                <h2>Sync GMAT Practice</h2>
                <Button variant="outline" type="button" onClick={() => setSyncCenterOpen(false)}>
                  Close
                </Button>
              </div>

              <section className="analysis-block">
                <h3>1) Trigger Scrape</h3>
                <div className="form-grid">
                  <label>
                    Source
                    <Select value={selectedSource} onChange={(e) => setSelectedSource(e.target.value)}>
                      {sources.map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.label}
                        </option>
                      ))}
                    </Select>
                  </label>
                  {sources.find((s) => s.id === selectedSource)?.platform === 'ope-mock' && (
                    <label>
                      Take to scrape
                      <div className="action-row" style={{ gap: '8px', alignItems: 'stretch' }}>
                        <Select
                          value={selectedTakeIdx}
                          onChange={(e) => setSelectedTakeIdx(e.target.value)}
                          disabled={!opeTakes.length}
                          style={{ flex: 1 }}
                        >
                          {!opeTakes.length && <option value="">(Load takes first)</option>}
                          {opeTakes.map((t) => (
                            <option key={t.takeIdx} value={String(t.takeIdx)}>
                              Take #{t.takeIdx} — {t.completedAt || t.completedAtText || 'unknown date'}
                            </option>
                          ))}
                        </Select>
                        <Button
                          variant="outline"
                          type="button"
                          disabled={isLoadingOpeTakes || !selectedSource}
                          onClick={loadOpeTakes}
                          title="Read the Take # table from the OPE landing page in your Chrome tab"
                        >
                          {isLoadingOpeTakes ? 'Loading...' : 'Load Takes'}
                        </Button>
                      </div>
                      {opeTakesError && (
                        <span style={{ color: '#b91c1c', fontSize: '0.85em' }}>{opeTakesError}</span>
                      )}
                    </label>
                  )}
                  <label>
                    Scrape Period
                    <Select value={scrapeWindow} onChange={(e) => setScrapeWindow(e.target.value)}>
                      <option value="today">Today (default, with safety buffer)</option>
                      <option value="last3">Last 3 days</option>
                      <option value="last7">Last 7 days</option>
                      <option value="full">Full update</option>
                      <option value="custom">Specific period</option>
                    </Select>
                  </label>
                  {scrapeWindow === 'custom' && (
                    <label>
                      Specific Period (since, ICT UTC+7)
                      <Input
                        type="datetime-local"
                        value={customSince}
                        onChange={(event) => setCustomSince(event.target.value)}
                      />
                    </label>
                  )}
                  <div className="action-row">
                    <Button
                      variant="outline"
                      type="button"
                      disabled={isOpening || !selectedSource}
                      onClick={handleOpenChrome}
                    >
                      {isOpening ? 'Opening...' : 'Open Chrome (CDP)'}
                    </Button>
                    {sources.find((s) => s.id === selectedSource)?.platform === 'starttest' && (
                      <Button
                        variant="outline"
                        type="button"
                        disabled={isOpeningProduct || !selectedSource}
                        onClick={handleOpenProduct}
                        title="Switch your GMAT Chrome tab to the selected product's home page"
                      >
                        {isOpeningProduct ? 'Switching...' : 'Open in GMAT'}
                      </Button>
                    )}
                    <Button
                      type="button"
                      disabled={
                        isScraping
                        || !selectedSource
                        || (scrapeWindow === 'custom' && !customSince)
                        || (sources.find((s) => s.id === selectedSource)?.platform === 'ope-mock' && !selectedTakeIdx)
                      }
                      onClick={handleScrape}
                    >
                      {isScraping ? 'Scraping...' : 'Run Scrape + Save to DB'}
                    </Button>
                  </div>
                </div>
                {syncDebug && (
                  <div className="sync-debug">
                    <div className="sync-debug-head">
                      <h3>Last Sync Debug</h3>
                      <Button variant="outline" type="button" onClick={() => setSyncDebug(null)}>
                        Clear
                      </Button>
                    </div>
                    <pre>{JSON.stringify(syncDebug, null, 2)}</pre>
                  </div>
                )}
              </section>

              <section className="analysis-block">
                <h3>2) Review Run</h3>
                <div className="run-header">
                  <label>
                    Run
                    <Select value={selectedRunId} onChange={handleRunChange}>
                      <option value="">All runs (upserted dataset)</option>
                      {runs.map((run) => (
                        <option key={run.id} value={run.id}>
                          {`Run ${run.id} | ${new Date(run.extracted_at).toLocaleString()}`}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
                <div className="summary-grid">
                  <div className="summary-item">
                    <span>Run ID</span>
                    <strong>{summary.id}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Sessions</span>
                    <strong>{summary.total_sessions || 0}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Questions</span>
                    <strong>{summary.total_questions || 0}</strong>
                  </div>
                  <div className="summary-item">
                    <span>Errors</span>
                    <strong>{summary.total_errors || 0}</strong>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}

      {patternDrilldown.open && (
        <div
          className="analysis-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Pattern Drilldown"
          onClick={handleClosePatternDrilldown}
        >
          <div className="analysis-dialog session-analysis-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="analysis-shell">
              <div className="analysis-header">
                <h2>{patternDrilldown.title}</h2>
                <div className="analysis-actions">
                  <Button variant="outline" type="button" onClick={handleApplyPatternToErrorLog}>
                    Apply to Error Log
                  </Button>
                  <Button variant="outline" type="button" onClick={handleClosePatternDrilldown}>
                    Close
                  </Button>
                </div>
              </div>

              {patternDrilldown.loading && <p className="muted">Loading matching errors...</p>}
              {patternDrilldown.error && <p className="error">{patternDrilldown.error}</p>}

              {!patternDrilldown.loading && !patternDrilldown.error && (
                <>
                  <p className="muted">{`${patternDrilldown.rows.length} matching errors`}</p>
                  <div className="table-wrap">
                    <table className="review-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Session</th>
                          <th className="section-col">Subject</th>
                          <th className="category-col">Category</th>
                          <th>Subcategory</th>
                          <th>Difficulty</th>
                          <th>Q Code</th>
                          <th>Confidence</th>
                          <th>Redo</th>
                          <th>Open</th>
                          <th>Time</th>
                          <th>Mistake Type</th>
                          <th>Notes</th>
                          <th>Annotate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!patternDrilldown.rows.length && (
                          <tr>
                            <td colSpan="14">No rows match this pattern.</td>
                          </tr>
                        )}
                        {patternDrilldown.rows.map((row) => (
                          <tr key={row.id}>
                            <td>{formatDate(row.session_date)}</td>
                            <td>{formatMaybe(row.session_external_id)}</td>
                            <td className="section-col"><SubjectCell row={row} /></td>
                            <td className="category-col">{formatMaybe(normalizedCategoryCode(row))}</td>
                            <td>{formatMaybe(normalizedSubcategory(row))}</td>
                            <td>{formatMaybe(row.difficulty)}</td>
                            <td>{formatMaybe(row.q_code)}</td>
                            <td>{formatMaybe(row.confidence)}</td>
                            <td>
                              {Number(row.corrected_later || 0) === 1 ? (
                                <Badge variant="success" className="redo-pill">
                                  Corrected
                                </Badge>
                              ) : (
                                <span className="muted">Not yet</span>
                              )}
                            </td>
                            <td>
                              {hasScrapedQuestionContent(row) || row.question_url ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  type="button"
                                  className="readmore-btn"
                                  onClick={() => handleQuestionAction(row, 'drilldown')}
                                  disabled={openingQuestionKey === questionOpenKey(row, 'drilldown')}
                                >
                                  {openingQuestionKey === questionOpenKey(row, 'drilldown')
                                    ? 'Opening...'
                                    : formatQuestionActionLabel(row)}
                                </Button>
                              ) : (
                                <span className="muted">-</span>
                              )}
                            </td>
                            <td>{formatDurationSeconds(row.time_sec)}</td>
                            <td>
                              {parseMistakeTags(row.mistake_type).length ? (
                                <span style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                  {parseMistakeTags(row.mistake_type).map((tag) => (
                                    <span key={tag} className="mistake-tag-pill">{tag}</span>
                                  ))}
                                </span>
                              ) : (
                                formatMaybe(row.mistake_type)
                              )}
                            </td>
                            <td className="notes-cell" title={row.notes || ''}>
                              {formatNotePreview(row.notes)}
                            </td>
                            <td>
                              <Button
                                variant="outline"
                                size="sm"
                                className="readmore-btn"
                                type="button"
                                onClick={() => handleOpenAnnotation(row)}
                              >
                                Annotate
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {sessionAnalysis.open && (
        <div
          className="analysis-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Session Analysis"
          onClick={handleCloseSessionAnalysis}
        >
          <div className="analysis-dialog session-analysis-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="analysis-shell">
            <div className="analysis-header">
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <h2 style={{ margin: 0 }}>Session Analysis</h2>
                {sessionAnalysis.data?.session?.source && (
                  <SourceBadge source={sessionAnalysis.data.session.source} />
                )}
                {sessionAnalysis.data?.session && (
                  <ScoreChip row={sessionAnalysis.data.session} />
                )}
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {sessionAnalysis.data?.session && sources.some((s) => s.label === sessionAnalysis.data.session.source && (s.platform === 'starttest' || s.platform === 'gmatclub' || s.platform === 'gmatclub-cat')) && (
                  <Button
                    variant="outline"
                    type="button"
                    disabled={isEnriching}
                    onClick={() => setEnrichConfirmId(sessionAnalysis.data.session.id)}
                    title="Phase 2: deep-enrich this session by visiting each question's page. Long-running; keep the matching tab open."
                  >
                    {isEnriching ? 'Enriching…' : 'Enrich Phase 2'}
                  </Button>
                )}
                {sessionAnalysis.data?.session && sources.some((s) => s.label === sessionAnalysis.data.session.source && s.platform === 'ope-mock') && (
                  <Button
                    variant="outline"
                    type="button"
                    disabled={isEnriching}
                    onClick={() => setEnrichConfirmId(sessionAnalysis.data.session.id)}
                    title="Phase 3: deep-enrich this OPE mock by walking the Score Report popup item-by-item. Long-running (~3 min). Open the OPE landing page in Chrome and click 'View score report' for this take FIRST; leave the popup on the Score Card. Do not click anything inside the popup."
                  >
                    {isEnriching ? 'Enriching…' : 'Enrich Phase 3 (OPE)'}
                  </Button>
                )}
                <Button variant="outline" type="button" onClick={handleCloseSessionAnalysis}>
                  Close
                </Button>
              </div>
            </div>
            {enrichConfirmId != null && !isEnriching && (
              <div className="status" style={{ marginBottom: '8px', fontSize: '0.85rem' }}>
                <div style={{ marginBottom: '8px' }}>
                  Deep-enrich this session? This walks every question in your open GMAT tab over ~3–5 minutes — keep that tab on the matching product and don’t click around in it until it finishes.
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <Button
                    type="button"
                    onClick={() => {
                      const id = enrichConfirmId;
                      setEnrichConfirmId(null);
                      handleEnrichSession(id);
                    }}
                  >
                    Start enrichment
                  </Button>
                  <Button variant="outline" type="button" onClick={() => setEnrichConfirmId(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {lastEnrichResult && (
              // Gated on the result alone (not sessionAnalysis.data) so it stays
              // readable while the post-enrich refresh transiently nulls `data`
              // — otherwise the outcome flashes and vanishes before it can be read.
              <div className={`status ${lastEnrichResult.ok === false || lastEnrichResult.aborted ? 'error' : ''}`} style={{ marginBottom: '8px', fontSize: '0.85rem' }}>
                {lastEnrichResult.ok === false
                  ? `Phase 2 failed: ${lastEnrichResult.error}`
                  : lastEnrichResult.aborted
                    ? `Phase 2 aborted: ${lastEnrichResult.dbUpdated}/${lastEnrichResult.qhTotal} saved (${lastEnrichResult.abortReason})`
                    : `Phase 2: ${lastEnrichResult.dbUpdated}/${lastEnrichResult.qhTotal} items enriched.`}
              </div>
            )}

            {sessionAnalysis.loading && <p className="muted loading-pulse">Loading session data...</p>}
            {sessionAnalysis.error && <p className="status error">{sessionAnalysis.error}</p>}

            {!sessionAnalysis.loading && !sessionAnalysis.error && sessionAnalysis.data?.session && (
              <>
                {isOpeSession && opeAnalysis ? (
                  <div className="ope-exam-panel">
                    <header className="ope-exam-id">
                      <div className="ope-exam-id-text">
                        <span className="ope-exam-eyebrow">GMAT Official Practice Exam</span>
                        <span className="ope-exam-number">
                          {opeAnalysis.examNumber != null ? `#${opeAnalysis.examNumber}` : '—'}
                        </span>
                        {sessionAnalysis.data.session.session_date && (
                          <span className="ope-exam-taken">
                            Taken {formatIsoDate(sessionAnalysis.data.session.session_date)}
                          </span>
                        )}
                      </div>
                      <div className="ope-score-chart" role="img" aria-label="Scaled scores">
                        {/* Horizontal bars stacked vertically: Total (205-805) on top,
                            then Quant / Verbal / DI (each 60-90). Bar fill = (score-min)/(max-min).
                            Target reference: 705 total, 80 per section. */}
                        {[
                          { code: 'Total', name: 'Total', field: 'total_score', min: 205, max: 805, target: 705 },
                          { code: 'Q', name: 'Quant', field: 'quant_score', min: 60, max: 90, target: 80 },
                          { code: 'V', name: 'Verbal', field: 'verbal_score', min: 60, max: 90, target: 80 },
                          { code: 'DI', name: 'Data Insights', field: 'di_score', min: 60, max: 90, target: 80 },
                        ].map(({ code, name, field, min, max, target }) => {
                          const raw = sessionAnalysis.data?.session?.[field];
                          const score = Number(raw);
                          const hasScore = Number.isFinite(score) && score >= min && score <= max;
                          const pct = hasScore ? ((score - min) / (max - min)) * 100 : 0;
                          const targetPct = ((target - min) / (max - min)) * 100;
                          const isTotal = code === 'Total';
                          return (
                            <div
                              key={code}
                              className={`ope-score-row section-${code}${hasScore ? '' : ' is-empty'}${isTotal ? ' is-total' : ''}`}
                            >
                              <span className="ope-score-row-label">{name}</span>
                              <div className="ope-score-row-track">
                                <div className="ope-score-row-fill" style={{ width: `${pct}%` }} />
                                <div
                                  className="ope-score-row-target"
                                  style={{ left: `${targetPct}%` }}
                                  aria-hidden="true"
                                  title={`Target ${target}`}
                                />
                                <span className="ope-score-row-scale" aria-hidden="true">
                                  {min}–{max}
                                </span>
                              </div>
                              <span className="ope-score-row-value">{hasScore ? score : '—'}</span>
                            </div>
                          );
                        })}
                      </div>
                    </header>

                    <div className="ope-section-scoreboard">
                      {opeAnalysis.sections.map((sec) => (
                        <article key={sec.code} className={`ope-section-card section-${sec.code}`}>
                          <header>
                            <span className="ope-section-name">{sec.name}</span>
                            <span className="ope-section-count">{sec.correct}/{sec.total}</span>
                          </header>
                          <div className="ope-section-accuracy">
                            {sec.accuracy != null ? sec.accuracy.toFixed(1) : '—'}
                            <small>%</small>
                          </div>
                          <dl className="ope-section-meta">
                            <div><dt>Total time</dt><dd>{formatDurationSeconds(sec.totalTime)}</dd></div>
                            <div><dt>Avg / Q</dt><dd>{formatDurationSeconds(sec.avgTime)}</dd></div>
                            <div><dt>Wrong</dt><dd>{sec.wrong}</dd></div>
                          </dl>
                          <div className="ope-section-pacing">
                            {sec.rushedWrong > 0 && (
                              <span className="pacing-pill pacing-rushed" title="Wrong, answered in under 60s">
                                {sec.rushedWrong} rushed
                              </span>
                            )}
                            {sec.stuckWrong > 0 && (
                              <span className="pacing-pill pacing-stuck" title="Wrong, took over 3:00">
                                {sec.stuckWrong} stuck
                              </span>
                            )}
                            {sec.burnedCorrect > 0 && (
                              <span className="pacing-pill pacing-burned" title="Correct but took over 3:00">
                                {sec.burnedCorrect} burned
                              </span>
                            )}
                            {!sec.rushedWrong && !sec.stuckWrong && !sec.burnedCorrect && (
                              <span className="pacing-pill pacing-clean">clean pacing</span>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>

                    {opeAnalysis.suggestions.length > 0 && (
                      <section className="ope-suggestions">
                        <h3>Next steps</h3>
                        <ol>
                          {opeAnalysis.suggestions.map((s, i) => (
                            <li key={i} className={`ope-suggestion priority-${s.priority}`}>
                              <strong>{s.title}</strong>
                              <span>{s.body}</span>
                            </li>
                          ))}
                        </ol>
                      </section>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="session-stats-primary">
                      <div className="session-stat-hero">
                        <span>Accuracy</span>
                        <strong>{formatPercent(getSessionAnsweredAccuracy(sessionAnalysis.data.session))}</strong>
                      </div>
                      <div className="session-stat-hero">
                        <span>Questions</span>
                        <strong>{formatMaybe(getSessionQuestionCount(sessionAnalysis.data.session))}</strong>
                      </div>
                      <div className="session-stat-hero">
                        <span>Avg Time</span>
                        <strong>{formatDurationSeconds(sessionAnalysis.data.session.avg_time_sec)}</strong>
                      </div>
                    </div>
                    <div className="session-stats-secondary">
                      <span>{formatDate(sessionAnalysis.data.session.session_date)}</span>
                      <span>{formatMaybe(normalizeSubjectCodeValue(sessionAnalysis.data.session.subject))}</span>
                      <span>Completion {formatPercent(getSessionCompletionRate(sessionAnalysis.data.session))}</span>
                      <span>Unanswered {formatMaybe(getSessionUnansweredCount(sessionAnalysis.data.session))}</span>
                      <span>Correct avg {formatDurationSeconds(sessionAnalysis.data.session.avg_correct_time_sec)}</span>
                      <span>Wrong avg {formatDurationSeconds(sessionAnalysis.data.session.avg_incorrect_time_sec)}</span>
                      <span>ID {formatMaybe(sessionAnalysis.data.session.session_external_id)}</span>
                    </div>
                  </>
                )}

                <div className="analysis-block">
                  <h3>Difficulty Breakdown</h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Difficulty</th>
                          <th>Q</th>
                          <th>Correct</th>
                          <th>Wrong</th>
                          <th>Accuracy</th>
                          <th>Avg Time</th>
                          <th>Avg Correct Time</th>
                          <th>Avg Incorrect Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!sessionAnalysis.data.byDifficulty?.length && (
                          <tr>
                            <td colSpan="8">No question-level data for this session.</td>
                          </tr>
                        )}
                        {(sessionAnalysis.data.byDifficulty || []).map((row) => (
                          <tr key={row.difficulty}>
                            <td>{formatMaybe(row.difficulty)}</td>
                            <td>{formatMaybe(row.total)}</td>
                            <td>{formatMaybe(row.correct)}</td>
                            <td>{formatMaybe(row.wrong)}</td>
                            <td>{formatPercent(row.accuracy_pct)}</td>
                            <td>{formatDurationSeconds(row.avg_time_sec)}</td>
                            <td>{formatDurationSeconds(row.avg_correct_time_sec)}</td>
                            <td>{formatDurationSeconds(row.avg_incorrect_time_sec)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="pattern-grid">
                  <div>
                    <h3>Wrong Categories</h3>
                    <ul className="metric-list">
                      {!wrongCategoryRows.length && <li className="metric-empty">No wrong-category data</li>}
                      {wrongCategoryRows.map((row) => (
                        <li key={row.category}>
                          <span className="metric-label">{row.category}</span>
                          <span className="metric-values">
                            <strong>{row.mistakes}</strong>
                            <small>
                              {totalWrongCategoryMistakes
                                ? `${((Number(row.mistakes || 0) * 100) / totalWrongCategoryMistakes).toFixed(1)}%`
                                : '0.0%'}
                            </small>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <h3>Confidence Performance</h3>
                    <ul className="metric-list">
                      {!sessionAnalysis.data.confidencePerformance?.length && <li className="metric-empty">No confidence data</li>}
                      {(sessionAnalysis.data.confidencePerformance || []).map((row) => (
                        <li key={row.confidence}>
                          <span className="metric-label">{row.confidence}</span>
                          <span className="metric-values">
                            <strong>{`${row.wrong}/${row.total} wrong`}</strong>
                            <small>{`Acc ${formatPercent(row.accuracy_pct)}`}</small>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="analysis-block">
                  <div className="analysis-block__head">
                    <h3>{`All Questions (${sortedSessionAnalysisWrongQuestions.length})`}</h3>
                    <div className="analysis-block__filters">
                      {sessionAnalysisResultCounts.correct > 0 && sessionAnalysisResultCounts.wrong > 0 && (
                        <Select
                          className="filter-select"
                          value={sessionAnalysisResultFilter}
                          onChange={(event) => setSessionAnalysisResultFilter(event.target.value)}
                          aria-label="Filter questions by result"
                        >
                          <option value="">All results</option>
                          <option value="correct">{`Correct (${sessionAnalysisResultCounts.correct})`}</option>
                          <option value="wrong">{`Wrong (${sessionAnalysisResultCounts.wrong})`}</option>
                        </Select>
                      )}
                      {sessionAnalysisSubjectOptions.length > 1 && (
                        <Select
                          className="filter-select"
                          value={sessionAnalysisSubjectFilter}
                          onChange={(event) => setSessionAnalysisSubjectFilter(event.target.value)}
                          aria-label="Filter questions by subject"
                        >
                          <option value="">All subjects</option>
                          {sessionAnalysisSubjectOptions.map((opt) => (
                            <option key={opt.code} value={opt.code}>{`${opt.label} (${opt.count})`}</option>
                          ))}
                        </Select>
                      )}
                      {sessionAnalysisCategoryOptions.length > 1 && (
                        <Select
                          className="filter-select"
                          value={sessionAnalysisCategoryFilter}
                          onChange={(event) => setSessionAnalysisCategoryFilter(event.target.value)}
                          aria-label="Filter questions by category"
                        >
                          <option value="">All categories</option>
                          {sessionAnalysisCategoryOptions.map((opt) => (
                            <option key={opt.code} value={opt.code}>{`${opt.code} (${opt.count})`}</option>
                          ))}
                        </Select>
                      )}
                    </div>
                  </div>
                  <div className="table-wrap session-analysis-questions-wrap">
                    <table className="review-table session-analysis-questions-table">
                      <thead>
                        <tr>
                          <th className="result-col sortable" onClick={() => handleSessionAnalysisSort('correct')}>Result {sortIndicator(sessionAnalysisSort, 'correct')}</th>
                          <th className="section-col">Subject</th>
                          <th className="category-col">Category</th>
                          <th className="sortable topic-col" onClick={() => handleSessionAnalysisSort('topic')}>Subcategory {sortIndicator(sessionAnalysisSort, 'topic')}</th>
                          <th className="sortable" onClick={() => handleSessionAnalysisSort('difficulty')}>Difficulty {sortIndicator(sessionAnalysisSort, 'difficulty')}</th>
                          <th className="sortable" onClick={() => handleSessionAnalysisSort('q_code')}>Q Code {sortIndicator(sessionAnalysisSort, 'q_code')}</th>
                          <th className="sortable" onClick={() => handleSessionAnalysisSort('time_sec')}>Time {sortIndicator(sessionAnalysisSort, 'time_sec')}</th>
                          <th className="sortable" onClick={() => handleSessionAnalysisSort('mistake_type')}>Mistake Type {sortIndicator(sessionAnalysisSort, 'mistake_type')}</th>
                          <th className="sortable notes-col" onClick={() => handleSessionAnalysisSort('notes')}>Notes {sortIndicator(sessionAnalysisSort, 'notes')}</th>
                          <th className="action-col open-col">Review</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!sessionAnalysis.data.slowWrongQuestions?.length && (
                          <tr>
                            <td colSpan="10">No answered questions in this session.</td>
                          </tr>
                        )}
                        {sortedSessionAnalysisWrongQuestions.map((row, idx) => {
                          const isCorrect = Number(row?.correct) === 1;
                          return (
                          <tr key={`${row.q_code || 'q'}-${idx}`} className={isCorrect ? 'row-correct' : 'row-wrong'}>
                            <td className="result-col">
                              <span className={`result-pill ${isCorrect ? 'result-correct' : 'result-wrong'}`}>
                                {isCorrect ? 'Correct' : 'Wrong'}
                              </span>
                            </td>
                            <td className="section-col"><SubjectCell row={row} /></td>
                            <td className="category-col">{formatMaybe(normalizedCategoryCode(row))}</td>
                            <td className="topic-col">{formatMaybe(normalizedSubcategory(row))}</td>
                            <td>
                              {row.difficulty ? (
                                <span className={`difficulty-chip difficulty-chip--${String(row.difficulty).toLowerCase()}`}>
                                  {row.difficulty}
                                  {row.difficulty_theta != null && (
                                    <span className="difficulty-chip__theta">{Number(row.difficulty_theta).toFixed(2)}</span>
                                  )}
                                </span>
                              ) : <span className="muted">-</span>}
                            </td>
                            <td>{formatMaybe(row.q_code)}</td>
                            <td>{formatDurationSeconds(row.time_sec)}</td>
                            <td>
                              {parseMistakeTags(row.mistake_type).length ? (
                                <span style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                  {parseMistakeTags(row.mistake_type).map((tag) => (
                                    <span key={tag} className="mistake-tag-pill">{tag}</span>
                                  ))}
                                </span>
                              ) : (
                                formatMaybe(row.mistake_type)
                              )}
                            </td>
                            <td className="notes-cell notes-col" title={row.notes || ''}>
                              {formatNotePreview(row.notes)}
                            </td>
                            <td className="action-col open-col">
                              {hasScrapedQuestionContent(row) || row.question_url ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  type="button"
                                  className="readmore-btn"
                                  onClick={() => handleQuestionAction(row, 'session-analysis')}
                                  disabled={openingQuestionKey === questionOpenKey(row, 'session-analysis')}
                                >
                                  {openingQuestionKey === questionOpenKey(row, 'session-analysis')
                                    ? 'Opening...'
                                    : formatQuestionActionLabel(row)}
                                </Button>
                              ) : (
                                <span className="muted">-</span>
                              )}
                            </td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
          </div>
        </div>
      )}

      {questionReview.open && questionReview.row && (
        <div
          className="analysis-overlay question-review-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Question Review"
          onClick={handleCloseQuestionReview}
        >
          <div className="analysis-dialog question-review-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="analysis-shell question-review-shell">
              <div className="analysis-header">
                <h2>{questionReview.row.q_code ? `Question ${questionReview.row.q_code}` : 'Question Review'}</h2>
                <div className="analysis-actions">
                  {questionReviewNav.total > 1 && (
                    <div className="question-review-nav">
                      <Button
                        variant="outline"
                        type="button"
                        onClick={() => handleOpenQuestionReview(questionReviewNav.prev)}
                        disabled={!questionReviewNav.prev}
                        aria-label="Previous question"
                      >
                        ← Prev
                      </Button>
                      <span className="question-review-nav-counter">
                        {`${questionReviewNav.index + 1} / ${questionReviewNav.total}`}
                      </span>
                      <Button
                        variant="outline"
                        type="button"
                        onClick={() => handleOpenQuestionReview(questionReviewNav.next)}
                        disabled={!questionReviewNav.next}
                        aria-label="Next question"
                      >
                        Next →
                      </Button>
                    </div>
                  )}
                  {canonicalQuestionUrl(questionReview.row) ? (
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => handleOpenQuestionInGmat(questionReview.row, 'question-review')}
                      disabled={openingQuestionKey === questionOpenKey(questionReview.row, 'question-review')}
                    >
                      {openingQuestionKey === questionOpenKey(questionReview.row, 'question-review') ? 'Opening...' : 'Open in GMAT'}
                    </Button>
                  ) : null}
                  <Button variant="outline" type="button" onClick={handleCloseQuestionReview}>
                    Close
                  </Button>
                </div>
              </div>

              <div className="question-review-hero">
                <div className="question-review-meta">
                  <span className="question-review-chip chip-subject">{formatMaybe(normalizeSubjectFamilyDisplay(normalizedSubjectCode(questionReview.row)))}</span>
                  <span className="question-review-chip chip-subject">{formatMaybe(normalizedCategoryCode(questionReview.row))}</span>
                  <span className={`question-review-chip chip-difficulty-${String(questionReview.row.difficulty || '').toLowerCase()}`}>{formatMaybe(questionReview.row.difficulty)}</span>
                  <span className="question-review-chip">{formatMaybe(normalizedSubcategory(questionReview.row))}</span>
                  {formatResponseFormat(questionReview.row.response_format) && (
                    <span className="question-review-chip">{formatResponseFormat(questionReview.row.response_format)}</span>
                  )}
                  {formatContentDomain(questionReview.row.content_domain) && (
                    <span className="question-review-chip">{formatContentDomain(questionReview.row.content_domain)}</span>
                  )}
                  {formatTopicSource(questionReview.row.topic_source) && (
                    <span className="question-review-chip muted-chip">{formatTopicSource(questionReview.row.topic_source)}</span>
                  )}
                </div>
                {getResponseSlots(questionReview.row).length > 0 ? (
                  <div className="di-answer-summary">
                    <div className="di-answer-summary-row di-answer-summary-header">
                      <span>Part</span>
                      <span>Your Answer</span>
                      <span>Correct</span>
                    </div>
                    {getResponseSlots(questionReview.row).map((slot, index) => {
                      const userVal = formatResponseValue(slot, slot?.user_value);
                      const correctVal = formatResponseValue(slot, slot?.correct_value);
                      const isMatch = userVal && correctVal && userVal === correctVal;
                      return (
                        <div key={slot?.slot_id || `row-${index}`} className={`di-answer-summary-row${isMatch ? ' di-row-correct' : userVal ? ' di-row-wrong' : ''}`}>
                          <span className="di-part-label">{normalizeQuestionText(slot?.prompt || '') || `Part ${index + 1}`}</span>
                          <span className="di-answer-yours">{userVal || '—'}</span>
                          <span className="di-answer-correct">{correctVal || '—'}</span>
                        </div>
                      );
                    })}
                    <div className="di-answer-summary-footer">
                      <div><span>Time</span><strong>{formatDurationSeconds(questionReview.row.time_sec)}</strong></div>
                      <div><span>Confidence</span><strong>{formatMaybe(questionReview.row.confidence)}</strong></div>
                    </div>
                  </div>
                ) : (() => {
                  const sRow = questionReview.row;
                  let yourVal = formatMaybe(sRow.my_answer || summarizeStructuredResponse(sRow, 'user_value'));
                  let correctVal = formatMaybe(sRow.correct_answer || summarizeStructuredResponse(sRow, 'correct_value'));
                  // Matrix CSVs are transposed between my_answer (often per-row)
                  // and correct_answer (per-column), so the raw strings look
                  // mismatched even when the answer is right. Render both in the
                  // same "<column> → row N" orientation so they line up.
                  if (String(sRow.response_format || '').toLowerCase() === 'matrix') {
                    const mc = parseAnswerChoices(sRow.answer_choices);
                    if (Array.isArray(mc[0]?.options)) {
                      const { colCount, headers, correctByCol, userByCol } = decodeMatrixSelections(mc, sRow.correct_answer);
                      const colLabel = (ci) => normalizeQuestionText(headers[ci] || '') || `Col ${ci + 1}`;
                      const fmtPairs = (arr) => arr
                        .map((r, ci) => (r ? `${colLabel(ci)} → ${r}` : null))
                        .filter(Boolean)
                        .join(', ');
                      if (colCount > 0) {
                        const u = fmtPairs(userByCol);
                        const c = fmtPairs(correctByCol);
                        if (u) yourVal = u;
                        if (c) correctVal = c;
                      }
                    }
                  }
                  return (
                    <div className="question-review-stats">
                      <div>
                        <span>Your Answer</span>
                        <strong>{yourVal}</strong>
                      </div>
                      <div>
                        <span>Correct</span>
                        <strong>{correctVal}</strong>
                      </div>
                      <div>
                        <span>Time</span>
                        <strong>{formatDurationSeconds(sRow.time_sec)}</strong>
                      </div>
                      <div>
                        <span>Confidence</span>
                        <strong>{formatMaybe(sRow.confidence)}</strong>
                      </div>
                    </div>
                  );
                })()}
              </div>

              <section className="question-review-section question-annotation-section">
                <h3>Annotation</h3>
                <div className="question-annotation-grid">
                  <div className="question-side-card">
                    <span className="question-side-label">Mistake Tags</span>
                    <div className="question-side-tags">
                      {parseMistakeTags(questionReview.row.mistake_type).length ? (
                        parseMistakeTags(questionReview.row.mistake_type).map((tag) => (
                          <span key={tag} className="mistake-tag-pill">{tag}</span>
                        ))
                      ) : (
                        <span className="muted">No tags yet</span>
                      )}
                    </div>
                  </div>
                  <div className="question-side-card">
                    <span className="question-side-label">Notes</span>
                    <p>{normalizeQuestionText(questionReview.row.notes) || 'No notes yet.'}</p>
                  </div>
                  <div className="question-side-card">
                    <span className="question-side-label">Actions</span>
                    <div className="question-side-actions">
                      <Button variant="outline" type="button" onClick={() => handleOpenAnnotation(questionReview.row)}>
                        Annotate
                      </Button>
                      {canonicalQuestionUrl(questionReview.row) ? (
                        <Button
                          variant="outline"
                          type="button"
                          onClick={() => handleOpenQuestionInGmat(questionReview.row, 'question-review-side')}
                          disabled={openingQuestionKey === questionOpenKey(questionReview.row, 'question-review-side')}
                        >
                          {openingQuestionKey === questionOpenKey(questionReview.row, 'question-review-side')
                            ? 'Opening...'
                            : 'Open in GMAT'}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </section>

              <section className={`question-review-layout${rowHasPassage(questionReview.row) ? ' has-passage' : ''}`}>
                {rowHasPassage(questionReview.row) && (
                  <div className="question-review-col question-review-passage-col">
                    <div className="question-review-section">
                      <h3>Passage</h3>
                      <div className="question-passage-card">
                        <PassageLines
                          lines={questionReview.row.passage_lines}
                          text={questionReview.row.passage_text}
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div className="question-review-col question-review-main-col">
                  <div className="question-review-section">
                    <h3>Question Stem</h3>
                    <div className="question-stem-card">
                      <StemContent row={questionReview.row} />
                    </div>
                  </div>

                  <div className="question-review-section">
                  <h3>
                    {getResponseSlots(questionReview.row).length
                      ? 'Response Structure'
                      : 'Answer Choices'}
                  </h3>
                  {getResponseSlots(questionReview.row).length ? (
                    <div className="response-slot-list">
                      {getResponseSlots(questionReview.row).map((slot, index) => {
                        const prompt = normalizeQuestionText(slot?.prompt || '') || `Part ${index + 1}`;
                        const slotOptions = Array.isArray(slot?.options) ? slot.options : [];
                        const userValue = formatResponseValue(slot, slot?.user_value);
                        const correctValue = formatResponseValue(slot, slot?.correct_value);
                        const slotType = String(slot?.slot_type || '').toLowerCase();
                        const isDropdown = slotType === 'dropdown';
                        const isChoiceGrid = slotType === 'choice-grid';
                        return (
                          <article key={slot?.slot_id || `slot-${index}`} className={`response-slot-card${isDropdown ? ' slot-dropdown' : ''}${isChoiceGrid ? ' slot-choice-grid' : ''}`}>
                            <div className="response-slot-head">
                              <div>
                                <strong>{prompt}</strong>
                                {formatSlotType(slot?.slot_type) && (
                                  <span className="response-slot-type">{formatSlotType(slot?.slot_type)}</span>
                                )}
                              </div>
                              {(isDropdown && (userValue || correctValue)) ? (
                                <div className="slot-dropdown-answers">
                                  {userValue && <span className="slot-answer-yours">You: {userValue}</span>}
                                  {correctValue && correctValue !== userValue && <span className="slot-answer-correct">Correct: {correctValue}</span>}
                                  {userValue && correctValue && userValue === correctValue && <span className="slot-answer-correct">Correct</span>}
                                </div>
                              ) : (
                                <div className="response-slot-summary">
                                  {userValue && <span>Your response: {userValue}</span>}
                                  {correctValue && <span>Correct response: {correctValue}</span>}
                                </div>
                              )}
                            </div>

                            {slotOptions.length ? (
                              <div className={`response-slot-options${isChoiceGrid ? ' slot-options-compact' : ''}`}>
                                {slotOptions.map((option, optionIndex) => {
                                  const label = String(option?.label || '').trim();
                                  const text = normalizeQuestionText(option?.text || '') || '-';
                                  const isMine = String(slot?.user_value || '').trim() === String(option?.id || '').trim();
                                  const isCorrect = String(slot?.correct_value || '').trim() === String(option?.id || '').trim();
                                  return (
                                    <article
                                      key={`${slot?.slot_id || index}-${option?.id || optionIndex}`}
                                      className={`answer-choice-card response-option-card${isMine ? ' mine' : ''}${isCorrect ? ' correct' : ''}`}
                                    >
                                      <div className="answer-choice-head">
                                        <strong>{label || text}</strong>
                                        <div className="answer-choice-flags">
                                          {isMine && <span className="question-mini-chip">Your pick</span>}
                                          {isCorrect && <span className="question-mini-chip success-chip">Correct</span>}
                                        </div>
                                      </div>
                                      {label && text !== label && <p>{text}</p>}
                                    </article>
                                  );
                                })}
                              </div>
                            ) : (
                              <p className="muted">No option-level scrape for this DI slot.</p>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  ) : parseAnswerChoices(questionReview.row.answer_choices).length ? (
                    (() => {
                      const choices = parseAnswerChoices(questionReview.row.answer_choices);
                      const fmt = String(questionReview.row.response_format || '').toLowerCase();
                      const myAns = String(questionReview.row.my_answer || '').trim();
                      const corrAns = String(questionReview.row.correct_answer || '').trim();
                      // Trust per-choice flags only when at least one option is
                      // actually marked. The two flags are evaluated
                      // independently — some StartTest rows capture which
                      // option the user picked but not which one is correct,
                      // and we want to fall back per-flag in that case.
                      const anyMine = choices.some((c) => c?.isUserSelected === true);
                      const anyCorrectFlagged = choices.some((c) => c?.isCorrect === true);
                      const Legend = (
                        <div className="answer-choice-legend">
                          <span className="legend-item"><span className="legend-dot legend-dot-correct" />Correct answer</span>
                          <span className="legend-item"><span className="legend-dot legend-dot-right" />Your pick · right</span>
                          <span className="legend-item"><span className="legend-dot legend-dot-wrong" />Your pick · wrong</span>
                        </div>
                      );

                      if (fmt === 'matrix' && Array.isArray(choices[0]?.options)) {
                        const { colCount, headers, correctCells } = decodeMatrixSelections(choices, corrAns);
                        // `headers` may carry a trailing label for the row-label
                        // column (e.g. "Description of work"); the answer columns
                        // are the first `colCount` entries — drive colCount off the
                        // options, not headers, so that label isn't rendered as a
                        // spurious empty answer column.
                        const cornerLabel = headers.length > colCount ? (headers[colCount] || '') : '';
                        return (
                          <div className="answer-matrix-wrap">
                            {Legend}
                            <div
                              className="answer-matrix-grid"
                              style={{ gridTemplateColumns: `minmax(0,1fr) repeat(${colCount}, minmax(80px, max-content))` }}
                            >
                              <div className="amg-corner">{normalizeQuestionText(cornerLabel)}</div>
                              {Array.from({ length: colCount }).map((_, ci) => (
                                <div key={`h-${ci}`} className="amg-header">{headers[ci] || ''}</div>
                              ))}
                              {choices.map((row, ri) => (
                                <Fragment key={`r-${ri}`}>
                                  <div className="amg-row-label">
                                    <span className="amg-row-num">{ri + 1}</span>
                                    <span>{normalizeQuestionText(row?.text || row?.label || '') || '-'}</span>
                                  </div>
                                  {Array.from({ length: colCount }).map((_, ci) => {
                                    const opt = (row?.options || [])[ci] || {};
                                    const userPicked = !!opt.isUserSelected;
                                    // Per-cell isCorrect is unreliable for matrix (color is
                                    // usually null); the authoritative correct cells come from
                                    // correct_answer via decodeMatrixSelections. Union the two
                                    // so a rare color-flagged cell is still honored.
                                    const correct = correctCells.has(`${ri + 1},${ci + 1}`) || !!opt.isCorrect;
                                    const cls = userPicked && correct ? 'cell-right'
                                      : userPicked ? 'cell-wrong'
                                      : correct ? 'cell-correct'
                                      : '';
                                    const sym = userPicked && correct ? '✓'
                                      : userPicked ? '✗'
                                      : correct ? '✓'
                                      : '';
                                    return <div key={`c-${ri}-${ci}`} className={`amg-cell ${cls}`}>{sym}</div>;
                                  })}
                                </Fragment>
                              ))}
                            </div>
                          </div>
                        );
                      }

                      if (fmt === 'dropdown') {
                        const correctParts = corrAns ? corrAns.split(/\s*,\s*/) : [];
                        return (
                          <div className="answer-blank-wrap">
                            {Legend}
                            <div className="answer-blank-list">
                              {choices.map((blank, bi) => {
                                const userText = String(blank?.text || '').trim();
                                const isPlaceholder = !userText || /^select\.\.\.?$/i.test(userText);
                                const correctText = (correctParts[bi] || '').trim();
                                const userIsRight = !isPlaceholder && correctText && userText === correctText;
                                return (
                                  <article key={`b-${bi}`} className="answer-blank-card">
                                    <header className="answer-blank-head">
                                      <strong>{blank?.label || `Blank ${bi + 1}`}</strong>
                                    </header>
                                    <div className="answer-blank-body">
                                      <div className={`answer-blank-cell ${userIsRight ? 'cell-right' : isPlaceholder ? 'cell-empty' : 'cell-wrong'}`}>
                                        <span className="answer-blank-meta">Your pick</span>
                                        <span className="answer-blank-text">{isPlaceholder ? '—' : userText}</span>
                                      </div>
                                      <div className={`answer-blank-cell ${userIsRight ? 'cell-right' : 'cell-correct'}`}>
                                        <span className="answer-blank-meta">Correct</span>
                                        <span className="answer-blank-text">{correctText || '—'}</span>
                                      </div>
                                    </div>
                                  </article>
                                );
                              })}
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div className="answer-choice-wrap">
                          {Legend}
                          <div className="answer-choice-list">
                            {choices.map((choice, index) => {
                              const label = String(choice?.label || String.fromCharCode(65 + index)).trim();
                              const text = normalizeQuestionText(choice?.text || '');
                              const choiceHtml = sanitizeStemHtml(choice?.textHtml);
                              const isMine = anyMine
                                ? !!choice?.isUserSelected
                                : myAns.toUpperCase() === label.toUpperCase();
                              const isCorrect = anyCorrectFlagged
                                ? !!choice?.isCorrect
                                : corrAns.toUpperCase() === label.toUpperCase();
                              const variant = isMine && isCorrect ? 'mine correct'
                                : isMine ? 'mine wrong'
                                : isCorrect ? 'correct-only'
                                : '';
                              return (
                                <article key={`${label}-${index}`} className={`answer-choice-card ${variant}`}>
                                  <div className="answer-choice-head">
                                    <strong>{label}</strong>
                                    <div className="answer-choice-flags">
                                      {isMine && isCorrect && <span className="question-mini-chip success-chip">Your pick · Correct</span>}
                                      {isMine && !isCorrect && <span className="question-mini-chip">Your pick · Wrong</span>}
                                      {!isMine && isCorrect && <span className="question-mini-chip accent-chip">Correct answer</span>}
                                    </div>
                                  </div>
                                  {choiceHtml
                                    ? <div className="answer-choice-html question-stem-html" dangerouslySetInnerHTML={{ __html: choiceHtml }} />
                                    : <p>{text || '-'}</p>}
                                </article>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()
                  ) : (
                    <p className="muted">No answer choices were scraped for this question.</p>
                  )}
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}

      {annotation.open && (
        <div
          className="analysis-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Annotate Error"
          onClick={handleCloseAnnotation}
        >
          <div className="analysis-dialog note-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="analysis-shell">
              <div className="analysis-header">
                <h2>{`Annotate Question ${annotation.row?.q_code || annotation.row?.id || ''}`}</h2>
                <Button variant="outline" type="button" onClick={handleCloseAnnotation}>
                  Close
                </Button>
              </div>
              <div className="form-grid">
                <div className="mistake-tags-section">
                  <div className="mistake-tags-head">
                    <span className="mistake-tags-section-title">
                      Mistake Tags
                      {annotation.mistakeTags.length > 0 && (
                        <span className="mistake-tags-count">{annotation.mistakeTags.length}</span>
                      )}
                    </span>
                    <input
                      type="search"
                      className="mistake-tags-search"
                      placeholder="Search tags…"
                      value={tagSearch}
                      onChange={(event) => setTagSearch(event.target.value)}
                    />
                  </div>
                  {annotation.mistakeTags.length > 0 && (
                    <div className="mistake-tags-selected">
                      {annotation.mistakeTags.map((tag) => (
                        <span
                          key={tag}
                          className="mistake-tag-pill selected"
                          title={TAG_DESCRIPTIONS[tag] || undefined}
                        >
                          {tag}
                          <button
                            type="button"
                            className="mistake-tag-remove"
                            onClick={() => handleToggleMistakeTag(tag)}
                            aria-label={`Remove ${tag}`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {(() => {
                    const subjCode = normalizedSubjectCode(annotation.row);
                    const ordered = SUBJECT_TAG_PRIORITY[subjCode] || MISTAKE_CATEGORY_ORDER;
                    const search = tagSearch.trim().toLowerCase();
                    const visibleCategories = ordered
                      .map((category) => {
                        const tags = MISTAKE_TYPES[category] || [];
                        const filtered = search
                          ? tags.filter((t) => t.toLowerCase().includes(search))
                          : tags.filter((t) => tagAllowedForSubject(t, subjCode));
                        return { category, filtered };
                      })
                      .filter(({ filtered }) => filtered.length > 0);
                    if (!visibleCategories.length) {
                      return <p className="muted mistake-tags-empty">No tags match "{tagSearch}".</p>;
                    }
                    return visibleCategories.map(({ category, filtered }, idx) => (
                      <div key={category} className={`mistake-category${idx === 0 && subjCode && !search ? ' is-suggested' : ''}`}>
                        <span className="mistake-category-label">
                          {category}
                          {idx === 0 && subjCode && !search && (
                            <span className="mistake-category-suggested">
                              {subjCode === 'Q' ? 'Quant' : subjCode === 'V' ? 'Verbal' : 'Data Insights'} priority
                            </span>
                          )}
                        </span>
                        <div className="mistake-tags-grid">
                          {filtered.map((tag) => (
                            <label
                              key={tag}
                              className="mistake-tag-checkbox"
                              title={TAG_DESCRIPTIONS[tag] || undefined}
                            >
                              <input
                                type="checkbox"
                                checked={annotation.mistakeTags.includes(tag)}
                                onChange={() => handleToggleMistakeTag(tag)}
                              />
                              {tag}
                            </label>
                          ))}
                        </div>
                      </div>
                    ));
                  })()}
                </div>
                <label className="notes-label">
                  Notes
                  <Textarea
                    rows={6}
                    value={annotation.notes}
                    placeholder="Add your reasoning gap, trap pattern, or takeaway..."
                    onChange={(event) => setAnnotation((prev) => ({ ...prev, notes: event.target.value }))}
                  />
                </label>
              </div>
              {annotation.error && <p className="status error">{annotation.error}</p>}
              <div className="analysis-actions">
                <Button variant="outline" type="button" onClick={handleCloseAnnotation}>
                  Cancel
                </Button>
                <Button type="button" onClick={handleSaveAnnotation} disabled={annotation.saving}>
                  {annotation.saving ? 'Saving...' : 'Save Annotation'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
