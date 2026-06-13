// scripts/migrate-sqlite-to-pg.js
// One-time copy of the live SQLite DB into Postgres. Idempotent guard: refuses to
// run unless target tables are empty (override with --force after db:reset).
require('dotenv').config();
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const { toTimestamptz } = require('../src/sql-util');

const SQLITE_PATH = process.env.GMAT_DB_PATH || path.resolve(__dirname, '..', 'data', 'gmat-error-log.db');
const FORCE = process.argv.includes('--force');

// FK dependency order. irt_cutoffs (rebuildable) and lsat_attempts_v2 (transient) skipped.
const TABLES = ['scrape_runs','sessions','question_attempts','coach_sessions','coach_messages',
  'coach_memories','lsat_sessions','lsat_attempts','study_plan_tasks','study_plan_days',
  'study_plan_meta','mock_results'];

// Tables whose id is GENERATED ALWAYS AS IDENTITY — explicit id inserts need OVERRIDING SYSTEM VALUE.
const ALWAYS_IDENTITY = new Set(['scrape_runs','sessions','question_attempts','coach_messages',
  'lsat_attempts','lsat_sessions','mock_results']);

const TS_COLS = new Set(['created_at','updated_at','extracted_at','completed_at','attempted_at','started_at']);
const DATE_COLS = new Set(['session_date']);

const sAll = (db, sql) => new Promise((res, rej) => db.all(sql, (e, r) => e ? rej(e) : res(r)));
const sCols = (db, t) => sAll(db, `PRAGMA table_info(${t})`).then((r) => r.map((c) => c.name));

function transform(col, v) {
  if (v === undefined) v = null;
  if (TS_COLS.has(col)) return toTimestamptz(v);
  if (DATE_COLS.has(col)) {
    if (v == null || v === '') return null;
    const m = String(v).match(/^\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : null;
  }
  return v; // text/int/json pass through verbatim; '' sentinels preserved
}

async function main() {
  const db = new sqlite3.Database(SQLITE_PATH, sqlite3.OPEN_READONLY);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  if (!FORCE) {
    for (const t of TABLES) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
      if (rows[0].n > 0) throw new Error(`target ${t} not empty (n=${rows[0].n}); use --force after db:reset`);
    }
  }

  const counts = {};
  for (const t of TABLES) {
    const cols = await sCols(db, t);
    const srcRows = await sAll(db, `SELECT * FROM ${t}`);
    const overriding = ALWAYS_IDENTITY.has(t) ? 'OVERRIDING SYSTEM VALUE ' : '';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of srcRows) {
        const vals = cols.map((c) => transform(c, row[c]));
        const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(
          `INSERT INTO ${t} (${cols.join(', ')}) ${overriding}VALUES (${ph})`, vals
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`load ${t} failed: ${e.message}`);
    } finally {
      client.release();
    }
    counts[t] = srcRows.length;
    console.log(`loaded ${t}: ${srcRows.length}`);
  }

  // Resync IDENTITY sequences to MAX(id) so future auto-inserts don't collide with copied ids.
  const IDENTITY_TABLES = ['scrape_runs','sessions','question_attempts','coach_messages',
    'lsat_attempts','lsat_sessions','study_plan_tasks','mock_results'];
  for (const t of IDENTITY_TABLES) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('${t}','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM ${t}), 1))`
    );
  }

  // Verify counts match the SQLite source.
  let mismatch = false;
  for (const t of TABLES) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
    if (rows[0].n !== counts[t]) {
      mismatch = true;
      console.error(`COUNT MISMATCH ${t}: sqlite=${counts[t]} pg=${rows[0].n}`);
    }
  }
  db.close();
  await pool.end();
  if (mismatch) process.exit(1);
  console.log('ETL complete, counts verified');
}

main().catch((e) => { console.error(e); process.exit(1); });
