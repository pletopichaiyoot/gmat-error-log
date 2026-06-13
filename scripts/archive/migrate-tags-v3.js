// One-time migration: convert v1/v2 mistake_type tags to the lean v3
// 11-tag taxonomy defined in client/src/App.jsx (2026-05-26).
//
// Reads each row's mistake_type (JSON array or single string), maps every
// legacy value to its v3 equivalent (or set), de-dupes, and writes back.
// Unknown tags are preserved as-is so we never silently lose annotations.
//
// Run with:
//   node scripts/migrate-tags-v3.js            # dry-run: prints counts + diff
//   node scripts/migrate-tags-v3.js --apply    # actually writes
//
// IMPORTANT: Make a DB backup before --apply. The script also creates one
// automatically at data/gmat-error-log.db.bak-tags-v3-<timestamp>.

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const APPLY = process.argv.includes('--apply');
const dbPath = path.resolve(__dirname, '..', 'data', 'gmat-error-log.db');

// Legacy tag -> v3 tag (or array of v3 tags for one-to-many)
const TAG_MAP = {
  // ---- Cognitive: Misread ----
  'Misread (Passage / Question / Condition)': 'Misread',
  'Misread Passage': 'Misread',
  'Misread Question': 'Misread',
  'Misread Condition': 'Misread',
  'I misread / misinterpreted the question.': 'Misread',
  'Missed Negation/Qualifier': 'Misread',
  'CR: Missed Negation/Qualifier': 'Misread',
  'Chart/Table Misread': 'Misread',
  'MSR: Missed Cross-Source Link': 'Misread',
  'Multi-Source: Missed Cross-Link': 'Misread',
  'I failed to use all of the information provided to me in the stem.': 'Misread',

  // ---- Cognitive: Concept Gap (restored in v3) ----
  'I did not understand the concept tested.': 'Concept Gap',
  'Conceptual Gap': 'Concept Gap',

  // ---- Cognitive: Wrong Setup ----
  'Wrong Setup (Variable / Equation / Structure)': 'Wrong Setup',
  'Wrong Variable Setup': 'Wrong Setup',
  'Failed to Translate': 'Wrong Setup',
  'Two-Part: Pairing/Order Error': 'Wrong Setup',
  'Wrong Order-Pairing': 'Wrong Setup',
  'Composite / Multi-Select: Wrong Slot': 'Wrong Setup',
  'I understood the concept tested but failed to properly apply it.': 'Wrong Setup',

  // ---- Cognitive: Logic Slip ----
  'Logic Breakdown': 'Logic Slip',
  'Logic Breakdown (Wrong Inference or Relationship)': 'Logic Slip',
  'Wrong Logical Relationship': 'Logic Slip',
  'Invalid Assumption': 'Logic Slip',
  'RC Trap: Wrong Paragraph': 'Logic Slip',
  'CR: Confused Author Tone': 'Logic Slip',

  // ---- Cognitive: Calc/Casework Slip ----
  'Calculation Slip (Computation / Unit / Sign / Careless)': 'Calc/Casework Slip',
  'Calculation Error': 'Calc/Casework Slip',
  'Careless / Sloppy Error': 'Calc/Casework Slip',
  'I made a careless math mistake.': 'Calc/Casework Slip',
  'I got so excited when I figured out how to answer the question that I made a careless error.':
    'Calc/Casework Slip',
  'Incomplete Casework': 'Calc/Casework Slip',
  'Unit-Scale': 'Calc/Casework Slip',
  'Sign-Direction': 'Calc/Casework Slip',

  // ---- Trap Type ----
  'RC Trap: Too Extreme': 'Trap: Scope/Strength',
  'RC Trap: Out of Scope': 'Trap: Scope/Strength',
  'CR: Scope Shift (Premise vs Conclusion)': 'Trap: Scope/Strength',
  'RC Trap: Half-Right': 'Trap: Half-Right',
  'RC Trap: Opposite Direction': 'Trap: Reversed',
  // Legacy generic "trap" mention — most likely the world-knowledge leak case
  'I fell for a trap answer.': 'Trap: Plausible-but-Unstated',

  // ---- Process / Fix-it ----
  'Could Not Start / No Plan': 'No Plan / Stuck',
  'Stuck in Algebra': 'No Plan / Stuck',
  'Re-read Loop (Got Stuck Re-reading)': 'No Plan / Stuck',
  'My written work was unorganized and difficult to follow.': 'No Plan / Stuck',
  'Chose Too Early': 'Time Trap',
  'Overinvested Time (>2x median)': 'Time Trap',
  'Overinvested Time': 'Time Trap',
  'Rushed Guess': 'Time Trap',
  'I ran out of time.': 'Time Trap',
  'I spent too much time on the question but answered it correctly': 'Time Trap',

  // ---- Explicitly dropped in v3 (no replacement) ----
  'Pre-phrase Mismatch (Skipped Pre-phrasing)': null,
  'I guessed correctly': null, // not a mistake tag — a self-report on a correct answer
};

// Final v3 tag set (for validation reporting)
const V3_TAGS = new Set([
  'Misread', 'Modifier/Connective Miss', 'Concept Gap', 'Wrong Setup', 'Logic Slip', 'Calc/Casework Slip',
  'Trap: Scope/Strength', 'Trap: Half-Right', 'Trap: Reversed', 'Trap: Plausible-but-Unstated',
  'No Plan / Stuck', 'Time Trap',
]);

function parseTags(value) {
  if (value == null) return [];
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()) : [];
    } catch {
      return [trimmed];
    }
  }
  return [trimmed];
}

function mapTags(oldTags) {
  const out = new Set();
  const unknown = [];
  for (const t of oldTags) {
    const trimmed = t.trim();
    if (!trimmed) continue;
    if (V3_TAGS.has(trimmed)) {
      out.add(trimmed);
      continue;
    }
    if (trimmed in TAG_MAP) {
      const mapped = TAG_MAP[trimmed];
      if (mapped === null) continue; // explicitly dropped
      if (Array.isArray(mapped)) mapped.forEach((m) => out.add(m));
      else out.add(mapped);
      continue;
    }
    unknown.push(trimmed);
    out.add(trimmed); // preserve unknown tags as-is
  }
  return { mapped: [...out], unknown };
}

function serialize(tags) {
  // Match the existing storage convention: JSON-array string when >1, raw string when 1, '' when 0.
  if (tags.length === 0) return '';
  if (tags.length === 1) return tags[0];
  return JSON.stringify(tags);
}

const all = (db, sql, params = []) =>
  new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
const run = (db, sql, params = []) =>
  new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    })
  );

(async () => {
  if (APPLY) {
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const backup = `${dbPath}.bak-tags-v3-${ts}`;
    fs.copyFileSync(dbPath, backup);
    console.log(`[migrate-tags-v3] backup -> ${backup}`);
  }

  const db = new sqlite3.Database(dbPath);
  const rows = await all(
    db,
    `SELECT id, mistake_type FROM question_attempts
     WHERE mistake_type IS NOT NULL AND TRIM(mistake_type) != '' AND TRIM(mistake_type) != '[]'`
  );
  console.log(`[migrate-tags-v3] candidate rows: ${rows.length} (mode: ${APPLY ? 'APPLY' : 'dry-run'})`);

  const beforeCounts = new Map();
  const afterCounts = new Map();
  const unknownSet = new Map(); // tag -> count
  let changedCount = 0;
  const samples = [];

  for (const row of rows) {
    const before = parseTags(row.mistake_type);
    before.forEach((t) => beforeCounts.set(t, (beforeCounts.get(t) || 0) + 1));
    const { mapped, unknown } = mapTags(before);
    mapped.forEach((t) => afterCounts.set(t, (afterCounts.get(t) || 0) + 1));
    unknown.forEach((t) => unknownSet.set(t, (unknownSet.get(t) || 0) + 1));

    const oldSer = row.mistake_type;
    const newSer = serialize(mapped);
    if (oldSer !== newSer) {
      changedCount += 1;
      if (samples.length < 8) samples.push({ id: row.id, before, after: mapped });
      if (APPLY) {
        await run(db, `UPDATE question_attempts SET mistake_type = ? WHERE id = ?`, [newSer, row.id]);
      }
    }
  }

  console.log(`\n=== BEFORE (legacy tag counts) ===`);
  for (const [t, n] of [...beforeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${t}`);
  }
  console.log(`\n=== AFTER (v3 tag counts) ===`);
  for (const [t, n] of [...afterCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const flag = V3_TAGS.has(t) ? '   ' : '(?)';
    console.log(`  ${flag} ${String(n).padStart(4)}  ${t}`);
  }
  if (unknownSet.size) {
    console.log(`\n=== UNKNOWN tags (preserved as-is) ===`);
    for (const [t, n] of [...unknownSet.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${t}`);
    }
  }
  console.log(`\n=== SAMPLE DIFFS ===`);
  for (const s of samples) {
    console.log(`  id=${s.id}`);
    console.log(`    before: ${JSON.stringify(s.before)}`);
    console.log(`    after:  ${JSON.stringify(s.after)}`);
  }
  console.log(`\n[migrate-tags-v3] rows changed: ${changedCount}${APPLY ? '' : ' (dry-run, not written)'}`);

  db.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
