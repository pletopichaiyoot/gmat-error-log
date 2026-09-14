// scripts/og/explanations.js
// The answer-explanations region carries, per question: the question repeated,
// an official type label, a reasoning block, one rationale per choice with
// exactly one opening "Correct.", and usually a closing "The correct answer
// is X." Those last two are two independent readings of the same key and must
// agree. RC entries omit Situation/Reasoning and often the closing line.
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

function canonicalTypeLabel(raw) {
  const line = String(raw).trim();
  // A label is a short line on its own — never a rationale or a sentence.
  if (line.length > 40) return null;
  const k = squash(line);
  return LABEL_BY_KEY.get(k) || LABEL_ALIASES.get(k) || null;
}

const Q_START = /^(\d{1,3})\.\s+(?=\S)/;
const CHOICE_START = /^\(([A-E])\)\s*/;
const NOTE_START = /^([A-E])\s+(?=\S)/;
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

function parseExplanations(lines) {
  const entries = [];
  const passageRefs = [];
  const warnings = [];

  let cur = null;
  let bucket = null;   // 'stem' | 'situation' | 'reasoning' | 'note'
  let noteLetter = null;
  let parts = [];

  const flushBucket = () => {
    if (!cur || !bucket) return;
    const text = joinParts(parts);
    if (bucket === 'situation') cur.situation = text;
    else if (bucket === 'reasoning') cur.reasoning = joinParts([cur.reasoning || '', text || '']);
    else if (bucket === 'note') cur.choiceNotes[noteLetter] = text;
    parts = [];
  };

  const flushEntry = () => {
    if (!cur) return;
    flushBucket();

    const marked = Object.keys(cur.choiceNotes)
      .filter(L => /^Correct\./i.test(cur.choiceNotes[L] || ''));
    const markerKey = marked.length === 1 ? marked[0] : null;
    if (marked.length > 1) {
      warnings.push(`question ${cur.number}: ${marked.length} choices marked Correct.`);
    }

    const closingKey = cur.closingKey || null;
    let key = null, keySource = null;
    if (markerKey && closingKey) {
      if (markerKey === closingKey) { key = markerKey; keySource = 'both'; }
      else {
        warnings.push(`question ${cur.number}: key sources disagree ` +
          `(Correct. says ${markerKey}, closing line says ${closingKey})`);
      }
    } else if (markerKey) { key = markerKey; keySource = 'correct-marker'; }
    else if (closingKey) { key = closingKey; keySource = 'closing-line'; }
    else warnings.push(`question ${cur.number}: no key found in explanation`);

    if (!cur.typeLabel) warnings.push(`question ${cur.number}: no type label`);

    entries.push({
      number: cur.number,
      typeLabel: cur.typeLabel,
      situation: cur.situation,
      reasoning: cur.reasoning,
      choiceNotes: cur.choiceNotes,
      key,
      keySource,
    });
    cur = null;
    bucket = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const pref = line.match(PASSAGE_REF);
    if (pref) {
      passageRefs.push({
        firstQuestion: Number(pref[1]),
        lastQuestion: Number(pref[2]),
        page: pref[3] ? Number(pref[3]) : null,
      });
      continue;
    }

    const qm = line.match(Q_START);
    const expected = cur ? cur.number + 1 : null;
    // Inside a rationale a sentence can start "1. "; only a number continuing
    // the run opens the next entry.
    if (qm && (cur === null || Number(qm[1]) === expected)) {
      flushEntry();
      cur = {
        number: Number(qm[1]), typeLabel: null, situation: null,
        reasoning: null, choiceNotes: {}, closingKey: null,
      };
      bucket = 'stem'; parts = [];
      continue;
    }
    if (!cur) continue;

    const cm = line.match(CLOSING) || line.match(CLOSING_SQUASHED);
    if (cm) { flushBucket(); bucket = null; cur.closingKey = cm[1].toUpperCase(); continue; }

    const label = canonicalTypeLabel(line);
    if (label && !cur.typeLabel) {
      flushBucket();
      cur.typeLabel = label;
      // RC runs its reasoning as plain prose straight after the label.
      bucket = 'reasoning'; parts = [];
      continue;
    }

    if (SITUATION.test(line)) {
      flushBucket(); bucket = 'situation';
      parts = [line.replace(SITUATION, '')]; continue;
    }
    if (REASONING.test(line)) {
      flushBucket(); bucket = 'reasoning'; cur.reasoning = null;
      parts = [line.replace(REASONING, '')]; continue;
    }

    // Rationales only start once the type label has been seen; before that an
    // "(A) ..." line is the question's own choice being repeated.
    const nm = cur.typeLabel ? line.match(NOTE_START) : null;
    if (nm) {
      flushBucket(); bucket = 'note'; noteLetter = nm[1];
      parts = [line.slice(nm[0].length)]; continue;
    }

    if (CHOICE_START.test(line) && !cur.typeLabel) { parts.push(line); continue; }
    parts.push(line);
  }
  flushEntry();

  return { entries, passageRefs, warnings };
}

module.exports = { parseExplanations, TYPE_LABELS, canonicalTypeLabel };
