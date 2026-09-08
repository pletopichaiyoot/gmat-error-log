-- StartTest's Search panel ("Search by Item ID") matches the portal-side Item
-- Name (e.g. 700216), NOT the ITD item key we store in q_code (e.g. 425773).
-- The Item Name appears only in search-results tables, so it is harvested by a
-- separate pass (scripts/harvest-starttest-item-ids.js) and cached here.
ALTER TABLE question_attempts
  ADD COLUMN IF NOT EXISTS search_item_id text;
