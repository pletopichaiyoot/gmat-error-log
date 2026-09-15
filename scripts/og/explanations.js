// scripts/og/explanations.js
// The answer-explanations region carries, per question: the question repeated,
// an official type label, a reasoning block, one rationale per choice with
// exactly one opening "Correct.", and usually a closing "The correct answer
// is X." Those last two are two independent readings of the same key.
//
// Entries are segmented on the TYPE LABEL, not on question numbers. Measured
// across the three books, labels survive the scans almost perfectly (124/124
// for OG13 CR, 83/83 for VR2 CR) while question numbers do not — OG13's CR
// explanations keep 97 of 124, VR2's RC 81 of 104 — so numbering was the wrong
// thing to hang segmentation on.
//
// The scans also drop the letter in front of a rationale, leaving a bare
// "Correct." (120 of OG13 CR's 124 entries). The letter is then recovered from
// the rationale's position in the A-E run.
//
// The region also carries the RC passage grouping, which appears nowhere else:
//   "Questions 1-3 refer to the passage on page 358."

const { squash } = require('./text');

const TYPE_LABELS = [
  'Argument Construction',
  'Argument Evaluation',
  'Evaluation of a Plan',
  'Evaluation',
  'Inference',
  'Main idea',
  'Supporting ideas',
  'Logical structure',
  'Application',
  'Style and tone',
];

// Singular/plural variants the books use interchangeably.
const LABEL_ALIASES = new Map([
  ['supportingidea', 'Supporting ideas'],
  ['inferences', 'Inference'],
  ['mainideas', 'Main idea'],
]);

const LABEL_BY_KEY = new Map(TYPE_LABELS.map(l => [squash(l), l]));
const LETTERS = ['A', 'B', 'C', 'D', 'E'];

function canonicalTypeLabel(raw) {
  const line = String(raw).trim();
  // A label is a short line on its own — never a rationale or a sentence.
  if (line.length > 40) return null;
  const k = squash(line);
  return LABEL_BY_KEY.get(k) || LABEL_ALIASES.get(k) || null;
}

const Q_START = /^(\d{1,3})\.\s+(?=\S)/;
const NOTE_START = /^([A-E])\s+(?=\S)/;
const BARE_CORRECT = /^Correct\./i;
const SITUATION = /^Situation\s+/;
const REASONING = /^Reasoning\s+/;
// "The correct answer is B." — OG12 sometimes loses every space in this line,
// and a page footer may be glued to the end.
const CLOSING = /^the\s*correct\s*answer\s*is\s*([A-E])\b/i;
const CLOSING_SQUASHED = /^thecorrectansweris([A-E])/i;
// "Questions 1-3 refer to the passage on page 358." — also printed as
// "the passage above" on the page where the passage itself sits.
const PASSAGE_REF =
  /^Questions\s+(\d{1,3})\s*[-–—]\s*(\d{1,3})\s+refer to the passage(?:\s+on\s+page\s+(\d{1,4}))?/i;

function joinParts(parts) {
  const s = parts.join(' ').replace(/\s+/g, ' ').trim();
  return s || null;
}

function closingLetter(line) {
  const m = line.match(CLOSING) || line.match(CLOSING_SQUASHED);
  return m ? m[1].toUpperCase() : null;
}

// The body of one entry: everything from its type label up to the next one.
// Rationales run A-E in order, so a rationale whose letter the scan dropped
// takes the next letter in the run; an explicit letter resyncs the position.
function parseBody(lines, warnings, label) {
  const out = {
    situation: null, reasoning: null, choiceNotes: {},
    markerKey: null, closingKey: null,
  };
  // RC entries print no "Reasoning" prefix — the prose runs straight on from
  // the type label — so that is where unprefixed text goes by default.
  let bucket = 'reasoning';
  let noteLetter = null;
  let parts = [];
  let nextLetter = 0;
  // A bare "Correct." only tells us WHICH rationale is right if the run's
  // position is known. Without an explicit letter earlier in the entry,
  // assuming it is the first would be a confidently wrong key.
  let anchored = false;

  const flush = () => {
    const text = joinParts(parts);
    if (bucket === 'situation') out.situation = text;
    else if (bucket === 'reasoning') out.reasoning = joinParts([out.reasoning || '', text || '']);
    else if (bucket === 'note' && noteLetter) out.choiceNotes[noteLetter] = text;
    parts = [];
  };

  const startNote = (letter, rest) => {
    flush();
    bucket = 'note';
    noteLetter = letter;
    nextLetter = LETTERS.indexOf(letter) + 1;
    parts = [rest];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const close = closingLetter(line);
    if (close) { flush(); bucket = null; out.closingKey = close; continue; }

    if (SITUATION.test(line)) {
      flush(); bucket = 'situation'; parts = [line.replace(SITUATION, '')]; continue;
    }
    if (REASONING.test(line)) {
      flush(); bucket = 'reasoning'; out.reasoning = null;
      parts = [line.replace(REASONING, '')]; continue;
    }

    const nm = line.match(NOTE_START);
    if (nm && LETTERS.includes(nm[1])) {
      anchored = true;
      startNote(nm[1], line.slice(nm[0].length));
      continue;
    }
    if (BARE_CORRECT.test(line)) {
      // The scan dropped this rationale's letter; take the next in the run,
      // but only when an explicit letter has fixed where the run is.
      const letter = anchored ? LETTERS[nextLetter] : null;
      if (!letter) {
        out.unanchoredCorrect = true;
        parts.push(line);
        continue;
      }
      startNote(letter, line);
      continue;
    }

    parts.push(line);
  }
  flush();

  const marked = LETTERS.filter(L => BARE_CORRECT.test(out.choiceNotes[L] || ''));
  if (marked.length === 1) out.markerKey = marked[0];
  else if (marked.length > 1) {
    warnings.push(`${label}: ${marked.length} choices marked Correct.`);
  }
  return out;
}

function parseExplanations(lines) {
  const entries = [];
  const passageRefs = [];
  const warnings = [];

  // Passage references can sit anywhere in the region, so collect them first.
  lines.forEach(raw => {
    const m = raw.trim().match(PASSAGE_REF);
    if (m) {
      passageRefs.push({
        firstQuestion: Number(m[1]),
        lastQuestion: Number(m[2]),
        page: m[3] ? Number(m[3]) : null,
      });
    }
  });

  const labelAt = lines.map(l => canonicalTypeLabel(l));
  const labelIdx = [];
  labelAt.forEach((l, i) => { if (l) labelIdx.push(i); });

  for (let n = 0; n < labelIdx.length; n++) {
    const at = labelIdx[n];
    const end = n + 1 < labelIdx.length ? labelIdx[n + 1] : lines.length;
    // Search back only as far as the previous entry's label, so one entry's
    // number cannot be claimed by the next.
    const lower = n === 0 ? 0 : labelIdx[n - 1] + 1;

    // The question number, where the scan kept it, is the last numbered line
    // before this entry's label — the head of the stem the label follows.
    let number = null;
    for (let i = at - 1; i >= lower; i--) {
      const m = lines[i].trim().match(Q_START);
      if (m) { number = Number(m[1]); break; }
    }

    const position = n + 1;
    const label = `entry ${position}${number ? ` (printed ${number})` : ''}`;
    const body = parseBody(lines.slice(at + 1, end), warnings, label);

    let key = null, keySource = null;
    if (body.markerKey && body.closingKey) {
      if (body.markerKey === body.closingKey) { key = body.markerKey; keySource = 'both'; }
      else {
        warnings.push(`${label}: key sources disagree (Correct. says ` +
          `${body.markerKey}, closing line says ${body.closingKey})`);
      }
    } else if (body.markerKey) { key = body.markerKey; keySource = 'correct-marker'; }
    else if (body.closingKey) { key = body.closingKey; keySource = 'closing-line'; }
    else warnings.push(`${label}: no key found in explanation`);

    entries.push({
      position,
      number,
      typeLabel: labelAt[at],
      situation: body.situation,
      reasoning: body.reasoning,
      choiceNotes: body.choiceNotes,
      key,
      keySource,
    });
  }

  return { entries, passageRefs, warnings };
}

module.exports = { parseExplanations, TYPE_LABELS, canonicalTypeLabel };
