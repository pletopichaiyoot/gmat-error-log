-- Phase-2 DI stimulus (svg charts, screenshot chart images, tables, MSR sources)
-- stored as a JSON string. Nullable; only DI Phase-2 rows populate it.
ALTER TABLE question_attempts ADD COLUMN IF NOT EXISTS stimulus text;
