-- Normalize question_attempts.mistake_type onto the current picker vocabulary.
--
-- WHY THIS EXISTS
-- The v3 taxonomy (client/src/App.jsx, MISTAKE_TYPES) is the source of truth for
-- what a valid tag is. Its one-time migration, scripts/archive/migrate-tags-v3.js,
-- was written against SQLite and never re-run after the Postgres move, so the
-- column drifted back out of vocabulary from three directions:
--
--   1. Rows tagged after that script ran kept using pre-v3 names
--      ('Logic Breakdown', 'Misread Passage', 'Wrong Variable Setup', ...).
--   2. The picker later SPLIT 'Time Trap' into three actionable modes
--      (Chose Too Early / Overinvested / Ran Out of Time), which orphaned the
--      22 rows the v3 script had just consolidated INTO 'Time Trap'.
--   3. Target Test Prep is authoritative for mistake_type (see CLAUDE.md), so
--      every TTP rescrape rewrites its own plain-English sentences
--      ('I misread / misinterpreted the question.') over the column.
--
-- Reason 3 is a recurring source, not a one-off: this migration cleans the rows
-- that exist today, and src/mistake-tags.js canonicalizes on the write path so
-- the next TTP scrape doesn't undo it.
--
-- Also fixed here: tag arrays were stored in whatever order they were clicked,
-- so ["Calc/Casework Slip","Wrong Setup"] and ["Wrong Setup","Calc/Casework Slip"]
-- were distinct strings and any GROUP BY on the raw column split each combo into
-- two rows. Arrays are now written in the picker's own dimension order
-- (cause -> trap -> timing/process), which makes the serialization canonical.
--
-- Storage shape is unified to a JSON array string, even for a single tag; bare
-- strings (the old serialize() convention, and every TTP row) are wrapped.
-- Unknown tags are PRESERVED as-is so no annotation is ever silently lost.

DO $migrate$
DECLARE
  rec        RECORD;
  raw_tags   text[];
  out_tags   text[];
  t          text;
  mapped     text;
  ratio      numeric;
  has_other  boolean;
BEGIN
  -- Median seconds per subject, used only to disambiguate the legacy 'Time Trap'
  -- tag (which lumped "too fast" and "too slow" — opposite fixes).
  CREATE TEMP TABLE _median_sec ON COMMIT DROP AS
    SELECT COALESCE(subject_code, '?') AS sc,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY time_sec) AS m
      FROM question_attempts
     WHERE time_sec > 0
     GROUP BY 1;

  -- Canonical write order = the picker's dimension order in MISTAKE_TYPES.
  CREATE TEMP TABLE _tag_order (tag text PRIMARY KEY, ord integer) ON COMMIT DROP;
  INSERT INTO _tag_order (tag, ord) VALUES
    ('Misread', 1),
    ('Modifier/Connective Miss', 2),
    ('Concept Gap', 3),
    ('Wrong Setup', 4),
    ('Logic Slip', 5),
    ('Calc/Casework Slip', 6),
    ('Trap: Scope/Strength', 7),
    ('Trap: Half-Right', 8),
    ('Trap: Reversed', 9),
    ('Trap: Plausible-but-Unstated', 10),
    ('Trap: True-but-Irrelevant', 11),
    ('Trap: Distortion/Familiar-Language', 12),
    ('Trap: Premise Repeat', 13),
    ('No Plan / Stuck', 14),
    ('Chose Too Early / Rushed-Guess', 15),
    ('Overinvested (>2× median)', 16),
    ('Ran Out of Time', 17);

  -- Legacy value -> canonical tag. NULL canonical = drop the tag entirely.
  CREATE TEMP TABLE _tag_map (legacy text PRIMARY KEY, canonical text) ON COMMIT DROP;
  INSERT INTO _tag_map (legacy, canonical) VALUES
    -- Misread
    ('Misread (Passage / Question / Condition)', 'Misread'),
    ('Misread Passage', 'Misread'),
    ('Misread Question', 'Misread'),
    ('Misread Condition', 'Misread'),
    ('Chart/Table Misread', 'Misread'),
    ('Missed Negation/Qualifier', 'Misread'),
    ('CR: Missed Negation/Qualifier', 'Misread'),
    ('MSR: Missed Cross-Source Link', 'Misread'),
    ('Multi-Source: Missed Cross-Link', 'Misread'),
    ('I misread / misinterpreted the question.', 'Misread'),
    ('I failed to use all of the information provided to me in the stem.', 'Misread'),
    -- Concept Gap
    ('Conceptual Gap', 'Concept Gap'),
    ('I did not understand the concept tested.', 'Concept Gap'),
    -- Wrong Setup
    ('Wrong Setup (Variable / Equation / Structure)', 'Wrong Setup'),
    ('Wrong Variable Setup', 'Wrong Setup'),
    ('Failed to Translate', 'Wrong Setup'),
    ('Two-Part: Pairing/Order Error', 'Wrong Setup'),
    ('Wrong Order-Pairing', 'Wrong Setup'),
    ('Composite / Multi-Select: Wrong Slot', 'Wrong Setup'),
    ('I understood the concept tested but failed to properly apply it.', 'Wrong Setup'),
    -- Logic Slip
    ('Logic Breakdown', 'Logic Slip'),
    ('Logic Breakdown (Wrong Inference or Relationship)', 'Logic Slip'),
    ('Wrong Logical Relationship', 'Logic Slip'),
    ('Invalid Assumption', 'Logic Slip'),
    ('RC Trap: Wrong Paragraph', 'Logic Slip'),
    ('CR: Confused Author Tone', 'Logic Slip'),
    -- Calc/Casework Slip
    ('Calculation Slip (Computation / Unit / Sign / Careless)', 'Calc/Casework Slip'),
    ('Calculation Error', 'Calc/Casework Slip'),
    ('Careless / Sloppy Error', 'Calc/Casework Slip'),
    ('Incomplete Casework', 'Calc/Casework Slip'),
    ('Unit-Scale', 'Calc/Casework Slip'),
    ('Sign-Direction', 'Calc/Casework Slip'),
    ('I made a careless math mistake.', 'Calc/Casework Slip'),
    ('I got so excited when I figured out how to answer the question that I made a careless error.', 'Calc/Casework Slip'),
    -- Trap Type
    ('RC Trap: Too Extreme', 'Trap: Scope/Strength'),
    ('RC Trap: Out of Scope', 'Trap: Scope/Strength'),
    ('CR: Scope Shift (Premise vs Conclusion)', 'Trap: Scope/Strength'),
    ('RC Trap: Half-Right', 'Trap: Half-Right'),
    ('RC Trap: Opposite Direction', 'Trap: Reversed'),
    ('I fell for a trap answer.', 'Trap: Plausible-but-Unstated'),
    -- Timing & Process
    ('Could Not Start / No Plan', 'No Plan / Stuck'),
    ('Stuck in Algebra', 'No Plan / Stuck'),
    ('Re-read Loop (Got Stuck Re-reading)', 'No Plan / Stuck'),
    ('My written work was unorganized and difficult to follow.', 'No Plan / Stuck'),
    ('Chose Too Early', 'Chose Too Early / Rushed-Guess'),
    ('Rushed Guess', 'Chose Too Early / Rushed-Guess'),
    -- NOTE: the canonical tag uses U+00D7 MULTIPLICATION SIGN, matching the
    -- picker exactly. The ASCII-'x' spellings below are legacy typos, not the
    -- target — getting this backwards would mint a new out-of-vocabulary tag.
    ('Overinvested Time', 'Overinvested (>2× median)'),
    ('Overinvested Time (>2x median)', 'Overinvested (>2× median)'),
    ('Overinvested (>2x median)', 'Overinvested (>2× median)'),
    ('I spent too much time on the question but answered it correctly', 'Overinvested (>2× median)'),
    ('Ran Out / Near-blank', 'Ran Out of Time'),
    ('I ran out of time.', 'Ran Out of Time'),
    -- Explicitly dropped: not mistake causes
    ('Pre-phrase Mismatch (Skipped Pre-phrasing)', NULL),
    ('I guessed correctly', NULL);

  FOR rec IN
    SELECT id,
           mistake_type,
           time_sec,
           COALESCE(subject_code, '?') AS sc
      FROM question_attempts
     WHERE COALESCE(TRIM(mistake_type), '') NOT IN ('', '[]')
     ORDER BY id
  LOOP
    -- Parse: JSON array, or a bare single-tag string. A malformed '[' value
    -- falls back to being treated as one literal tag rather than aborting.
    BEGIN
      IF LEFT(TRIM(rec.mistake_type), 1) = '[' THEN
        SELECT array_agg(v) INTO raw_tags
          FROM json_array_elements_text(TRIM(rec.mistake_type)::json) AS e(v);
      ELSE
        raw_tags := ARRAY[TRIM(rec.mistake_type)];
      END IF;
    EXCEPTION WHEN others THEN
      raw_tags := ARRAY[TRIM(rec.mistake_type)];
    END;
    IF raw_tags IS NULL THEN
      raw_tags := ARRAY[]::text[];
    END IF;

    out_tags := ARRAY[]::text[];

    -- Pass 1: everything except 'Time Trap', which needs the other tags decided
    -- first (see pass 2).
    FOREACH t IN ARRAY raw_tags LOOP
      t := TRIM(t);
      CONTINUE WHEN t = '' OR t = 'Time Trap';
      SELECT canonical INTO mapped FROM _tag_map WHERE legacy = t;
      IF NOT FOUND THEN
        mapped := t;  -- unrecognized: preserve verbatim
      END IF;
      IF mapped IS NOT NULL AND NOT (mapped = ANY (out_tags)) THEN
        out_tags := out_tags || mapped;
      END IF;
    END LOOP;

    -- Pass 2: legacy 'Time Trap' resolved from the clock, since the tag itself
    -- doesn't say which direction the error went.
    IF 'Time Trap' = ANY (raw_tags) THEN
      SELECT (rec.time_sec::numeric / NULLIF(m, 0)) INTO ratio
        FROM _median_sec WHERE sc = rec.sc;
      has_other := COALESCE(array_length(out_tags, 1), 0) > 0;

      IF rec.time_sec > 0 AND ratio IS NOT NULL AND ratio >= 2 THEN
        mapped := 'Overinvested (>2× median)';
      ELSIF rec.time_sec > 0 AND ratio IS NOT NULL AND ratio <= 0.5 THEN
        mapped := 'Chose Too Early / Rushed-Guess';
      ELSIF has_other THEN
        -- Middle of the band: neither mode applies, and the row already carries
        -- a substantive tag. Drop rather than guess.
        mapped := NULL;
      ELSE
        -- Only tag on the row and the clock is inconclusive. Keep it so the row
        -- doesn't silently become untagged; surfaces in the verification query
        -- as the short manual-retag list.
        mapped := 'Time Trap';
      END IF;

      IF mapped IS NOT NULL AND NOT (mapped = ANY (out_tags)) THEN
        out_tags := out_tags || mapped;
      END IF;
    END IF;

    -- Canonical order, so identical tag SETS serialize to identical strings.
    SELECT array_agg(u.tg ORDER BY COALESCE(o.ord, 90), u.tg)
      INTO out_tags
      FROM unnest(out_tags) AS u(tg)
      LEFT JOIN _tag_order o ON o.tag = u.tg;

    UPDATE question_attempts
       SET mistake_type = CASE
             WHEN COALESCE(array_length(out_tags, 1), 0) = 0 THEN NULL
             ELSE to_json(out_tags)::text
           END
     WHERE id = rec.id;
  END LOOP;
END
$migrate$;
