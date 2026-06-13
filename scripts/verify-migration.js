// scripts/verify-migration.js
// Exercises the main read paths against Postgres on the REAL migrated data.
//
// Signature notes (confirmed against src/db.js exports):
//   - listRuns(limit=20)                              -> array
//   - listSessions(runId|null, { platform, ... })     -> array (rows carry s.id)
//   - listErrors({ sortKey, sortOrder, platform, ...})-> array (sort key is
//       'time_sec' not 'time'; direction param is 'sortOrder' not 'sortDir')
//   - countErrors(opts)                               -> number/object
//   - getPatterns(runId|null)                         -> POSITIONAL int|null
//   - getSessionAnalysis(sessionId)                   -> POSITIONAL int|null
//   - lsatStats()                                     -> { totals, byKind, byTest }
//   - listStudyPlanTasks()                            -> array
//   - listMockResults()                               -> array
require('dotenv').config();
const db = require('../src/db');

(async () => {
  await db.initDb();
  const checks = [
    ['listRuns', () => db.listRuns()],
    ['listSessions', () => db.listSessions(null, {})],
    ['listSessions(gmatclub)', () => db.listSessions(null, { platform: 'gmatclub' })],
    ['listSessions(starttest)', () => db.listSessions(null, { platform: 'starttest' })],
    ['listErrors', () => db.listErrors({})],
    ['listErrors(sorted by time desc)', () => db.listErrors({ sortKey: 'time_sec', sortOrder: 'desc' })],
    ['listErrors(gmatclub)', () => db.listErrors({ platform: 'gmatclub' })],
    ['getPatterns(null)', () => db.getPatterns(null)],
    ['lsatStats', () => db.lsatStats()],
    ['listStudyPlanTasks', () => db.listStudyPlanTasks()],
    ['listMockResults', () => db.listMockResults()],
  ];
  for (const [name, fn] of checks) {
    const r = await fn();
    const n = Array.isArray(r) ? r.length : (r ? Object.keys(r).length : 0);
    console.log(`OK ${name} -> ${Array.isArray(r) ? n + ' rows' : 'object'}`);
  }
  // Sanity: there ARE wrong answers in the data, so listErrors must be non-empty.
  const errs = await db.listErrors({});
  if (!errs.length) throw new Error('listErrors returned 0 rows — expected wrong answers in migrated data');
  // Exercise a real session deep-dive: pick an actual session id.
  const oneSession = (await db.listSessions(null, {}))[0];
  if (oneSession) {
    const analysis = await db.getSessionAnalysis(oneSession.id);
    console.log(`OK getSessionAnalysis(${oneSession.id}) -> ${analysis ? 'object' : 'null'}`);
  }
  console.log('verify-migration OK (' + errs.length + ' errors in log)');
  await db.closePool();
})().catch((e) => { console.error('VERIFY FAIL:', e); process.exit(1); });
