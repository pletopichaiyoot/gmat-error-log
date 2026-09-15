// Derive a practice question type from the stem's prompt.
//
// The Official Guide prints its own label ("Argument Construction", "Supporting
// ideas"), but those buckets are too coarse to drill against — one of them
// covers assumption, conclusion and paradox questions alike — and a third of
// the pool carries no label at all, because the explanation that would have
// supplied it was dropped. The prompts themselves are formulaic, so the type a
// test-taker would recognise is recoverable from the question's final sentence.
//
// Deterministic and free: no model, no pass to pay for, re-derived on every
// parse, and every rule is testable against a fixed prompt.

import { splitStem } from './stemSplit.mjs';

const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl' };

// The scans carry ligature glyphs ("chieﬂy", "ﬁrst", "deﬁned"), which match none
// of the patterns below until they are expanded — that alone moved RC coverage
// eight points.
function normalize(text) {
  return String(text || '')
    .replace(/[ﬀ-ﬄ]/g, (c) => LIGATURES[c])
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Rules are ordered: the first match wins, so the more specific patterns come
// before the ones that would also catch them. "Boldface" precedes everything
// because its prompt says nothing else about the task; "Detail" and "Inference"
// come last in RC because "according to the passage" and "suggests" turn up
// inside prompts that are really asking something more specific.
const CR_RULES = [
  ['Boldface', /boldface|boldfaced|portions? in bold/],
  ['Complete the Passage', /logically completes|__+|(?:because|since|that)\s*[.…]+\s*$/],
  ['Evaluate', /most useful to (?:determine|know|establish|compare|investigate)|most (?:useful|important|helpful) (?:in|to|for) (?:determin|evaluat|know|assess)|in order to evaluate|would be most important in determining|answer to which of the following/],
  ['Assumption', /\bassumptions?\b|\bassumes\b|\bpresupposes\b|depends on which|on which .{0,30}depends|takes for granted|is required for/],
  ['Flaw', /\bflaw\w*\b|vulnerable to .{0,25}(?:criticism|objection)|questionable|fails to consider|error in reasoning|objection that it fails/],
  ['Weaken', /weaken|undermin|cast\w* .{0,25}doubt|calls? .{0,12}into question|argues? .{0,12}against|most damaging|serious(?:ly)? .{0,20}(?:doubt|question|weakness)|raises? .{0,25}doubt|disadvantage/],
  ['Paradox', /explain\w*|explanation|resolv\w*|accounts? for|reconcil\w*/],
  ['Strengthen', /strengthen|most (?:strongly )?support\w*|provides? (?:some|the (?:most|best|strongest)) (?:support|basis|reason|grounds|justification|indication)|justif\w*|best (?:basis|reason|grounds)|support\w* the (?:argument|conclusion|position|prediction|plan|hypothesis)|more reasonably drawn|would allow|most effectively|minimize/],
  ['Inference', /\bcan\b.{0,25}(?:inferred|concluded|drawn)|must be true|(?:most strongly|best) supported by|conclusions? .{0,30}(?:drawn|supported)|follows logically|best support\w* which of the following|properly be (?:inferred|drawn)/],
  ['Method', /describes? the (?:method|technique|role|way|strategy)|proceeds by|responds? to .{0,30}by|develops? the argument by|challenges? .{0,30}by doing which|counters? .{0,20}by/],
];

const RC_RULES = [
  ['Main Idea', /primary purpose|primarily concerned|main (?:idea|point|purpose)|best (?:title|summarizes)|chiefly concerned|primarily interested in|central (?:idea|thesis|point)/],
  ['Vocabulary', /most closely corresponds|best defined as|can best be characterized as|(?:word|phrase|term) [“"]/],
  ['Tone', /\battitude\b|\btone\b|author'?s? (?:view|opinion|stance) (?:of|toward|on)|opinion of/],
  ['Weaken', /weaken|undermin|cast\w* .{0,25}doubt|calls? .{0,12}into question/],
  ['Application', /most analogous|would .{0,18}likely .{0,6}(?:agree|make|recommend)|would probably|most similar to|applies? to which|exemplif\w*|hypothetical/],
  ['Function', /in order to\b|serves? (?:primarily )?to\b|function\w* (?:of|in)|relation(?:ship)?s? (?:of|between|to) the|relates? to the|why .{0,30}mention|purpose of the (?:first|second|third|fourth|fifth|last|final) paragraph|author mentions|performs? which|discussion of|the author (?:cites|alludes|anticipates)/],
  ['Inference', /\bimpl(?:y|ies|ied)\b|can be inferred|\bsuggests?\b|it can be concluded|inferred from the passage|passage (?:supports|least supports)|is (?:best )?supported by (?:information|the passage)|supports? which of the following/],
  ['Detail', /according to the passage|the passage (?:states|indicates|mentions|provides|specifies|says|warns|describes|does not state)|is mentioned in the passage|the author (?:states|indicates|notes|cites)|all of the following .{0,30}except/],
];

// The scans glue words together ("primarilyconcerned", "serves primarilyto"), so
// every pattern is also tried with its literal spaces made optional. Building
// the variant from the same source keeps one rule table rather than two.
function glued(re) {
  return new RegExp(re.source.replace(/ /g, '\\s*'), re.flags);
}

const RULES = {
  CR: CR_RULES.map(([label, re]) => [label, re, glued(re)]),
  RC: RC_RULES.map(([label, re]) => [label, re, glued(re)]),
};

export const QUESTION_TYPES = {
  CR: CR_RULES.map(([label]) => label),
  RC: RC_RULES.map(([label]) => label),
};

// → one of QUESTION_TYPES[kind], or null when no rule matches.
export function classifyQuestionType(stem, kind) {
  const rules = RULES[String(kind || '').toUpperCase()];
  if (!rules) return null;
  const { prompt } = splitStem(stem);
  const text = normalize(prompt);
  if (!text) return null;
  const squished = text.replace(/\s+/g, '');
  for (const [label, re, gluedRe] of rules) {
    if (re.test(text) || gluedRe.test(squished)) return label;
  }
  return null;
}
