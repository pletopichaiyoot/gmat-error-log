// scripts/og/questions.js
// Parse a practice region into questions. Four artefacts of the real books are
// guarded against here:
//   - a decimal read as a question number ("4.3 to 4.6.")
//   - a mid-stem sentence that happens to start "1. "
//   - a page footer run onto the end of the previous line
//   - the chapter's own directions, which are a numbered list starting at 1

const CHOICE_LABELS = ['A', 'B', 'C', 'D', 'E'];

// A question opens a line and is followed by a space and real text.
const Q_START = /^(\d{1,3})\.\s+(?=\S)/;
const CHOICE_START = /^\(([A-E])\)\s*/;
// A bare 1-4 digit number at end of line is a page footer pdftotext ran on.
const TRAILING_FOOTER = /\s+\d{1,4}$/;

function joinLines(parts) {
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function finishText(parts) {
  return joinLines(parts).replace(TRAILING_FOOTER, '').trim();
}

// Seed the run at question `startAt`, and only where a lettered choice sits
// between it and question `startAt + 1`. The directions' numbered items have
// no choices between them, which separates them from real questions without
// guessing how many lines a stem may run to.
function findSeed(lines, startAt) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trimEnd().match(Q_START);
    if (!m || Number(m[1]) !== startAt) continue;
    let sawChoice = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trimEnd();
      if (CHOICE_START.test(l)) { sawChoice = true; break; }
      const nm = l.match(Q_START);
      if (nm && Number(nm[1]) === startAt + 1) break;
    }
    if (sawChoice) return i;
  }
  return -1;
}

function parseQuestions(lines, { startAt = 1 } = {}) {
  const questions = [];
  const warnings = [];

  const seed = findSeed(lines, startAt);
  if (seed < 0) return { questions, warnings: [`no question ${startAt} with choices found`] };

  let cur = null;                 // {number, stemParts, choices}
  let choiceParts = null;
  let choiceLabel = null;

  const flushChoice = () => {
    if (choiceLabel === null) return;
    cur.choices.push({ label: choiceLabel, text: finishText(choiceParts) });
    choiceLabel = null;
    choiceParts = null;
  };

  const flushQuestion = () => {
    if (!cur) return;
    flushChoice();
    const q = { number: cur.number, stem: finishText(cur.stemParts), choices: cur.choices };
    if (q.choices.length !== 5) {
      warnings.push(`question ${q.number}: ${q.choices.length} choices (expected 5)`);
    }
    if (!q.stem) warnings.push(`question ${q.number}: empty stem`);
    questions.push(q);
    cur = null;
  };

  for (let i = seed; i < lines.length; i++) {
    const line = lines[i].trimEnd();

    const qm = line.match(Q_START);
    // Only open a question when the number continues the printed run. A
    // sentence starting "1. " inside a stem does not.
    const expected = cur ? cur.number + 1 : startAt;
    if (qm && Number(qm[1]) === expected) {
      flushQuestion();
      cur = { number: expected, stemParts: [line.slice(qm[0].length)], choices: [] };
      continue;
    }
    if (!cur) continue;

    const cm = line.match(CHOICE_START);
    if (cm) {
      flushChoice();
      choiceLabel = cm[1];
      choiceParts = [line.slice(cm[0].length)];
      continue;
    }

    if (choiceLabel !== null) choiceParts.push(line);
    else cur.stemParts.push(line);
  }
  flushQuestion();

  return { questions, warnings };
}

module.exports = { parseQuestions, CHOICE_LABELS, findSeed };
