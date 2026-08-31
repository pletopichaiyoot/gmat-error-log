// Canonicalizer for question_attempts.mistake_type.
//
// The tag vocabulary is defined by MISTAKE_TYPES in client/src/App.jsx — three
// orthogonal dimensions (cause / trap / timing-process). This module is the
// backend enforcement of that vocabulary on the WRITE path.
//
// Why it's needed on writes and not just as a one-time migration: Target Test
// Prep is authoritative for mistake_type (see CLAUDE.md — TTP prompts the user
// to tag each error from its own fixed taxonomy, so a rescrape should win over
// the stored value). But TTP's taxonomy is plain-English sentences
// ("I misread / misinterpreted the question."), which are not picker tags. Left
// alone, every TTP scrape reintroduces out-of-vocabulary values and re-fragments
// the tag distribution. migrations/0005_normalize_mistake_tags.sql cleans history;
// this keeps it clean going forward. The two must stay in sync — the legacy map
// below is the same map, in JS.
//
// Unknown tags are preserved verbatim rather than dropped, so an annotation is
// never silently lost; they just sort last and won't appear pre-selected in the
// picker.

// Canonical vocabulary, in the picker's own dimension order. Array order IS the
// serialization order: writing tag sets in a deterministic order is what makes
// ["Misread","Wrong Setup"] and ["Wrong Setup","Misread"] stop counting as two
// different values in any GROUP BY over the raw column.
const CANONICAL_ORDER = [
  // Why I Missed It — the on-the-merits cause
  'Misread',
  'Modifier/Connective Miss',
  'Concept Gap',
  'Wrong Setup',
  'Logic Slip',
  'Calc/Casework Slip',
  // Trap Type — what the wrong answer was doing. v4 (2026-08-23): Manhattan
  // Prep's trap vocabulary (GMAT All the Verbal, RC ch. 13–14 + CR ch. 18–22).
  // Old v3 names fold via the legacy map below; stored rows were rewritten by
  // migrations/0006_manhattan_trap_names.sql.
  'Trap: One Word Off',
  'Trap: Extreme',
  'Trap: Out of Scope',
  'Trap: True but Not Right',
  'Trap: Reverse Logic',
  'Trap: Mix-Up',
  'Trap: Real-World Distraction',
  'Trap: No Tie to Argument',
  'Trap: Premise Repeat',
  // Timing & Process — the clock decision or workflow failure
  'No Plan / Stuck',
  'Chose Too Early / Rushed-Guess',
  // NOTE: U+00D7 MULTIPLICATION SIGN, matching the picker byte-for-byte. The
  // ASCII-'x' spelling is a legacy variant and lives in the map below.
  'Overinvested (>2× median)',
  'Ran Out of Time',
];

const CANONICAL = new Set(CANONICAL_ORDER);
const RANK = new Map(CANONICAL_ORDER.map((tag, i) => [tag, i]));
const UNKNOWN_RANK = 900;

// Legacy value -> canonical tag. `null` means drop the tag entirely.
const LEGACY_TO_CANONICAL = {
  // ---- Misread ----
  'Misread (Passage / Question / Condition)': 'Misread',
  'Misread Passage': 'Misread',
  'Misread Question': 'Misread',
  'Misread Condition': 'Misread',
  'Chart/Table Misread': 'Misread',
  'Missed Negation/Qualifier': 'Misread',
  'CR: Missed Negation/Qualifier': 'Misread',
  'MSR: Missed Cross-Source Link': 'Misread',
  'Multi-Source: Missed Cross-Link': 'Misread',
  'I misread / misinterpreted the question.': 'Misread',
  'I failed to use all of the information provided to me in the stem.': 'Misread',

  // ---- Concept Gap ----
  'Conceptual Gap': 'Concept Gap',
  'I did not understand the concept tested.': 'Concept Gap',

  // ---- Wrong Setup ----
  'Wrong Setup (Variable / Equation / Structure)': 'Wrong Setup',
  'Wrong Variable Setup': 'Wrong Setup',
  'Failed to Translate': 'Wrong Setup',
  'Two-Part: Pairing/Order Error': 'Wrong Setup',
  'Wrong Order-Pairing': 'Wrong Setup',
  'Composite / Multi-Select: Wrong Slot': 'Wrong Setup',
  'I understood the concept tested but failed to properly apply it.': 'Wrong Setup',

  // ---- Logic Slip ----
  'Logic Breakdown': 'Logic Slip',
  'Logic Breakdown (Wrong Inference or Relationship)': 'Logic Slip',
  'Wrong Logical Relationship': 'Logic Slip',
  'Invalid Assumption': 'Logic Slip',
  'RC Trap: Wrong Paragraph': 'Logic Slip',
  'CR: Confused Author Tone': 'Logic Slip',

  // ---- Calc/Casework Slip ----
  'Calculation Slip (Computation / Unit / Sign / Careless)': 'Calc/Casework Slip',
  'Calculation Error': 'Calc/Casework Slip',
  'Careless / Sloppy Error': 'Calc/Casework Slip',
  'Incomplete Casework': 'Calc/Casework Slip',
  'Unit-Scale': 'Calc/Casework Slip',
  'Sign-Direction': 'Calc/Casework Slip',
  'I made a careless math mistake.': 'Calc/Casework Slip',
  'I got so excited when I figured out how to answer the question that I made a careless error.':
    'Calc/Casework Slip',

  // ---- Trap Type ----
  // Pre-v3 names, re-pointed at the v4 (Manhattan) vocabulary.
  'RC Trap: Too Extreme': 'Trap: Extreme',
  'RC Trap: Out of Scope': 'Trap: Out of Scope',
  'CR: Scope Shift (Premise vs Conclusion)': 'Trap: Out of Scope',
  'RC Trap: Half-Right': 'Trap: One Word Off',
  'RC Trap: Opposite Direction': 'Trap: Reverse Logic',
  'I fell for a trap answer.': 'Trap: Real-World Distraction',
  // v3 canonical names retired 2026-08-23 in favor of Manhattan Prep's trap
  // vocabulary. 'Trap: Scope/Strength' lumped two different tells (unsupported
  // strength vs. beyond-the-text scope); the generic fallback is Out of Scope,
  // and migration 0006 split the handful of tagged rows by their notes.
  'Trap: Scope/Strength': 'Trap: Out of Scope',
  'Trap: Half-Right': 'Trap: One Word Off',
  'Trap: Reversed': 'Trap: Reverse Logic',
  'Trap: Plausible-but-Unstated': 'Trap: Real-World Distraction',
  'Trap: True-but-Irrelevant': 'Trap: True but Not Right',
  'Trap: Distortion/Familiar-Language': 'Trap: Mix-Up',

  // ---- Timing & Process ----
  'Could Not Start / No Plan': 'No Plan / Stuck',
  'Stuck in Algebra': 'No Plan / Stuck',
  'Re-read Loop (Got Stuck Re-reading)': 'No Plan / Stuck',
  'My written work was unorganized and difficult to follow.': 'No Plan / Stuck',
  'Chose Too Early': 'Chose Too Early / Rushed-Guess',
  'Rushed Guess': 'Chose Too Early / Rushed-Guess',
  'Overinvested Time': 'Overinvested (>2× median)',
  'Overinvested Time (>2x median)': 'Overinvested (>2× median)',
  'Overinvested (>2x median)': 'Overinvested (>2× median)',
  'I spent too much time on the question but answered it correctly': 'Overinvested (>2× median)',
  'Ran Out / Near-blank': 'Ran Out of Time',
  'I ran out of time.': 'Ran Out of Time',

  // ---- Dropped: not mistake causes ----
  'Pre-phrase Mismatch (Skipped Pre-phrasing)': null,
  // A self-report on a CORRECT answer, not an error tag. Dropping it also stops
  // a TTP rescrape from overwriting a real annotation with it.
  'I guessed correctly': null,

  // Legacy 'Time Trap' is deliberately absent: it lumped "too fast" and
  // "too slow", which have opposite fixes, and the direction can only be
  // recovered from the clock (migration 0005 does that with the per-subject
  // median). On the write path it's preserved verbatim rather than guessed.
};

// Accepts a JSON-array string, a bare single-tag string, or an actual array.
function parseMistakeTags(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.filter((x) => typeof x === 'string' && x.trim());
  }
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed || trimmed === '[]') return [];
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        return arr.filter((x) => typeof x === 'string' && x.trim());
      }
    } catch {
      // Malformed: treat the whole value as one literal tag rather than lose it.
    }
    return [trimmed];
  }
  return [trimmed];
}

// Map -> de-dupe -> sort into canonical order. Unknown tags sort last, keeping
// their relative input order.
function canonicalizeMistakeTags(value) {
  const seen = [];
  for (const raw of parseMistakeTags(value)) {
    const tag = raw.trim();
    if (!tag) continue;
    let mapped;
    if (CANONICAL.has(tag)) {
      mapped = tag;
    } else if (Object.prototype.hasOwnProperty.call(LEGACY_TO_CANONICAL, tag)) {
      mapped = LEGACY_TO_CANONICAL[tag];
      if (mapped === null) continue;
    } else {
      mapped = tag;
    }
    if (!seen.includes(mapped)) seen.push(mapped);
  }
  return seen
    .map((tag, i) => ({ tag, i }))
    .sort((a, b) => {
      const ra = RANK.has(a.tag) ? RANK.get(a.tag) : UNKNOWN_RANK;
      const rb = RANK.has(b.tag) ? RANK.get(b.tag) : UNKNOWN_RANK;
      return ra - rb || a.i - b.i;
    })
    .map((entry) => entry.tag);
}

// Storage form: a JSON-array string, or null when there's nothing to store.
// Always an array even for a single tag, so readers never have to special-case
// the bare-string shape the old serializer produced.
function serializeMistakeTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  if (list.length === 0) return null;
  return JSON.stringify(list);
}

// Convenience: raw stored/scraped value in, canonical stored value out.
function canonicalizeMistakeTypeValue(value) {
  return serializeMistakeTags(canonicalizeMistakeTags(value));
}

module.exports = {
  CANONICAL_ORDER,
  CANONICAL_TAGS: CANONICAL,
  LEGACY_TO_CANONICAL,
  parseMistakeTags,
  canonicalizeMistakeTags,
  serializeMistakeTags,
  canonicalizeMistakeTypeValue,
};
