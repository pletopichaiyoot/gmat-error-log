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

// Lines that end whatever was being accumulated. Without these the last choice
// on an RC page ran on through the page footer, the next page's header and the
// following passage — one OG12 choice reached 3,100 characters.
const STOP = [
  /^Questions\s+\d{1,3}\s*[-\u2013\u2014]\s*\d{1,3}\s+refer/i,  // next passage's header
  /^Line$/,                                                    // gutter caption
  /^\(\d{1,2}\)$/,                                            // gutter line number
  /^\d{1,4}$/,                                                 // bare page number
];

function isStop(line) {
  return STOP.some(re => re.test(line));
}

// pdftotext sometimes merges the passage-group header onto the first line of
// the stem that follows it, so skipping whole matching lines is not enough.
const PASSAGE_REF_PREFIX =
  /^Questions\s+\d{1,3}\s*[-\u2013\u2014]\s*\d{1,3}\s+refer to the passage(?:\s+(?:above|below|on\s+page\s+\d{1,4}))?\.?\s*/i;

function stripPassageRef(text) {
  return String(text).replace(PASSAGE_REF_PREFIX, '').trim();
}
// How far the run may jump forward to absorb a question number the scanner
// lost. VR2 prints 104 RC questions but only 78 survive as "N." lines, so a
// strict run would stop at the first gap; a jump larger than this is a page
// number or a stray, not a lost question.
const MAX_NUMBER_GAP = 5;

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
function findSeeds(lines, startAt) {
  const seeds = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trimEnd().match(Q_START);
    if (!m) continue;
    // The scan can lose the first question's number outright (OG13 RC starts
    // at "4."), so the seed may be any number within the gap tolerance.
    const n = Number(m[1]);
    if (n < startAt || n > startAt + MAX_NUMBER_GAP) continue;
    let sawChoice = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trimEnd();
      if (CHOICE_START.test(l)) { sawChoice = true; break; }
      const nm = l.match(Q_START);
      if (nm && Number(nm[1]) === n + 1) break;
    }
    if (sawChoice) seeds.push({ index: i, number: n });
  }
  return seeds;
}

// pdftotext emits some question numbers alone on a line, the stem following
// on the next (a hanging indent the scan renders as its own text run). Rejoin
// them before parsing, or the question loses its number and merges upward.
const LONE_NUMBER = /^(\d{1,3})\.\s*$/;

function rejoinLoneNumbers(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(LONE_NUMBER);
    const next = lines[i + 1] !== undefined ? lines[i + 1].trim() : '';
    if (m && next && !LONE_NUMBER.test(next) && !CHOICE_START.test(next)) {
      out.push(`${m[1]}. ${next}`);
      i++;
    } else {
      out.push(lines[i]);
    }
  }
  return out;
}

function runFrom(lines, seed, startAt) {
  const questions = [];
  const warnings = [];
  const seedNumber = seed.number;
  if (seed.unnumbered) {
    warnings.push('no question numbers survived in this section; ' +
      'questions are segmented by their choice runs and numbered in order');
  }

  // The seed may be past startAt when the scan lost the opening numbers.
  if (seedNumber > startAt) {
    const missing = [];
    for (let k = startAt; k < seedNumber; k++) missing.push(k);
    warnings.push(`skipped question ${missing.join(', ')}: number not found in the text`);
  }

  let cur = null;                 // {number, stemParts, choices}
  let choiceParts = null;
  let choiceLabel = null;

  const flushChoice = () => {
    if (choiceLabel === null) return;
    // Keep the wrapped lines separately: if the next line turns out to be a
    // new question's (A), they are that question's stem, not this choice.
    cur.choices.push({
      label: choiceLabel,
      text: finishText(choiceParts),
      first: finishText(choiceParts.slice(0, 1)),
      carried: choiceParts.slice(1),
    });
    choiceLabel = null;
    choiceParts = null;
  };

  const flushQuestion = () => {
    if (!cur) return;
    flushChoice();
    const q = {
      number: cur.number,
      stem: stripPassageRef(finishText(cur.stemParts)),
      choices: cur.choices.map(({ label, text }) => ({ label, text })),
    };
    if (cur.numberInferred) q.numberInferred = true;
    if (q.choices.length !== 5) {
      warnings.push(`question ${q.number}: ${q.choices.length} choices (expected 5)`);
    }
    if (!q.stem) warnings.push(`question ${q.number}: empty stem`);
    questions.push(q);
    cur = null;
  };

  if (seed.unnumbered) {
    cur = { number: seedNumber, stemParts: [], choices: [], numberInferred: true };
  }

  // After a stop line nothing is accumulated until the next question or
  // choice begins: the material in between is passage text or page furniture.
  let limbo = false;

  for (let i = seed.index; i < lines.length; i++) {
    const line = lines[i].trimEnd();

    if (isStop(line)) {
      flushChoice();
      limbo = true;
      continue;
    }

    const qm = line.match(Q_START);
    // Only open a question when the number continues the printed run — a
    // sentence starting "1. " inside a stem does not — allowing a short jump
    // forward for numbers the scanner lost.
    const expected = cur ? cur.number + 1 : seedNumber;
    const n = qm ? Number(qm[1]) : null;
    if (qm && n >= expected && n <= expected + MAX_NUMBER_GAP) {
      limbo = false;
      flushQuestion();
      if (n > expected) {
        const missing = [];
        for (let k = expected; k < n; k++) missing.push(k);
        warnings.push(`skipped question ${missing.join(', ')}: number not found in the text`);
      }
      cur = { number: n, stemParts: [line.slice(qm[0].length)], choices: [] };
      continue;
    }
    if (!cur) continue;

    const cm = line.match(CHOICE_START);
    if (cm) {
      limbo = false;
      // A choice run restarting at (A) means the previous question ended, even
      // when its successor's number did not survive the scan. Without this one
      // question swallows every question after it.
      if (cm[1] === 'A' && cur.choices.length > 0) {
        flushChoice();
        // Whatever followed the previous question's last choice is the next
        // question's stem: the closed choice keeps only its own first line.
        const last = cur.choices[cur.choices.length - 1];
        const carried = last.carried || [];
        // Those lines are the next stem, so they have to LEAVE this choice —
        // copying them out while leaving them behind glued the following
        // question onto choice E.
        if (carried.length) last.text = last.first;
        const number = cur.number + 1;
        flushQuestion();
        cur = { number, stemParts: carried, choices: [], numberInferred: true };
      }
      flushChoice();
      choiceLabel = cm[1];
      choiceParts = [line.slice(cm[0].length)];
      continue;
    }

    if (limbo) continue;
    if (choiceLabel !== null) choiceParts.push(line);
    else cur.stemParts.push(line);
  }
  flushQuestion();

  return { questions, warnings };
}

// Several lines can look like a plausible opening question: the chapter's own
// directions are a numbered list, and a stem may contain a numbered claim.
// Rather than guess with a sharper heuristic, run from each candidate and keep
// whichever parse actually recovers the most complete questions.
function parseQuestions(rawLines, { startAt = 1 } = {}) {
  const lines = rejoinLoneNumbers(rawLines);
  let seeds = findSeeds(lines, startAt);
  if (seeds.length === 0) {
    // A scan can lose every question number in a section (OG13 CR's redone
    // layer does). The choice runs are then the only structure left, so start
    // at the first one and let the (A)-restart rule segment the rest.
    const firstRun = lines.findIndex(l => /^\(A\)\s/.test(l.trimEnd()));
    if (firstRun < 0) {
      return { questions: [], warnings: [`no question ${startAt} with choices found`] };
    }
    let stemStart = firstRun;
    while (stemStart > 0 && lines[stemStart - 1].trim() !== '') stemStart--;
    seeds = [{ index: stemStart, number: startAt, unnumbered: true }];
  }

  // Score: most complete questions, then most questions, then the seed
  // nearest the expected opening number — the last breaks the tie between a
  // directions item and the real question 1, which can parse equally well.
  let best = null;
  let bestScore = null;
  const better = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  for (const seed of seeds) {
    const run = runFrom(lines, seed, startAt);
    const full = run.questions.filter(q => q.choices.length === 5).length;
    const score = [full, run.questions.length, -seed.number];
    if (!bestScore || better(score, bestScore)) {
      best = run;
      bestScore = score;
    }
  }
  return best;
}

module.exports = { parseQuestions, CHOICE_LABELS, findSeeds };
