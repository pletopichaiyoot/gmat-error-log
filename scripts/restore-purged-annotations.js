#!/usr/bin/env node
// Restore mistake_type + notes that were silently purged when Phase 1 re-scrape
// happened after Phase 2 enrichment (the q_id mutation bug). q_code is stable
// across scrapers, so we use it as the recovery key.
//
// POST-MIGRATION NOTE: the live DB is now Postgres (writes go through a pg Pool,
// connection from DATABASE_URL). The backup SOURCE is still a SQLite snapshot
// file (`data/gmat-error-log.db.bak-*`) opened read-only — those snapshots were
// taken before the Postgres cutover, so we read them with sqlite3.
//
// Sources: any SQLite DB backup file. Defaults to the most recent .bak file.
//
// Usage:
//   node scripts/restore-purged-annotations.js [path-to-backup.db] [--apply]

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (check .env). The live DB is Postgres; cannot continue.');
  process.exit(1);
}

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const explicit = args.find((a) => !a.startsWith('--'));

function pickBackup() {
  if (explicit) return path.resolve(explicit);
  const baks = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith('gmat-error-log.db.bak'))
    .map((f) => path.join(DATA_DIR, f));
  baks.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return baks[0];
}

const BAK_PATH = pickBackup();
if (!BAK_PATH || !fs.existsSync(BAK_PATH)) {
  console.error('No backup file found.');
  process.exit(1);
}

// SOURCE: SQLite backup snapshot, read-only.
const bakDb = new sqlite3.Database(BAK_PATH, sqlite3.OPEN_READONLY);
// DESTINATION: live Postgres DB.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sqliteAll = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

(async () => {
  const bakRows = await sqliteAll(
    bakDb,
    `SELECT q_id, q_code, time_sec, mistake_type, notes
     FROM question_attempts
     WHERE ((mistake_type IS NOT NULL AND mistake_type != '')
         OR (notes IS NOT NULL AND notes != ''))`
  );

  console.log(`Backup: ${path.basename(BAK_PATH)}`);
  console.log(`Backup annotated rows: ${bakRows.length}`);

  const restores = [];
  const ambiguous = [];

  // Match strategy:
  //   - If backup q_id is gc-att-* (GMAT Club, stable across scrapes): match by q_id.
  //   - Else: match by (q_code, time_sec), skipping if not exactly one match
  //     (StartTest q_id changed between backup and current; q_code+time_sec is
  //     the only safe uniqueness key without re-scraping).
  for (const b of bakRows) {
    let curRows;
    if (b.q_id && b.q_id.startsWith('gc-att-')) {
      const { rows } = await pool.query(
        `SELECT id, mistake_type, notes FROM question_attempts WHERE q_id = $1`,
        [b.q_id]
      );
      curRows = rows;
    } else if (b.q_code) {
      const { rows } = await pool.query(
        `SELECT id, mistake_type, notes FROM question_attempts WHERE q_code = $1 AND COALESCE(time_sec, -1) = COALESCE($2, -1)`,
        [b.q_code, b.time_sec]
      );
      curRows = rows;
    } else {
      continue;
    }
    if (!curRows.length) continue;
    if (curRows.length > 1) {
      ambiguous.push({ q_id: b.q_id, q_code: b.q_code, time_sec: b.time_sec, count: curRows.length });
      continue;
    }
    const row = curRows[0];
    const lostMistake = !!(b.mistake_type) && !row.mistake_type;
    const lostNotes = !!(b.notes) && !row.notes;
    if (!lostMistake && !lostNotes) continue;
    restores.push({
      id: row.id,
      q_id: b.q_id,
      q_code: b.q_code,
      new_mistake: lostMistake ? b.mistake_type : null,
      new_notes: lostNotes ? b.notes : null,
    });
  }

  console.log(`\nWill restore ${restores.length} row(s):`);
  for (const r of restores) {
    console.log(`  id=${r.id} q_code=${r.q_code} q_id=${r.q_id}`);
    if (r.new_mistake) console.log(`    mistake_type ← ${r.new_mistake}`);
    if (r.new_notes) {
      const noteSnip = r.new_notes.replace(/\n/g, ' ').slice(0, 70);
      console.log(`    notes        ← ${noteSnip}${(r.new_notes.length > 70 ? '…' : '')}`);
    }
  }

  if (ambiguous.length) {
    console.log(`\n${ambiguous.length} backup row(s) skipped (multiple live rows match — ambiguous):`);
    for (const a of ambiguous.slice(0, 10)) {
      console.log(`  q_code=${a.q_code} time_sec=${a.time_sec} → ${a.count} matches`);
    }
  }

  if (!APPLY) {
    console.log('\n[dry run] pass --apply to write changes');
    bakDb.close();
    await pool.end();
    return;
  }

  console.log('\nApplying...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let applied = 0;
    for (const r of restores) {
      let result;
      if (r.new_mistake && r.new_notes) {
        result = await client.query('UPDATE question_attempts SET mistake_type = $1, notes = $2 WHERE id = $3', [r.new_mistake, r.new_notes, r.id]);
      } else if (r.new_mistake) {
        result = await client.query('UPDATE question_attempts SET mistake_type = $1 WHERE id = $2', [r.new_mistake, r.id]);
      } else if (r.new_notes) {
        result = await client.query('UPDATE question_attempts SET notes = $1 WHERE id = $2', [r.new_notes, r.id]);
      }
      if (result) applied += result.rowCount;
    }
    await client.query('COMMIT');
    console.log(`Restored ${applied} row(s).`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed, rolled back:', err.message);
    client.release();
    bakDb.close();
    await pool.end();
    process.exit(1);
  }
  client.release();
  bakDb.close();
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
