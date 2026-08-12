-- Soft-exclude flag for sessions the dashboard should ignore without deleting.
--
-- Backfilled for the pre-StartTest ("GMAT Official" Nuxt SPA) practice-book data:
-- that scraper is retired (see gmat_scraper.js), its sessions carry 8-digit
-- platform sids (~83,000,000+) while StartTest sids are ~200-300k, and its rows
-- stop at session_date 2026-03-28 (StartTest data starts 2026-04-22) — so the sid
-- magnitude is an exact discriminator. Practice Exams are deliberately spared:
-- OPE mocks also carry large sids but are a live source.
--
-- Nothing is deleted; question_attempts, annotations, and enrichment stay intact.
-- Flip the flag back to 0 to bring a session (or the whole legacy set) back.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS excluded integer NOT NULL DEFAULT 0;

UPDATE sessions
   SET excluded = 1
 WHERE source LIKE 'GMAT%Official%'
   AND source NOT LIKE '%Practice Exam%'
   AND session_external_id > 10000000
   AND excluded = 0;

CREATE INDEX IF NOT EXISTS idx_sessions_excluded ON sessions (excluded);
