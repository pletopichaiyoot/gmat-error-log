// Splits a StartTest single-choice question_stem into the question PROMPT and,
// for CR-style items, the ARGUMENT/passage that precedes (or follows) it.
//
// Why this exists: StartTest's `.ITSStemText` element is the whole item body, so
// the scraped `question_stem` for single-choice items (CR / DS / RC / SC / PS)
// contains FOUR things glued together:
//   1. boilerplate  -> "This is a multiple choice question for which you need to
//                       select 1 answer from 5 choices."
//   2. the prompt    -> "Which of the following most logically completes the
//                       passage?" (a.k.a. the question stem in GMAT parlance)
//   3. the argument  -> the passage being reasoned about (CR) — absent for DS/RC
//   4. all N choices -> already captured separately in answer_choices, so they
//                       render twice in the review modal.
//
// This module is a PURE function (no DOM, no DB) shared by:
//   - the Phase 2 scraper (src/scrapers/starttest_scraper.js) — clean at write time
//   - the one-time backfill (scripts/backfill-stem-passage-split.js) — fix old rows
//   - unit tests (test/unit/question-stem-split.test.js)
//
// Contract: returns { stem, passage }.
//   - `stem` is the cleaned prompt (boilerplate + duplicated choices removed).
//   - `passage` is the derived argument, or '' when no confident split exists
//     (DS questions, prompt-only RC stems) — callers must NOT clobber an existing
//     passage_text with an empty string.
// It is deterministic and idempotent: feeding a previously-cleaned stem back in
// returns the same stem and an empty passage.

// First-line boilerplate StartTest prepends to every single-choice item.
const BOILERPLATE_RE = /^\s*This is a .*\bquestion\b.*\byou need to select\b.*$/i;

// Strong, prompt-only signals. A text block that matches one of these is the
// question prompt rather than the argument. Kept deliberately specific so a
// narrative argument almost never matches (the split uses a *strictly higher*
// score, so an accidental single match on the argument still loses to the
// prompt's multiple matches).
const PROMPT_PATTERNS = [
  /\bwhich of the following\b/i,
  /\b(?:each|all|any|none|some) of the following\b/i,
  /\bof the following\b/i,
  /\bmost logically completes\b/i,
  /\bcompletes? the (?:passage|argument|statement)\b/i,
  /\b(?:argument|reasoning|conclusion|claim|passage|statement|paragraph|information)\b[^.?!]*\babove\b/i,
  /\babove\b[^.?!]*\b(?:argument|reasoning|conclusion|claim|passage|statement|paragraph)\b/i,
  /\bmost (?:strongly )?(?:strengthens?|weakens?|supports?|undermines?|calls? into question|helps? to (?:explain|justify|account))/i,
  /\bif true\b/i,
  /\bmost vulnerable to (?:the )?criticism\b/i,
  /\b(?:assumption|assumes|presupposes)\b[^.?!]*\b(?:argument|conclusion|depends|which|above)\b/i,
  /\b(?:argument|conclusion)\b[^.?!]*\b(?:assumption|assumes|depends)\b/i,
  /\bthe (?:passage|author|argument)\b[^.?!]*\b(?:suggests?|implies|indicates?|states?|claims?|mentions?|asserts?)\b/i,
  /\baccording to the (?:passage|author|argument)\b/i,
  /\b(?:primary )?purpose of (?:the )?(?:passage|paragraph|argument)\b/i,
  /\bEXCEPT\b/,
  /\b(?:best|most) (?:explains?|accounts? for|resolves?)\b/i,
  /\b(?:discrepancy|paradox|apparent contradiction)\b/i,
  /\b(?:boldface|in bold)\b/i,
  /\bplays? (?:which of )?the (?:following )?role\b/i,
  /\bdraws? (?:its )?conclusion\b/i,
];

function normalizeLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function promptScore(block) {
  let score = 0;
  for (const re of PROMPT_PATTERNS) if (re.test(block)) score += 1;
  return score;
}

// A CR argument is prose: a few sentences of real text. This rejects passage
// candidates that are actually leftover answer-choice scraps — roman numerals
// ("I only / II only") or fragmented MathML ("x | x | ...") that couldn't be
// stripped — so we never invent a passage out of options.
function looksLikeProse(block) {
  const text = String(block || '').trim();
  if (text.length < 40) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;
  if (!/[.?!]/.test(text)) return false; // arguments contain sentences
  const lines = text.split('\n');
  const shortLines = lines.filter((l) => l.trim().length <= 2).length;
  if (lines.length >= 4 && shortLines / lines.length > 0.4) return false; // fragmented
  return true;
}

// rawStem: the stored/scraped question_stem (may contain boilerplate + choices).
// choiceTexts: the per-choice display text (answer_choices[].text or scraper
//   choice labels). Used to delete the duplicated choices from the stem.
function splitStemAndPassage(rawStem, choiceTexts = []) {
  const text = String(rawStem || '');
  if (!text.trim()) return { stem: '', passage: '' };

  const choiceNorms = new Set(
    (Array.isArray(choiceTexts) ? choiceTexts : [])
      .map(normalizeLine)
      .filter(Boolean)
  );

  // 1) Drop the boilerplate line and any line that is exactly an answer choice.
  //    Line-based removal is order-independent and survives choices that appear
  //    anywhere; full-sentence choices won't collide with argument lines.
  let boilerplateDropped = false;
  const keptLines = text.split('\n').filter((line) => {
    if (!boilerplateDropped && BOILERPLATE_RE.test(line)) {
      boilerplateDropped = true;
      return false;
    }
    return !choiceNorms.has(normalizeLine(line));
  });
  let body = keptLines.join('\n');

  // 2) Safety net: choices are always the trailing contiguous block. If the
  //    first choice survived line-removal (e.g. it wrapped across lines), find
  //    its earliest occurrence and truncate the body there.
  if (choiceNorms.size) {
    let cut = -1;
    for (const ct of choiceTexts) {
      const needle = String(ct || '').trim();
      if (needle.length < 8) continue; // skip trivially short choices (DI noise)
      const i = body.indexOf(needle);
      if (i >= 0 && (cut === -1 || i < cut)) cut = i;
    }
    if (cut >= 0) body = body.slice(0, cut);
  }

  // 3) Collapse whitespace: trim trailing spaces per line, squeeze 3+ blank
  //    lines to one, trim ends.
  body = body
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!body) return { stem: '', passage: '' };

  // Passage extraction is only safe when we had answer-choice texts to remove.
  // Without them (e.g. image / MathML / roman-numeral choices store text:null),
  // the choices remain in `body` and would be misread as a "passage" — so we
  // strip the boilerplate only and return everything as a single stem.
  if (choiceNorms.size === 0) return { stem: body, passage: '' };

  // 4) Break into blocks on blank lines and classify by prompt score.
  const blocks = body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length <= 1) return { stem: body, passage: '' };

  const scored = blocks.map((block, idx) => ({ block, idx, score: promptScore(block) }));
  const maxScore = Math.max(...scored.map((s) => s.score));
  const topBlocks = scored.filter((s) => s.score === maxScore);

  // Split only when one block is the UNAMBIGUOUS prompt (strictly highest,
  // positive score). Otherwise keep the whole body as the stem so we never
  // mangle a multi-part question (e.g. DS statements) into a fake passage.
  if (maxScore === 0 || topBlocks.length !== 1) {
    return { stem: blocks.join('\n\n'), passage: '' };
  }

  const promptIdx = topBlocks[0].idx;
  const stem = blocks[promptIdx];
  const passage = blocks.filter((_, i) => i !== promptIdx).join('\n\n');

  // Only split when the remainder reads like an argument. Otherwise it's
  // leftover option text masquerading as a passage — keep the whole body as the
  // stem instead.
  if (!looksLikeProse(passage)) return { stem: body, passage: '' };

  return { stem, passage };
}

module.exports = { splitStemAndPassage, BOILERPLATE_RE, PROMPT_PATTERNS, promptScore };
