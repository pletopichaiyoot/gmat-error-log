// scripts/og/assemble.js
// Join one book-subject's practice questions, printed answer key and answer
// explanations, and reconcile the two independent readings of each key.
//
// The printed key and the explanation-derived key are independent. Where both
// exist they must agree; where they disagree the question is left unkeyed and
// flagged, never resolved by preferring one. Where only one exists it stands
// alone — which is how OG13's CR section survives a printed key its scan
// destroyed.

// Explanations are matched to questions by printed number where the scan kept
// one (OG13 CR keeps 97 of 124) and by position otherwise.
function matchExplanations(questions, explanations) {
  const byNumber = new Map();
  const numbers = new Set(questions.map(q => q.number));

  const taken = new Set();
  const leftovers = [];
  for (const e of explanations) {
    if (e.number && numbers.has(e.number) && !taken.has(e.number)) {
      byNumber.set(e.number, e);
      taken.add(e.number);
    } else if (e.number && !numbers.has(e.number)) {
      // A number the practice section does not have: the scan misread it.
      leftovers.push(e);
    } else {
      leftovers.push(e);
    }
  }

  // Remaining questions take the remaining entries in printed order, so an
  // entry whose number was lost still reaches its question.
  const free = questions.map(q => q.number).filter(n => !taken.has(n));
  leftovers.sort((a, b) => a.position - b.position);
  for (let i = 0; i < free.length && i < leftovers.length; i++) {
    byNumber.set(free[i], leftovers[i]);
  }
  return byNumber;
}

// Whether a question can actually be practised, by the rules the repo already
// applies when curating a practice set (CLAUDE.md): a non-empty stem, five
// choices that all carry text, and a key. A disputed key is not a key — a
// wrong one tells the user they missed a question they answered correctly.
function unusableReason(q, correct, keyDisputed, kind) {
  // Reading Comprehension without its passage cannot be answered. Passages are
  // attached by the pdfplumber pass, so RC stays unusable until that has run.
  if (kind === 'RC' && !q.passageId) return 'no-passage';
  if (!q.stem || !q.stem.trim()) return 'stem';
  if (q.choices.length !== 5) return 'choices';
  if (q.choices.some(c => !c.text || !c.text.trim())) return 'blank-choice';
  if (keyDisputed) return 'key-disputed';
  if (!correct) return 'no-key';
  return null;
}

function assembleSection({ book, kind, questions, keys, explanations, passageRefs }) {
  const warnings = [];
  const matched = matchExplanations(questions, explanations);

  const stats = {
    total: 0, keyed: 0, disputed: 0, fiveChoice: 0, labelled: 0,
    explained: 0, numberInferred: 0, usable: 0,
  };
  const out = [];

  for (const q of questions) {
    const id = `${book.code}-${kind}-${q.number}`;
    const e = matched.get(q.number) || null;

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

    const question = {
      id,
      number: q.number,
      stem: q.stem,
      choices: q.choices,
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

    const reason = unusableReason(q, correct, keyDisputed, kind);
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

module.exports = { assembleSection, matchExplanations, unusableReason };
