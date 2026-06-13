# Archived one-shot SQLite scripts

These ran once against the SQLite DB; their effects are baked into the data the
Postgres ETL (`scripts/migrate-sqlite-to-pg.js`) carried over. Kept for history,
NOT runnable against Postgres (they open a raw sqlite3 connection). If a similar
backfill is ever needed again, write a fresh script against the pg Pool.
