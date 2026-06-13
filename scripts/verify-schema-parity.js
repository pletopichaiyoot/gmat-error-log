// scripts/verify-schema-parity.js
require('dotenv').config();
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

const SQLITE_PATH = process.env.GMAT_DB_PATH || path.resolve(__dirname, '..', 'data', 'gmat-error-log.db');
// Tables expected in BOTH. Exclude transient lsat_attempts_v2 (never persists) and
// schema_migrations (pg-only). irt_cutoffs exists in both.
const TABLES = ['scrape_runs','sessions','question_attempts','irt_cutoffs','coach_sessions',
  'coach_messages','coach_memories','lsat_attempts','lsat_sessions','study_plan_tasks',
  'study_plan_days','study_plan_meta','mock_results'];

function sqliteCols(db, table) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, (err, rows) =>
      err ? reject(err) : resolve(rows.map((r) => r.name).sort()));
  });
}

(async () => {
  const db = new sqlite3.Database(SQLITE_PATH, sqlite3.OPEN_READONLY);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let failed = false;
  for (const t of TABLES) {
    const sCols = await sqliteCols(db, t);
    const pCols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`, [t]
    )).rows.map((r) => r.column_name).sort();
    const missingInPg = sCols.filter((c) => !pCols.includes(c));
    const extraInPg = pCols.filter((c) => !sCols.includes(c));
    if (missingInPg.length || extraInPg.length) {
      failed = true;
      console.error(`MISMATCH ${t}: missing-in-pg=[${missingInPg}] extra-in-pg=[${extraInPg}]`);
    } else {
      console.log(`OK ${t} (${pCols.length} cols)`);
    }
  }
  db.close();
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
