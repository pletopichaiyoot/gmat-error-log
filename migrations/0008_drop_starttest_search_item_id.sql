-- Reverts 0007. The column was meant to cache StartTest's searchable Item Name,
-- but the only way to read one is to drive the platform's search panel, and that
-- flow terminates the login (see CLAUDE.md). Nothing ever populated the column;
-- the review chip copies a stem phrase for Search by Text instead.
ALTER TABLE question_attempts
  DROP COLUMN IF EXISTS search_item_id;
