// StartTest's "Search by Item ID" box only accepts the portal-side Item Name
// (e.g. 700216), which our scrapes never see — `q_code` holds the ITD item key
// (425773) and that search rejects it. Its other mode, "Search by Text", does
// work from what we DO have: the question stem. It supports exact phrases in
// double quotes, needs at least 3 characters, and drops short stopwords.
//
// So build a quoted phrase from the start of the stem — the same text the
// platform indexed — long enough to identify one question, and free of the
// symbols that a phrase search cannot match.

const MIN_WORDS_BEFORE_STOPPING = 3;

// A token usable inside a quoted phrase: starts alphanumeric, no math or markup.
const SEARCHABLE_WORD = /^[A-Za-z0-9][A-Za-z0-9'’-]*$/;

export function buildStartTestSearchPhrase(stem, { maxWords = 8 } = {}) {
  const cleaned = String(stem || '')
    .replace(/\[item contains image\]/gi, ' ')
    // Quotes of our own would terminate the phrase the user pastes.
    .replace(/["“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';

  const words = [];
  for (const token of cleaned.split(' ')) {
    const word = token.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9'’-]+$/, '');
    // A phrase that opens on a bare number is usually a leftover fragment of an
    // equation ("4 < x/3 < 9 which of…"), and the indexed text around it may be
    // punctuated differently — so only start the run on a real word.
    if (!words.length && !/^[A-Za-z]/.test(word)) continue;
    if (!SEARCHABLE_WORD.test(word)) {
      // Equations, figure references and bare symbols cannot appear in a phrase
      // search. Once we already have a usable run, stop there; if the stem
      // *opens* with such junk, throw the run away and start after it.
      if (words.length >= MIN_WORDS_BEFORE_STOPPING) break;
      words.length = 0;
      continue;
    }
    // Curly vs straight apostrophes are a coin flip against whatever the
    // platform indexed ("Ruth’s"), so once the phrase is long enough to be
    // useful, end it rather than risk a no-match on one character.
    if (/['’]/.test(word) && words.length >= MIN_WORDS_BEFORE_STOPPING) break;
    words.push(word.replace(/’/g, "'"));
    if (words.length >= maxWords) break;
  }

  const phrase = words.join(' ');
  return phrase.length >= 3 ? `"${phrase}"` : '';
}
