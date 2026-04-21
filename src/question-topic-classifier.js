const { HumanMessage, SystemMessage } = require('@langchain/core/messages');

const {
  buildModel,
  extractModelText,
  classifyLlmError,
} = require('./llm-coach-agent');
const { deriveQuestionMetadata } = require('./question-metadata');

const PS_LABELS = [
  'Algebra & Equations',
  'Arithmetic, FDP & Ratios',
  'Number Properties',
  'Rates, Work & Motion',
  'Statistics',
  'Overlapping Sets',
  'Counting & Probability',
  'Geometry',
  'Functions, Sequences & Inequalities',
  'General Word Problems',
];

const DS_LABELS = [
  'Algebra & Equations',
  'Arithmetic, FDP & Ratios',
  'Number Properties',
  'Rates, Work & Motion',
  'Statistics',
  'Overlapping Sets',
  'Counting & Probability',
  'Geometry',
  'Functions, Sequences & Inequalities',
  'General Word Problems',
  'Unclear Topic',
];

const GI_LABELS = [
  'Graphs',
  'Math-Based Interpretation',
  'Non-Math Interpretation',
];

const TA_LABELS = [
  'Tables',
  'Math-Based Analysis',
  'Non-Math Analysis',
];

const MSR_LABELS = [
  'Math-Based Reasoning',
  'Non-Math Reasoning',
];

const TPA_LABELS = [
  'Math-Based Reasoning',
  'Non-Math Reasoning',
];

const CR_LABELS = [
  'Support',
  'Attack',
  'Assumption',
  'Inference',
  'Resolve',
  'Argument Structure',
];

const RC_LABELS = [
  'Main Idea / Purpose',
  'Detail',
  'Inference',
  'Structure / Function',
  'Author View',
  'Application',
];

const VERBAL_LABELS = [
  ...new Set([
    ...CR_LABELS,
    ...RC_LABELS,
  ]),
];

const CATEGORY_LABELS = {
  PS: PS_LABELS,
  CR: CR_LABELS,
  RC: RC_LABELS,
  DS: DS_LABELS,
  GI: GI_LABELS,
  TA: TA_LABELS,
  MSR: MSR_LABELS,
  TPA: TPA_LABELS,
};

const ALL_TOPIC_LABELS = [
  ...new Set([
    ...PS_LABELS,
    ...VERBAL_LABELS,
    ...DS_LABELS,
    ...GI_LABELS,
    ...TA_LABELS,
    ...MSR_LABELS,
    ...TPA_LABELS,
    'Other',
  ]),
];
const DEFAULT_BATCH_SIZE = 6;
const MAX_STEM_CHARS = 2200;
const MAX_CHOICES_CHARS = 900;

function clipText(value, maxLen = 2000) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

function normalizeDsTopic(text) {
  if (/data sufficiency/.test(text)) return 'Unclear Topic';
  if (/unclear topic|poor quality|bad question|ambiguous/.test(text)) return 'Unclear Topic';
  if (/overlapping sets|venn/.test(text)) return 'Overlapping Sets';
  if (/statistics|mean|median|standard deviation|variance/.test(text)) return 'Statistics';
  if (/set problem|set theory/.test(text)) return 'Overlapping Sets';
  if (/combin|permut|probab|counting/.test(text)) return 'Counting & Probability';
  if (/distance|speed|rate|work/.test(text)) return 'Rates, Work & Motion';
  if (/sequence|functions?|custom character|inequal|absolute value/.test(text)) return 'Functions, Sequences & Inequalities';
  if (/word problem|age problem|digit problem|mixture/.test(text)) return 'General Word Problems';
  if (/percent|interest|remainder|multiple|factor|fraction|ratio|proportion|arithmetic|decimal|average|price|cost|profit|revenue|sale|sold/.test(text)) {
    return 'Arithmetic, FDP & Ratios';
  }
  if (/geometry|triangle|circle|area|volume|coordinate/.test(text)) return 'Geometry';
  if (/number properties|divis|integer|odd|even|prime/.test(text)) return 'Number Properties';
  if (/algebra|equation|quadratic|linear/.test(text)) return 'Algebra & Equations';
  return '';
}

function normalizePsTopic(text) {
  if (/overlapping sets|venn|set theory/.test(text)) return 'Overlapping Sets';
  if (/statistics|mean|median|standard deviation|variance/.test(text)) return 'Statistics';
  if (/combin|permut|probab|counting/.test(text)) return 'Counting & Probability';
  if (/distance|speed|rate|work|time/.test(text)) return 'Rates, Work & Motion';
  if (/functions?|sequence|inequal|absolute value/.test(text)) return 'Functions, Sequences & Inequalities';
  if (/word problem|age problem|digit problem|mixture|problem solving/.test(text)) return 'General Word Problems';
  if (/percent|interest|fraction|ratio|proportion|arithmetic|decimal|average|fdp|price|cost|profit|revenue|sale|sold/.test(text)) return 'Arithmetic, FDP & Ratios';
  if (/geometry|triangle|circle|area|volume|coordinate/.test(text)) return 'Geometry';
  if (/number properties|divis|remainder|integer|odd|even|prime|multiple|factor/.test(text)) return 'Number Properties';
  if (/algebra|equation|quadratic|linear/.test(text)) return 'Algebra & Equations';
  return '';
}

function looksLikeShellText(text) {
  return /skip to main content|my account|study plan|game center|practice questions|practice exams|resources search/i.test(text);
}

function inferDsTopicFromQuestion(item) {
  const stem = String(item?.questionStem || '').trim();
  if (!stem || looksLikeShellText(stem)) return '';
  const choices = formatChoices(item?.answerChoices);
  const combined = `${stem}\n${choices}`.toLowerCase();
  const inferred = normalizeDsTopic(combined);
  if (!inferred || inferred === 'Unclear Topic') return '';
  return inferred;
}

function refineTopicWithHeuristics(topic, batchItem) {
  const normalizedTopic = String(topic || '').trim();
  const categoryCode = String(batchItem?.categoryCode || batchItem?.subjectSubRaw || '').trim().toUpperCase();

  if (categoryCode === 'DS' && (!normalizedTopic || normalizedTopic === 'Unclear Topic' || normalizedTopic === 'Other')) {
    const inferred = inferDsTopicFromQuestion(batchItem);
    if (inferred) return inferred;
  }

  return normalizedTopic;
}

function normalizeGiTopic(text, contentDomain) {
  const domain = normalizeContentDomain(contentDomain);
  if (/graphs|graphics interpretation|graph|chart|plot|axis/.test(text)) return 'Graphs';
  if (domain === 'math') return 'Math-Based Interpretation';
  if (domain === 'non_math') return 'Non-Math Interpretation';
  if (/non[- ]?math|verbal|reading|inference|author|purpose/.test(text)) return 'Non-Math Interpretation';
  if (/math[- ]?based|math[- ]?related|algebra|arithmetic|rate|probab|geometry|number properties|statistics/.test(text)) {
    return 'Math-Based Interpretation';
  }
  return '';
}

function normalizeTaTopic(text, contentDomain) {
  const domain = normalizeContentDomain(contentDomain);
  if (/tables|table analysis|table/.test(text)) return 'Tables';
  if (domain === 'math') return 'Math-Based Analysis';
  if (domain === 'non_math') return 'Non-Math Analysis';
  if (/non[- ]?math|verbal|reading|inference|author|purpose/.test(text)) return 'Non-Math Analysis';
  if (/math[- ]?based|math[- ]?related|algebra|arithmetic|rate|probab|geometry|number properties|statistics/.test(text)) {
    return 'Math-Based Analysis';
  }
  return '';
}

function normalizeMsrTopic(text, contentDomain) {
  const domain = normalizeContentDomain(contentDomain);
  if (domain === 'math') return 'Math-Based Reasoning';
  if (domain === 'non_math') return 'Non-Math Reasoning';
  if (/non[- ]?math|verbal|reading|inference|author|purpose/.test(text)) return 'Non-Math Reasoning';
  if (/math[- ]?based|math[- ]?related|algebra|arithmetic|rate|probab|geometry|statistics/.test(text)) return 'Math-Based Reasoning';
  return '';
}

function normalizeTpaTopic(text, contentDomain) {
  const domain = normalizeContentDomain(contentDomain);
  if (domain === 'math') return 'Math-Based Reasoning';
  if (domain === 'non_math') return 'Non-Math Reasoning';
  if (/non[- ]?math|verbal|reading|inference|author|purpose/.test(text)) return 'Non-Math Reasoning';
  if (/math[- ]?based|math[- ]?related|algebra|arithmetic|rate|probab|geometry|statistics/.test(text)) return 'Math-Based Reasoning';
  return '';
}

function normalizeVerbalTopic(text, categoryCode) {
  const category = String(categoryCode || '').trim().toUpperCase();

  if (category === 'CR') {
    if (/strengthen|support/.test(text)) return 'Support';
    if (/weaken|flaw|vulnerable to criticism/.test(text)) return 'Attack';
    if (/assumption|evaluate|relevant to know/.test(text)) return 'Assumption';
    if (/inference|must be true|best supported|complete/.test(text)) return 'Inference';
    if (/explain|resolve|paradox|discrepancy/.test(text)) return 'Resolve';
    if (/boldface|method|technique|strategy|parallel/.test(text)) return 'Argument Structure';
    return '';
  }

  if (category === 'RC') {
    if (/main idea|main point|primary purpose|central idea|purpose/.test(text)) return 'Main Idea / Purpose';
    if (/detail|according to the passage/.test(text)) return 'Detail';
    if (/inference|must be true|best supported/.test(text)) return 'Inference';
    if (/organization|structure of the passage|serves to|function of/.test(text)) return 'Structure / Function';
    if (/author('|’)s attitude|tone|author view/.test(text)) return 'Author View';
    if (/application|apply.*principle|analogous/.test(text)) return 'Application';
    return '';
  }

  return '';
}

function normalizeTopicLabel(rawValue, options = {}) {
  const value = String(rawValue || '').trim();
  if (!value) return '';
  if (/too hard/.test(value.toLowerCase())) return '';

  const { categoryCode = '', contentDomain = '' } = options;
  const scopedLabels = CATEGORY_LABELS[String(categoryCode || '').trim()] || [];
  const scopedExact = scopedLabels.find((label) => label.toLowerCase() === value.toLowerCase());
  if (scopedExact) return scopedExact;

  const exact = ALL_TOPIC_LABELS.find((label) => label.toLowerCase() === value.toLowerCase());
  if (exact) return exact;

  const text = value.toLowerCase();
  if (categoryCode === 'DS') {
    return normalizeDsTopic(text);
  }
  if (categoryCode === 'PS') {
    return normalizePsTopic(text);
  }
  if (categoryCode === 'GI') {
    return normalizeGiTopic(text, contentDomain);
  }
  if (categoryCode === 'TA') {
    return normalizeTaTopic(text, contentDomain);
  }
  if (categoryCode === 'MSR') {
    return normalizeMsrTopic(text, contentDomain);
  }
  if (categoryCode === 'TPA') {
    return normalizeTpaTopic(text, contentDomain);
  }
  if (categoryCode === 'CR' || categoryCode === 'RC') {
    return normalizeVerbalTopic(text, categoryCode);
  }

  const psTopic = normalizePsTopic(text);
  if (psTopic) return psTopic;

  const verbalTopic = normalizeVerbalTopic(text, categoryCode || options.subjectCode || '');
  if (verbalTopic) return verbalTopic;

  if (/graphics interpretation|graphs|graph|chart|plot|axis/.test(text)) return 'Graphs';
  if (/table analysis|tables|table/.test(text)) return 'Tables';

  return '';
}

function subjectHint(question = {}, session = {}) {
  const metadata = deriveQuestionMetadata(question, session);
  const category = String(metadata.category_code || '').trim().toUpperCase();
  const subjectCode = String(metadata.subject_code || '').trim().toUpperCase();

  if (category === 'QUANT' || category === 'PS' || category === 'DS') return 'math-oriented';
  if (category === 'CR' || category === 'RC') return 'verbal-oriented';
  if (subjectCode === 'DI') return 'data-insights';
  if (subjectCode === 'Q') return 'math-oriented';
  if (subjectCode === 'V') return 'verbal-oriented';
  return 'unknown';
}

function formatChoices(answerChoices) {
  if (!Array.isArray(answerChoices) || !answerChoices.length) return '';
  const lines = answerChoices
    .map((choice) => {
      const label = String(choice?.label || '').trim();
      const text = String(choice?.text || '').trim();
      if (!label && !text) return '';
      if (!label) return text;
      return `${label}. ${text}`;
    })
    .filter(Boolean);
  return clipText(lines.join('\n'), MAX_CHOICES_CHARS);
}

function normalizeContentDomain(rawValue) {
  const text = String(rawValue || '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'math' || text === 'math_related' || text === 'math-related') return 'math';
  if (text === 'non_math' || text === 'non-math' || text === 'verbal' || text === 'verbal_reasoning') {
    return 'non_math';
  }
  return '';
}

function inferContentDomainFromTopic(topic) {
  const normalizedTopic = normalizeTopicLabel(topic);
  if (!normalizedTopic) return '';
  if (PS_LABELS.includes(normalizedTopic) || DS_LABELS.includes(normalizedTopic)) return 'math';
  if (VERBAL_LABELS.includes(normalizedTopic)) return 'non_math';
  if (['Math-Based Reasoning', 'Math-Based Interpretation', 'Math-Based Analysis'].includes(normalizedTopic)) return 'math';
  if (['Non-Math Reasoning', 'Non-Math Interpretation', 'Non-Math Analysis'].includes(normalizedTopic)) {
    return 'non_math';
  }
  return '';
}

function extractJsonArray(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const directCandidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) directCandidates.push(fenced.trim());

  const bracketStart = raw.indexOf('[');
  const bracketEnd = raw.lastIndexOf(']');
  if (bracketStart >= 0 && bracketEnd > bracketStart) {
    directCandidates.push(raw.slice(bracketStart, bracketEnd + 1));
  }

  for (const candidate of directCandidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.results)) return parsed.results;
    } catch (_error) {
      // Try next candidate.
    }
  }

  return [];
}

async function classifyBatch(model, batch) {
  const payload = batch.map((item) => ({
    id: item.id,
    source: item.source,
    subject_hint: item.subjectHint,
    category_code: item.categoryCode,
    subject_sub_raw: item.subjectSubRaw,
    existing_topic: item.existingTopic,
    question_stem: clipText(item.questionStem, MAX_STEM_CHARS),
    answer_choices: formatChoices(item.answerChoices),
  }));

  const messages = [
    new SystemMessage(
      [
        'Classify each GMAT question into exactly one topic label.',
        'Return strict JSON only as an array of objects: [{"id":"...","topic":"...","content_domain":""}].',
        `Allowed Quant labels: ${PS_LABELS.join(', ')}`,
        `Allowed Verbal labels: ${VERBAL_LABELS.join(', ')}`,
        `Allowed DS labels: ${DS_LABELS.join(', ')}`,
        `Allowed GI labels: ${GI_LABELS.join(', ')}`,
        `Allowed TA labels: ${TA_LABELS.join(', ')}`,
        `Allowed MSR labels: ${MSR_LABELS.join(', ')}`,
        `Allowed TPA labels: ${TPA_LABELS.join(', ')}`,
        'Allowed fallback label: Other',
        'Keep the same hierarchy: subject -> category -> subcategory.',
        'Keep verbal category labels as CR or RC. Do not replace CR or RC with a white-label category name.',
        'Use the grouped Quant labels for PS.',
        'Use the grouped verbal labels for CR and RC.',
        'Use the category_code on each item to choose a grouped subcategory whenever possible.',
        'Never return any label containing "Too Hard".',
        'For DS, use the DS whitelist labels instead of generic PS labels.',
        'Use "Unclear Topic" for DS only when the scraped content is malformed, generic site chrome, or truly insufficient to determine a DS domain.',
        'If the DS stem is readable, choose the best-fit DS label instead of defaulting to "Unclear Topic".',
        'For GI and TA, use only the category-specific whitelist labels.',
        'For MSR and TPA, use only the MSR/TPA whitelist labels.',
        'If subject_sub_raw is TPA or MSR, also classify content_domain as either "math" or "non_math".',
        'For non-TPA/MSR questions, return content_domain as an empty string.',
      ].join('\n')
    ),
    new HumanMessage(JSON.stringify(payload, null, 2)),
  ];

  try {
    const response = await model.invoke(messages);
    const text = extractModelText(response);
    const parsed = extractJsonArray(text);
    const map = new Map();
    for (const item of parsed) {
      const id = String(item?.id || '').trim();
      const batchItem = batch.find((candidate) => candidate.id === id);
      const normalizedTopic = normalizeTopicLabel(item?.topic, {
        categoryCode: batchItem?.categoryCode || batchItem?.subjectSubRaw || '',
        contentDomain: item?.content_domain,
      });
      const topic = refineTopicWithHeuristics(normalizedTopic, batchItem);
      const contentDomain = normalizeContentDomain(item?.content_domain);
      if (!id || !topic) continue;
      map.set(id, {
        topic,
        contentDomain,
      });
    }
    return map;
  } catch (error) {
    throw classifyLlmError(error);
  }
}

async function classifyScrapedQuestions(data, options = {}) {
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const items = [];
  let sequence = 0;

  for (const session of sessions) {
    for (const question of Array.isArray(session?.questions) ? session.questions : []) {
      const questionStem = clipText(question?.question_stem || '', MAX_STEM_CHARS);
      const answerChoices = Array.isArray(question?.answer_choices) ? question.answer_choices : [];
      if (!questionStem && !answerChoices.length) continue;

      items.push({
        id: `q_${sequence += 1}`,
        source: String(session?.source || '').trim(),
        subjectHint: subjectHint(question, session),
        categoryCode: String(deriveQuestionMetadata(question, session)?.category_code || '').trim(),
        subjectSubRaw: String(question?.category_code || question?.subject_sub_raw || question?.subject_sub || '').trim().toUpperCase(),
        existingTopic: String(question?.subcategory || question?.topic || '').trim(),
        questionStem,
        answerChoices,
        questionRef: question,
      });
    }
  }

  if (!items.length) {
    return {
      attempted: 0,
      classified: 0,
      batches: 0,
      skipped: true,
      reason: 'no_question_content',
    };
  }

  const model = buildModel({ scope: 'classifier' });
  const batchSize = Math.max(1, Number(options.batchSize || DEFAULT_BATCH_SIZE));
  let classified = 0;

  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const result = await classifyBatch(model, batch);
    for (const item of batch) {
      const classification = result.get(item.id);
      if (!classification?.topic) continue;
      item.questionRef.subcategory = classification.topic;
      item.questionRef.topic = classification.topic;
      item.questionRef.topic_source = 'llm';
      if (item.subjectSubRaw === 'TPA' || item.subjectSubRaw === 'MSR') {
        item.questionRef.content_domain =
          classification.contentDomain ||
          inferContentDomainFromTopic(classification.topic) ||
          null;
      }
      classified += 1;
    }
  }

  return {
    attempted: items.length,
    classified,
    batches: Math.ceil(items.length / batchSize),
    skipped: false,
  };
}

module.exports = {
  ALL_TOPIC_LABELS,
  classifyScrapedQuestions,
};
