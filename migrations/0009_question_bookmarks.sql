-- Bookmarks live in their own table, keyed on the QUESTION, not on a
-- question_attempts row:
--
--   * Phase-1 rescrapes delete + reinsert attempts and reassign their ids, so a
--     column on question_attempts would have to ride in buildAttemptSnapshotIndex
--     and QUESTION_ATTEMPT_INSERT_COLUMNS — and dropping it from either list
--     silently wipes the data on the next sync (see CLAUDE.md, "Phase-1
--     rescrapes must never downgrade Phase-2 data").
--   * A bookmark belongs to the question, so one star covers the original
--     attempt and every redo of it.
--
-- bookmark_key is q_code when the row has one, else q_id: 239 of ~5,500
-- attempts are Phase-1-only and carry no q_code (it arrives with Phase 2), and
-- both ids are stable across rescrapes.
CREATE TABLE IF NOT EXISTS question_bookmarks (
  id            serial PRIMARY KEY,
  bookmark_key  text NOT NULL UNIQUE,
  key_kind      text NOT NULL CHECK (key_kind IN ('q_code', 'q_id')),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_question_bookmarks_created_at
  ON question_bookmarks (created_at DESC);
