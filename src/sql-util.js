// src/sql-util.js
// Pure helpers for the SQLite -> Postgres port. No DB dependency (unit-testable).

// Rewrite SQLite '?' positional placeholders to Postgres $1,$2,... left-to-right.
// Safe for every query in this codebase: verified that no SQL string contains a
// literal '?' inside a string literal or identifier — all '?' are bind params.
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Parse the two timestamp text formats the SQLite DB stored into a JS Date that
// node-postgres serializes to timestamptz: SQLite datetime('now') -> UTC
// 'YYYY-MM-DD HH:MM:SS' (no zone marker), and JS toISOString() -> ISO 'YYYY-MM-DDTHH:MM:SS.sssZ'.
function toTimestamptz(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (s.includes('T')) return new Date(s);          // already ISO/zoned
  return new Date(s.replace(' ', 'T') + 'Z');         // SQLite UTC, no marker
}

module.exports = { toPg, toTimestamptz };
