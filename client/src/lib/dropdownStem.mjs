// A StartTest dropdown item (GI "Graphics Interpretation", and the same widget
// on some TA questions) stores its stem with every dropdown FLATTENED into the
// text: the marker line "Select...", then one line per option, then the rest of
// the sentence. So the stored stem for a two-blank item reads
//
//   The information in the graph
//   Select...
//   directly affirms
//   directly contradicts
//   neither directly affirms nor directly contradicts
//    the statement that ...
//
// which is unreadable as a question — you cannot see which sentence a blank sat
// in, only a dump of choices. The blanks and their options are already stored
// structurally in `answer_choices`, so the sentence can be put back together:
// walk the stem, and wherever a marker is followed by that blank's own options,
// replace the whole run with the blank itself.

const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

const MARKER = 'select...';

const isMarker = (line) => {
  const text = norm(line);
  return text === MARKER || text === 'select..' || text === 'select…';
};

/**
 * @returns an array of `{type: 'text', text}` / `{type: 'blank', index}` tokens,
 * or null when the stem does not carry one flattened run per blank (a stem that
 * was scraped some other way, or a non-dropdown item) — callers fall back to
 * rendering the stem as-is.
 */
export function buildDropdownStatement(stem, blanks) {
  const source = String(stem || '');
  if (!source.trim() || !Array.isArray(blanks) || !blanks.length) return null;

  const lines = source.split('\n');
  const tokens = [];
  let buffer = [];
  let blankIndex = 0;

  const flushText = () => {
    const text = buffer.join('\n');
    if (text.trim()) tokens.push({ type: 'text', text });
    buffer = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (blankIndex >= blanks.length || !isMarker(lines[i])) {
      buffer.push(lines[i]);
      continue;
    }

    const options = new Set(
      (blanks[blankIndex]?.options || [])
        .map((option) => norm(option?.text))
        .filter((text) => text && text !== MARKER)
    );
    let end = i + 1;
    while (end < lines.length && options.has(norm(lines[end]))) end += 1;
    // A marker with none of this blank's options under it is not a flattened
    // run — bail rather than eat the sentence around it.
    if (end === i + 1) return null;

    flushText();
    tokens.push({ type: 'blank', index: blankIndex });
    blankIndex += 1;
    i = end - 1;
  }

  if (blankIndex !== blanks.length) return null;
  flushText();
  return tokens;
}

// A dropdown item's `correct_answer` is the option TEXTS joined with ", " — one
// per blank. Splitting it on commas is wrong whenever an option text contains
// one, which real items do: "600,000" + "1,200,000" comes back as five parts,
// and the review modal then shows the wrong key (7 of 93 stored rows). When the
// blanks still carry their option lists, consume the string option-by-option
// instead; fall back to the naive split when they don't.
export function splitDropdownAnswers(value, blanks) {
  const text = String(value || '').trim();
  const count = Array.isArray(blanks) ? blanks.length : 0;
  if (!text || !count) return [];

  const naive = text.split(/\s*,\s*/);
  if (naive.length === count) return naive;

  const out = [];
  let rest = text;
  for (let i = 0; i < count; i += 1) {
    const options = (blanks[i]?.options || [])
      .map((option) => String(option?.text || '').trim())
      .filter((option) => option && !/^select\.\.\.?$/i.test(option))
      // Longest first: "1,200,000" must win over a "1" that also fits.
      .sort((a, b) => b.length - a.length);
    const match = options.find((option) => rest === option || rest.startsWith(`${option},`));
    if (!match) return naive;
    out.push(match);
    rest = rest.slice(match.length).replace(/^\s*,\s*/, '');
  }
  return rest ? naive : out;
}
