-- Rename the Trap Type tags onto Manhattan Prep's trap vocabulary (v4).
--
-- Source: Manhattan Prep, GMAT All the Verbal (2019) — RC ch. 13–14 and
-- CR ch. 18–22 name the recurring wrong-answer types. The picker
-- (client/src/App.jsx MISTAKE_TYPES) and the write-path canonicalizer
-- (src/mistake-tags.js) were updated 2026-08-23; this migration rewrites the
-- rows stored before the rename.
--
--   Trap: Half-Right                    -> Trap: One Word Off
--   Trap: Reversed                      -> Trap: Reverse Logic
--   Trap: Plausible-but-Unstated        -> Trap: Real-World Distraction
--   Trap: True-but-Irrelevant           -> Trap: True but Not Right
--   Trap: Distortion/Familiar-Language  -> Trap: Mix-Up
--   Trap: Scope/Strength                -> SPLIT: it lumped two tells that
--     Manhattan separates. Rows whose notes said "too strong" (q_codes 35192,
--     35237 at migration time) -> 'Trap: Extreme'; the rest -> 'Trap: Out of
--     Scope'. Matched by q_code, not id (Phase-1 rescrapes reassign ids).
--
-- New in v4, no stored rows to rewrite: 'Trap: No Tie to Argument'.
-- Unchanged: 'Trap: Premise Repeat' and both non-trap dimensions.
--
-- As in 0005: arrays are re-serialized in the picker's canonical dimension
-- order and unknown tags are preserved verbatim.

DO $migrate$
DECLARE
  rec      RECORD;
  raw_tags text[];
  out_tags text[];
  t        text;
  mapped   text;
BEGIN
  -- Canonical write order = the v4 picker's dimension order in MISTAKE_TYPES.
  CREATE TEMP TABLE _tag_order6 (tag text PRIMARY KEY, ord integer) ON COMMIT DROP;
  INSERT INTO _tag_order6 (tag, ord) VALUES
    ('Misread', 1),
    ('Modifier/Connective Miss', 2),
    ('Concept Gap', 3),
    ('Wrong Setup', 4),
    ('Logic Slip', 5),
    ('Calc/Casework Slip', 6),
    ('Trap: One Word Off', 7),
    ('Trap: Extreme', 8),
    ('Trap: Out of Scope', 9),
    ('Trap: True but Not Right', 10),
    ('Trap: Reverse Logic', 11),
    ('Trap: Mix-Up', 12),
    ('Trap: Real-World Distraction', 13),
    ('Trap: No Tie to Argument', 14),
    ('Trap: Premise Repeat', 15),
    ('No Plan / Stuck', 16),
    ('Chose Too Early / Rushed-Guess', 17),
    ('Overinvested (>2× median)', 18),
    ('Ran Out of Time', 19);

  -- v3 trap name -> v4 trap name. 'Trap: Scope/Strength' is handled in the
  -- loop (per-row split by q_code).
  CREATE TEMP TABLE _tag_map6 (legacy text PRIMARY KEY, canonical text) ON COMMIT DROP;
  INSERT INTO _tag_map6 (legacy, canonical) VALUES
    ('Trap: Half-Right', 'Trap: One Word Off'),
    ('Trap: Reversed', 'Trap: Reverse Logic'),
    ('Trap: Plausible-but-Unstated', 'Trap: Real-World Distraction'),
    ('Trap: True-but-Irrelevant', 'Trap: True but Not Right'),
    ('Trap: Distortion/Familiar-Language', 'Trap: Mix-Up');

  FOR rec IN
    SELECT id, q_code, mistake_type
      FROM question_attempts
     WHERE mistake_type LIKE '%Trap:%'
     ORDER BY id
  LOOP
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

    FOREACH t IN ARRAY raw_tags LOOP
      t := TRIM(t);
      CONTINUE WHEN t = '';
      IF t = 'Trap: Scope/Strength' THEN
        -- Split: rows annotated "too strong" were Extreme; the rest Out of Scope.
        IF rec.q_code IN ('35192', '35237') THEN
          mapped := 'Trap: Extreme';
        ELSE
          mapped := 'Trap: Out of Scope';
        END IF;
      ELSE
        SELECT canonical INTO mapped FROM _tag_map6 WHERE legacy = t;
        IF NOT FOUND THEN
          mapped := t;  -- already v4, or unrecognized: preserve verbatim
        END IF;
      END IF;
      IF mapped IS NOT NULL AND NOT (mapped = ANY (out_tags)) THEN
        out_tags := out_tags || mapped;
      END IF;
    END LOOP;

    -- Canonical order, so identical tag SETS serialize to identical strings.
    SELECT array_agg(u.tg ORDER BY COALESCE(o.ord, 90), u.tg)
      INTO out_tags
      FROM unnest(out_tags) AS u(tg)
      LEFT JOIN _tag_order6 o ON o.tag = u.tg;

    UPDATE question_attempts
       SET mistake_type = CASE
             WHEN COALESCE(array_length(out_tags, 1), 0) = 0 THEN NULL
             ELSE to_json(out_tags)::text
           END
     WHERE id = rec.id;
  END LOOP;
END
$migrate$;
