// A note is only useful if it says what to review. The three slots below come
// from the GMAT Club review method (forum/how-to-review-and-analyze-your-
// mistakes-167118.html): what happened, what it taught you, what you'll do so
// it doesn't happen again. They're universal — the same three apply to a
// question you got right (lucky guess, slow-but-correct) as to one you missed.
//
// Storage stays a single `question_attempts.notes` text column: the slots are
// serialized as `Label: value` blocks and parsed back by label. Anything that
// doesn't start with a known label — i.e. every note written before this — is
// kept verbatim in the `other` slot, so no existing note is lost or reshaped.

export const REVIEW_SLOTS = [
  {
    key: 'happened',
    label: 'What happened',
    hint: 'the actual move — what you did, where it broke, or what worked',
  },
  {
    key: 'takeaway',
    label: 'Takeaway',
    hint: 'name the object and the direction — not "was careless"',
  },
  {
    key: 'next',
    label: 'Next time',
    hint: 'a rule with a trigger you will actually notice mid-question',
  },
];

export const OTHER_SLOT = { key: 'other', label: 'Other notes' };

const ALL_SLOTS = [...REVIEW_SLOTS, OTHER_SLOT];

const EMPTY = Object.freeze(
  Object.fromEntries(ALL_SLOTS.map((slot) => [slot.key, '']))
);

const HEADER = new RegExp(
  `^\\s*(${ALL_SLOTS.map((s) => s.label).join('|')})\\s*:[ \\t]*(.*)$`,
  'i'
);

const slotKeyForLabel = (label) =>
  ALL_SLOTS.find((slot) => slot.label.toLowerCase() === label.toLowerCase()).key;

export function parseReviewNotes(raw) {
  const text = String(raw || '');
  if (!text.trim()) return { ...EMPTY };

  const parts = Object.fromEntries(ALL_SLOTS.map((slot) => [slot.key, []]));
  // Text before the first header is a legacy free-form note, not a slot.
  let current = OTHER_SLOT.key;

  for (const line of text.split('\n')) {
    const header = line.match(HEADER);
    if (header) {
      current = slotKeyForLabel(header[1]);
      if (header[2].trim()) parts[current].push(header[2]);
      continue;
    }
    parts[current].push(line);
  }

  return Object.fromEntries(
    ALL_SLOTS.map((slot) => [slot.key, parts[slot.key].join('\n').trim()])
  );
}

export function serializeReviewNotes(values) {
  const filled = ALL_SLOTS
    .map((slot) => ({ slot, value: String(values?.[slot.key] || '').trim() }))
    .filter(({ value }) => value);
  if (!filled.length) return '';

  // A note that is only free text stays plain, so legacy notes survive an
  // open-and-save untouched instead of growing an "Other notes:" header.
  if (filled.length === 1 && filled[0].slot.key === OTHER_SLOT.key) {
    return filled[0].value;
  }

  return filled.map(({ slot, value }) => `${slot.label}: ${value}`).join('\n\n');
}

// The "Next time" slot is stored as an if-then rule — `When <trigger> → <action>`.
// The shape is the point: an implementation intention fires off a cue you can
// actually notice mid-question, where prose ("be more careful") never fires. It
// also gives the rule a stable string, so the same rule written on twenty
// questions groups into one process item with a count of twenty.
export const RULE_ARROW = '→';

export function parseRule(value) {
  const text = String(value || '').trim();
  if (!text) return { when: '', then: '' };
  const split = text.match(/^([\s\S]*?)\s*(?:→|->)\s*([\s\S]*)$/);
  // A legacy "Next time:" line has no arrow — it's an action without a trigger.
  if (!split) return { when: '', then: text.replace(/^when\s+/i, '').trim() };
  return {
    when: split[1].replace(/^when\s+/i, '').trim(),
    then: split[2].trim(),
  };
}

export function formatRule(rule) {
  const when = String(rule?.when || '').trim();
  const then = String(rule?.then || '').trim();
  if (when && then) return `When ${when} ${RULE_ARROW} ${then}`;
  if (when) return `When ${when}`;
  return then;
}

// Rolls the rules written across a set of rows into one entry per rule: how
// often it was needed, on how many distinct questions, and where. A rule at six
// hits is a process item; a rule at one hit is a note. This is the whole reason
// the "Next time" slot has a fixed shape.
// ponytail: groups by exact trigger text, so rewording a rule forks it. Fuzzy
// matching only if the panel actually shows near-duplicates.
function ruleKey(trigger) {
  return trigger.toLowerCase().replace(/\s+/g, ' ').trim();
}

// session_date arrives as a 'YYYY-MM-DD' string from the API and as a Date from
// pg; both have to compare and sort the same way.
function dateKey(value) {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function rankByFrequency(counts) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value]) => value);
}

const SAMPLE_Q_CODES = 5;

export function rollupRules(rows) {
  const byRule = new Map();

  for (const row of rows || []) {
    const rule = parseRule(parseReviewNotes(row?.notes).next);
    if (!rule.when) continue;

    const key = ruleKey(rule.when);
    const seen = new Date(dateKey(row?.session_date)).getTime();
    let entry = byRule.get(key);
    if (!entry) {
      entry = {
        when: rule.when,
        then: rule.then,
        hits: 0,
        questions: new Set(),
        categories: new Map(),
        subjects: new Map(),
        firstSeen: '',
        lastSeen: '',
        samples: [],
      };
      byRule.set(key, entry);
    }

    entry.hits += 1;
    const qCode = String(row?.q_code || '').trim();
    if (qCode) entry.questions.add(qCode);
    for (const [field, counts] of [['category_code', entry.categories], ['subject_code', entry.subjects]]) {
      const value = String(row?.[field] || '').trim();
      if (value) counts.set(value, (counts.get(value) || 0) + 1);
    }

    const day = dateKey(row?.session_date);
    if (day) {
      if (!entry.firstSeen || day < entry.firstSeen) entry.firstSeen = day;
      // The newest row wins the wording, so editing a rule on your latest miss
      // is how you reword it going forward.
      if (!entry.lastSeen || day >= entry.lastSeen) {
        entry.lastSeen = day;
        entry.when = rule.when;
        if (rule.then) entry.then = rule.then;
      }
    }
    if (qCode) entry.samples.push({ qCode, seen: Number.isNaN(seen) ? 0 : seen });
  }

  return [...byRule.values()]
    .map((entry) => ({
      when: entry.when,
      then: entry.then,
      hits: entry.hits,
      questions: entry.questions.size,
      categories: rankByFrequency(entry.categories),
      subjects: rankByFrequency(entry.subjects),
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
      sampleQCodes: [...new Set(
        entry.samples.sort((a, b) => b.seen - a.seen).map((sample) => sample.qCode)
      )].slice(0, SAMPLE_Q_CODES),
    }))
    .sort(
      (a, b) => b.hits - a.hits || b.lastSeen.localeCompare(a.lastSeen) || a.when.localeCompare(b.when)
    );
}

// What the annotation modal's trigger datalist needs — the rollup, minus the
// aggregates it doesn't show.
export function collectRules(rows) {
  return rollupRules(rows).map(({ when, then, hits }) => ({ when, then, hits }));
}
