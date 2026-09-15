// scripts/og/assemble.js
// Join one book-subject's practice questions, printed answer key and answer
// explanations, and reconcile the two independent readings of each key.
//
// The printed key and the explanation-derived key are independent. Where both
// exist they must agree; where they disagree the question is left unkeyed and
// flagged, never resolved by preferring one. Where only one exists it stands
// alone — which is how OG13's CR section survives a printed key its scan
// destroyed.

const { parseQuestions } = require('./questions');

// Explanations carry the question they explain, reprinted above the type
// label, so they are matched on that text first. Numbers are only a fallback:
// where the scan lost them the parser infers them, and inferred numbers drift
// out of step with the explanations — in VR2's RC section that paired a
// "primary purpose" question with another question's explanation, giving it
// the wrong type label and a key the cross-check reported as disputed.
const MATCH_PREFIX = 50;

function stemKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, MATCH_PREFIX);
}

function entryStemKey(entry) {
  if (entry._stemKey !== undefined) return entry._stemKey;
  const block = (entry.questionBlock || []).join(' ').replace(/^\s*\d{1,3}\.\s*/, '');
  entry._stemKey = stemKey(block);
  return entry._stemKey;
}

function matchExplanations(questions, explanations) {
  const byNumber = new Map();
  const takenEntries = new Set();
  const takenQuestions = new Set();

  // 1. On the printed number. Measured across the three books this places the
  //    most questions correctly; the text the explanations reprint comes from
  //    a different OCR pass than the practice section, so exact stem matching
  //    across the two is brittle (it raised key disputes from 28 to 51).
  const numbers = new Set(questions.map(q => q.number));
  for (const e of explanations) {
    if (e.number && numbers.has(e.number) && !byNumber.has(e.number)) {
      byNumber.set(e.number, e);
      takenEntries.add(e);
      takenQuestions.add(e.number);
    }
  }

  // 2. On the reprinted question text, for questions the numbering did not
  //    place — which is where a scan that lost its numbers leaves them.
  const byStem = new Map();
  for (const e of explanations) {
    if (takenEntries.has(e)) continue;
    const k = entryStemKey(e);
    if (k && k.length >= 20 && !byStem.has(k)) byStem.set(k, e);
  }
  for (const q of questions) {
    if (takenQuestions.has(q.number)) continue;
    const k = stemKey(q.stem);
    const hit = k.length >= 20 ? byStem.get(k) : null;
    if (hit && !takenEntries.has(hit)) {
      byNumber.set(q.number, hit);
      takenEntries.add(hit);
      takenQuestions.add(q.number);
    }
  }

  // 3. Whatever is left, in printed order.
  const free = questions.map(q => q.number).filter(n => !takenQuestions.has(n));
  const leftovers = explanations.filter(e => !takenEntries.has(e))
    .sort((a, b) => a.position - b.position);
  for (let i = 0; i < free.length && i < leftovers.length; i++) {
    byNumber.set(free[i], leftovers[i]);
  }
  return byNumber;
}

// Residual scan damage glues following text onto a choice. A printed A-E set
// is roughly even in length, so one option several times the median of the
// rest is carrying something that is not an answer.
const LOPSIDED_RATIO = 3;
const LOPSIDED_MIN = 250;

function isLopsided(choices) {
  if (choices.length < 2) return false;
  const lens = choices.map(c => (c.text || '').length);
  const longest = Math.max(...lens);
  if (longest < LOPSIDED_MIN) return false;
  const rest = lens.filter((n, i) => i !== lens.indexOf(longest)).sort((a, b) => a - b);
  const median = rest[Math.floor(rest.length / 2)] || 0;
  return longest > median * LOPSIDED_RATIO;
}

// The scans cut a choice at a line break. A choice ending on a dangling
// function word with no terminal punctuation is the reliable tell — a short
// choice on its own is not ("Size" and "evaluation of a problem" are real
// options), so length alone would reject 90 good questions to catch these.
// Lower-case only, deliberately: truncation preserves the original case, and a
// matching upper-case token is usually a label ("option A"), not an article.
const DANGLING = /(?:^|\s)(of|the|a|an|to|and|or|in|on|for|with|that|which|as|by|from|at|than|into)$/;

function isTruncated(choice) {
  const t = (choice.text || '').trim();
  if (!t || /[.?!"\u201d\u2019)\]]$/.test(t)) return false;
  return DANGLING.test(t);
}

// The explanations reprint each question and its choices in single-column
// flow, above the type label. Where the two-column practice section cut a
// choice at a line break, that copy is intact.
//
// The trigger is evidence, not a heuristic: if every practice choice is a
// prefix of the explanation's rendering of the same choice and at least one is
// strictly shorter, the practice copy was cut and the explanation copy is the
// same text, whole. A truncation ending on a content word ("...in saline
// forest") is caught by this where the dangling-function-word test is not.
function squashText(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Index every explanation's reprinted choices by their opening characters, so
// a question can find the copy that reprints IT — independent of the number
// pairing, which is exactly what fails on the sections that need repair most.
// Long enough to identify a question, short enough that a brief option still
// takes part in the match.
const REPRINT_MIN_KEY = 18;

function buildReprintIndex(explanations) {
  const index = new Map();
  for (const entry of explanations) {
    if (!entry.questionBlock || !entry.questionBlock.length) continue;
    const parsed = parseQuestions(entry.questionBlock, { startAt: entry.number || 1 }).questions[0];
    if (!parsed || !parsed.choices.length) continue;
    for (const c of parsed.choices) {
      const k = squashText(c.text).slice(0, PAIR_PREFIX);
      if (k.length >= REPRINT_MIN_KEY && !index.has(k)) index.set(k, parsed.choices);
    }
  }
  return index;
}

function findReprint(q, index) {
  const counts = new Map();
  for (const c of q.choices) {
    const k = squashText(c.text).slice(0, PAIR_PREFIX);
    if (k.length < REPRINT_MIN_KEY) continue;
    const hit = index.get(k);
    if (hit) counts.set(hit, (counts.get(hit) || 0) + 1);
  }
  for (const [choices, n] of counts) {
    // Two matching choices is enough to identify the question; one could be a
    // stock option shared between questions.
    if (n >= 2 && choices.length === q.choices.length) return choices;
  }
  return null;
}

// Return the part of `full` that lies beyond `have`, comparing on normalized
// characters but cutting the RAW text, so the recovered tail keeps its own
// spacing and the part already in hand keeps the better rendering it has.
function tailBeyond(fullRaw, haveNormalizedLength) {
  let seen = 0;
  for (let i = 0; i < fullRaw.length; i++) {
    if (/[a-z0-9]/i.test(fullRaw[i])) {
      seen++;
      if (seen === haveNormalizedLength) return fullRaw.slice(i + 1);
    }
  }
  return '';
}

// Extend a cut choice with what the reprint has beyond it. The reprint often
// comes from a worse OCR pass ("plantsthat dowell"), so replacing the whole
// choice would trade a cut for glued words — only the missing part is taken.
function repairChoices(q, index) {
  const reprint = findReprint(q, index);
  if (!reprint) return null;
  if (reprint.some(c => !c.text || !c.text.trim())) return null;

  const out = [];
  let anyLonger = false;
  for (let i = 0; i < q.choices.length; i++) {
    const haveRaw = q.choices[i].text;
    const have = squashText(haveRaw);
    const full = squashText(reprint[i].text);
    if (!full.startsWith(have)) return null;
    if (full.length > have.length) {
      const tail = tailBeyond(reprint[i].text, have.length).trim();
      out.push({ label: q.choices[i].label, text: `${haveRaw.trim()} ${tail}`.trim() });
      anyLonger = true;
    } else {
      out.push(q.choices[i]);
    }
  }
  return anyLonger ? out : null;
}

// Whether a question can actually be practised, by the rules the repo already
// applies when curating a practice set (CLAUDE.md): a non-empty stem, five
// choices that all carry text, and a key. A disputed key is not a key — a
// wrong one tells the user they missed a question they answered correctly.
// A stem that opens mid-sentence is carrying the previous question's material.
//
// Where the two-column scan cuts a choice at a column or page break, the part
// that was cut off does not vanish — it lands at the head of the NEXT question's
// stem. So the same break damages two questions: the earlier one loses the end
// of a choice (caught by isTruncated) and the later one gains a fragment in
// front of its stem. 97 of the pool's questions are affected, all of them in the
// two scanned books; OG12's native text layer has none.
//
// Where the question's own printed number survived inside the stem, it marks the
// true start exactly and the fragment before it can be cut. The number must be
// within a couple of the question's own, or a page number glued into a CR
// stimulus ("...known to have 365 Which of the following...") would cut the
// stimulus away — and a CR question without its stimulus is unanswerable.
const STEM_NUMBER_MARK = /(?:^|\s)(\d{1,3})\.\s+(?=[A-Z“"])/g;
const STEM_NUMBER_WINDOW = 2;

function repairStem(stem, number) {
  const text = String(stem || '');
  if (!Number.isFinite(Number(number))) return text;
  let cut = -1;
  let m;
  STEM_NUMBER_MARK.lastIndex = 0;
  while ((m = STEM_NUMBER_MARK.exec(text))) {
    if (Math.abs(Number(m[1]) - Number(number)) <= STEM_NUMBER_WINDOW) cut = m.index + m[0].length;
  }
  return cut > 0 ? text.slice(cut).trim() : text;
}

// After the repair, a stem still opening lower-case is a fragment with no
// recoverable boundary — sometimes with no question in it at all ("largest moons
// and the planets of the solar system"). A stem defect drops the question.
function isStemFragment(stem) {
  return /^[a-z]/.test(String(stem || '').trim());
}

// "In the argument above, the portion in boldface plays which of the following
// roles?" is unanswerable unless the bold span survived extraction. It did not:
// pdftotext drops font weight and the pdfplumber pass never emitted stemHtml, so
// every one of these stems reads as undifferentiated prose. Matched on "bold
// face"/"boldfaced"/"portion(s) in bold" rather than a bare "bold", so "the bold
// claim above" is not caught.
const BOLDFACE_STEM = /\bbold\s?face\b|\bportions?\s+in\s+bold\b|\bboldfaced\b/i;

function unusableReason(q, correct, keyDisputed, kind) {
  // Reading Comprehension without its passage cannot be answered. Passages are
  // attached by the pdfplumber pass, so RC stays unusable until that has run.
  if (kind === 'RC' && !q.passageId) return 'no-passage';
  if (!q.stem || !q.stem.trim()) return 'stem';
  if (isStemFragment(q.stem)) return 'stem-fragment';
  if (BOLDFACE_STEM.test(q.stem) && !/<b[\s>]/i.test(q.stemHtml || '')) return 'boldface-unmarked';
  if (q.choices.length !== 5) return 'choices';
  if (q.choices.some(c => !c.text || !c.text.trim())) return 'blank-choice';
  if (isLopsided(q.choices)) return 'lopsided-choice';
  if (q.choices.some(isTruncated)) return 'truncated-choice';
  if (keyDisputed) return 'key-disputed';
  if (!correct) return 'no-key';
  return null;
}

// Whether an explanation really reprints the question it was paired with.
//
// Compared as characters with the spaces removed, not as words: the two copies
// come from different OCR passes, and the scans glue words together, so
// "The primarypurpose of thepassage isto" has to count as the same stem.
// Dropping spaces makes those identical while a different question still
// fails to contain the opening run.
const PAIR_PREFIX = 30;

function stemChars(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pairingLooksRight(q, entry) {
  const block = stemChars((entry.questionBlock || []).join(' '));
  if (block.length < 20) return true;

  // The CHOICES are the fingerprint, not the stem. Both copies render them
  // cleanly, whereas a stem reconstructed from choice runs — which is every
  // OG13 CR stem, since that scan lost the numbering — opens with a fragment
  // of the previous question and matches nothing.
  const choiceHits = (q.choices || [])
    .map(c => stemChars(c.text))
    .filter(t => t.length >= PAIR_PREFIX)
    .filter(t => block.includes(t.slice(0, PAIR_PREFIX)));
  if (choiceHits.length >= 2) return true;

  // No usable choice text to compare: fall back to either end of the stem.
  const stem = stemChars(q.stem);
  if (stem.length < 20) return true;
  return block.includes(stem.slice(0, PAIR_PREFIX))
    || block.includes(stem.slice(-PAIR_PREFIX));
}

// A section is only as trustworthy as its weakest link. Where the printed key
// was destroyed AND the numbering had to be inferred, explanations are matched
// to questions by a guess and nothing cross-checks the result. OG13's CR
// section is exactly that case: measured against OG12, which reprints 49 of
// the same questions with double-confirmed keys, only 3 of its keys agreed and
// 4 disagreed. A key that wrong is worse than none — it marks a correct answer
// wrong — so the whole section is withheld.
const INFERRED_SHARE_LIMIT = 0.5;

function keysAreUnverifiable(questions, keys) {
  if (keys.size > 0) return false;
  if (questions.length === 0) return false;
  const inferred = questions.filter(q => q.numberInferred).length;
  return inferred / questions.length > INFERRED_SHARE_LIMIT;
}

function assembleSection({ book, kind, questions, keys, explanations, passageRefs }) {
  const warnings = [];
  const matched = matchExplanations(questions, explanations);
  const unverifiable = keysAreUnverifiable(questions, keys);
  const reprints = buildReprintIndex(explanations);
  if (unverifiable) {
    warnings.push(`${book.code}-${kind}: no printed key and mostly inferred numbering, ` +
      'so explanation-derived keys cannot be cross-checked; section withheld');
  }

  const stats = {
    total: 0, keyed: 0, disputed: 0, fiveChoice: 0, labelled: 0,
    explained: 0, numberInferred: 0, usable: 0,
  };
  const out = [];

  for (const q of questions) {
    const id = `${book.code}-${kind}-${q.number}`;
    let e = matched.get(q.number) || null;
    if (e && !pairingLooksRight(q, e)) {
      warnings.push(`${id}: paired explanation reprints a different question; dropped`);
      e = null;
    }

    const repaired = repairChoices(q, reprints);
    if (repaired) q.choices = repaired;

    const printedKey = keys.get(q.number) || null;
    const explKey = e ? e.key : null;

    let correct = null, keyDisputed = false, keySource = null;
    if (printedKey && explKey) {
      if (printedKey === explKey) { correct = printedKey; keySource = 'printed+explanation'; }
      else {
        keyDisputed = true;
        warnings.push(`${id}: printed key ${printedKey} disagrees with explanation key ${explKey}`);
      }
    } else if (printedKey) { correct = printedKey; keySource = 'printed'; }
    else if (explKey) { correct = explKey; keySource = 'explanation'; }
    else warnings.push(`${id}: no key from either source`);

    stats.total++;
    if (correct) stats.keyed++;
    if (keyDisputed) stats.disputed++;
    if (q.choices.length === 5) stats.fiveChoice++;
    if (e && e.typeLabel) stats.labelled++;
    if (e) stats.explained++;
    if (q.numberInferred) stats.numberInferred++;

    const stem = repairStem(q.stem, q.number);
    const stemRepaired = stem !== q.stem;

    const question = {
      id,
      number: q.number,
      stem,
      choices: q.choices,
      ...(repaired ? { choicesSource: 'explanation' } : {}),
      passageId: q.passageId || null,
      correct,
      typeLabel: e ? e.typeLabel : null,
      explanation: e
        ? { situation: e.situation, reasoning: e.reasoning, choices: e.choiceNotes }
        : null,
      keyDisputed,
      keySource,
      refs: [{ book: book.code, number: q.number }],
    };
    if (q.numberInferred) question.numberInferred = true;
    if (stemRepaired) question.stemSource = 'renumbered';

    const reason = unverifiable
      ? 'unverifiable-key'
      : unusableReason({ ...q, stem }, correct, keyDisputed, kind);
    question.usable = reason === null;
    if (reason) question.unusable = reason;
    else stats.usable++;

    out.push(question);
  }

  if (explanations.length !== questions.length) {
    warnings.push(`${book.code}-${kind}: ${questions.length} questions but ` +
      `${explanations.length} explanation entries`);
  }

  return { section: { kind, passageRefs, questions: out }, stats, warnings };
}

module.exports = { assembleSection, matchExplanations, unusableReason, isTruncated, repairStem };
