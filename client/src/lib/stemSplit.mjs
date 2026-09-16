// Split a question stem into its stimulus and its prompt.
//
// LSAT Logical Reasoning and GMAT Critical Reasoning both store the stem as one
// flat paragraph — the argument and the question run together ("…packing the
// wound with sugar. Which one of the following, if true, …?"). On the real
// tests they are visually separate, so callers split them and give the prompt
// its own line. Dialogue stimuli ("Ann: … Bill: …") also get one line per
// speaker. Reading Comprehension stems are already prompt-only; callers pass
// them through unsplit.

// Sentence splitting must not break on abbreviations — "Mr. Blatt: …" and
// "…through 6 P.M.?" both used to split mid-prompt.
// Note: a lone capital + period ("… distinguishing X from Y.") is NOT treated as
// an initial — these stimuli end sentences on variable letters far more often
// than they contain "J. Smith", and swallowing those merged whole stems into
// one line.
const STEM_ABBREV = /\b(?:Mr|Mrs|Ms|Messrs|Dr|Prof|Sen|Rep|Gov|St|Jr|Sr|Inc|Co|Ltd|vs|etc|approx|Fig|No|Vol|e\.g|i\.e|a\.m|p\.m|A\.M|P\.M|U\.S|U\.K)\.$/;
const STEM_SENTENCE_BREAK = /(?<=[.?!][”’"'])\s+|(?<=[.?!])\s+/;
// A sentence that opens a dialogue turn: 1–3 capitalized words then a colon
// ("Ann:", "Mr. Blatt:", "Council member Q:"). Periods are allowed inside the
// label so honorifics survive the abbreviation merge above.
const STEM_SPEAKER_START = /^[A-Z][A-Za-z’'.-]*(?:\s+[A-Za-z][A-Za-z’'.-]*){0,2}:\s/;

export function splitStemSentences(text) {
  const out = [];
  for (const part of String(text || '').split(STEM_SENTENCE_BREAK)) {
    const prev = out.length ? out[out.length - 1] : null;
    if (prev !== null && STEM_ABBREV.test(prev)) out[out.length - 1] = `${prev} ${part}`;
    else out.push(part);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

// → { stimulus: string[] (paragraphs, possibly empty), prompt: string }
export function splitStem(stem) {
  const text = String(stem || '').trim();
  if (!text) return { stimulus: [], prompt: '' };
  const sentences = splitStemSentences(text);
  // The prompt is always the final sentence; everything before it is the
  // stimulus. A one-sentence stem is a bare prompt (RC, or a question whose
  // stimulus the parser dropped).
  if (sentences.length <= 1) return { stimulus: [], prompt: text };
  const prompt = sentences[sentences.length - 1];
  const body = sentences.slice(0, -1);
  // Group the stimulus into paragraphs at each speaker label. Only two or more
  // speakers counts as a dialogue — a lone "Editorial:" stays one paragraph.
  const turns = [];
  let speakers = 0;
  for (const sentence of body) {
    if (STEM_SPEAKER_START.test(sentence)) { speakers += 1; turns.push(sentence); }
    else if (turns.length) turns[turns.length - 1] += ` ${sentence}`;
    else turns.push(sentence);
  }
  return { stimulus: speakers >= 2 ? turns : [body.join(' ')], prompt };
}

// Whether every <tag> opened in `html` is also closed in it.
//
// A GMAT boldface stem carries <b> spans, and the sentence split is blind to
// them: a span covering a sentence boundary would leave the <b> in one
// paragraph and the </b> in the next, so the browser would bold the rest of the
// question. Callers check each piece and fall back to rendering the stem whole.
export function tagsBalanced(html) {
  const text = String(html || '');
  const open = (text.match(/<([a-z]+)(?=[\s>])/gi) || []).length;
  const close = (text.match(/<\/[a-z]+>/gi) || []).length;
  return open === close;
}
