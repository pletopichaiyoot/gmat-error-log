const { HumanMessage, SystemMessage } = require('@langchain/core/messages');

const {
  buildModel,
  extractModelText,
  classifyLlmError,
} = require('./llm-coach-agent');
const { deriveQuestionMetadata } = require('./question-metadata');

const MATH_LABELS = [
  'Arithmetic',
  'Algebra',
  'Number Properties',
  'Ratios & Percents',
  'Rates & Work',
  'Counting & Probability',
  'Statistics',
  'Geometry',
  'Functions & Sequences',
  'Word Problems',
  'Data Sufficiency',
  'Problem Solving',
];

const DS_LABELS = [
  'Sequences',
  'Functions and Custom Characters',
  'Word Problems',
  'Arithmetic',
  'Absolute Values',
  'Statistics and Sets Problems',
  'Algebra',
  'Percent and Interest Problems',
  'Remainders',
  'Multiples and Factors',
  'Fractions and Ratios',
  'Geometry',
  'Number Properties',
  'Inequalities',
  'Work and Rate Problems',
  'Probability',
  'Poor Quality',
  'Overlapping Sets',
  'Mixture Problems',
  'Distance and Speed Problems',
  'Combinations',
];

const GT_LABELS = [
  'G&T Tables',
  'G&T Non-Math Related',
  'G&T Math Related',
  'G&T Graphs',
];

const MSR_LABELS = [
  'MSR Non-Math Related',
  'MSR Math Related',
];

const TPA_LABELS = [
  'TPA Math Related',
  'TPA Non-Math Related',
];

const VERBAL_LABELS = [
  'Weaken',
  'Strengthen',
  'Assumption',
  'Inference',
  'Explain',
  'Boldface',
  'Evaluate',
  'Flaw',
  'Method',
  'Parallel',
  'Main Idea',
  'Detail',
  'Purpose',
  'Author Attitude',
  'Organization',
  'Application',
  'Complete',
];

const DI_FORMAT_LABELS = [
  'Table Analysis',
  'Graphics Interpretation',
  'Two-Part Analysis',
  'Multi-Source Reasoning',
];

const CATEGORY_LABELS = {
  DS: DS_LABELS,
  GI: GT_LABELS,
  TA: GT_LABELS,
  MSR: MSR_LABELS,
  TPA: TPA_LABELS,
};

const ALL_TOPIC_LABELS = [
  ...new Set([
    ...MATH_LABELS,
    ...VERBAL_LABELS,
    ...DI_FORMAT_LABELS,
    ...DS_LABELS,
    ...GT_LABELS,
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
  if (/poor quality|bad question|ambiguous/.test(text)) return 'Poor Quality';
  if (/overlapping sets|venn/.test(text)) return 'Overlapping Sets';
  if (/mixture/.test(text)) return 'Mixture Problems';
  if (/distance|speed/.test(text)) return 'Distance and Speed Problems';
  if (/combin|permut/.test(text)) return 'Combinations';
  if (/sequence/.test(text)) return 'Sequences';
  if (/functions?|custom character/.test(text)) return 'Functions and Custom Characters';
  if (/word problem|age problem|digit problem/.test(text)) return 'Word Problems';
  if (/absolute value/.test(text)) return 'Absolute Values';
  if (/statistics|set problem|set theory/.test(text)) return 'Statistics and Sets Problems';
  if (/percent|interest/.test(text)) return 'Percent and Interest Problems';
  if (/remainder/.test(text)) return 'Remainders';
  if (/multiple|factor/.test(text)) return 'Multiples and Factors';
  if (/fraction|ratio|proportion/.test(text)) return 'Fractions and Ratios';
  if (/inequal/.test(text)) return 'Inequalities';
  if (/rate|work/.test(text)) return 'Work and Rate Problems';
  if (/probab|counting/.test(text)) return 'Probability';
  if (/geometry|triangle|circle|area|volume|coordinate/.test(text)) return 'Geometry';
  if (/number properties|divis|integer|odd|even|prime/.test(text)) return 'Number Properties';
  if (/algebra|equation|quadratic|linear/.test(text)) return 'Algebra';
  if (/arithmetic|decimal|average/.test(text)) return 'Arithmetic';
  return '';
}

function normalizeGtTopic(text, categoryCode) {
  if (/non[- ]?math|verbal|reading|inference|author|purpose/.test(text)) return 'G&T Non-Math Related';
  if (/math[- ]?related|algebra|arithmetic|rate|probab|geometry|number properties|statistics/.test(text)) {
    return 'G&T Math Related';
  }
  if (categoryCode === 'TA' || /table/.test(text)) return 'G&T Tables';
  if (categoryCode === 'GI' || /graph|chart|plot|axis/.test(text)) return 'G&T Graphs';
  return '';
}

function normalizeMsrTopic(text, contentDomain) {
  const domain = normalizeContentDomain(contentDomain);
  if (domain === 'math') return 'MSR Math Related';
  if (domain === 'non_math') return 'MSR Non-Math Related';
  if (/non[- ]?math|verbal|reading|inference|author|purpose/.test(text)) return 'MSR Non-Math Related';
  if (/math[- ]?related|algebra|arithmetic|rate|probab|geometry|statistics/.test(text)) return 'MSR Math Related';
  return '';
}

function normalizeTpaTopic(text, contentDomain) {
  const domain = normalizeContentDomain(contentDomain);
  if (domain === 'math') return 'TPA Math Related';
  if (domain === 'non_math') return 'TPA Non-Math Related';
  if (/non[- ]?math|verbal|reading|inference|author|purpose/.test(text)) return 'TPA Non-Math Related';
  if (/math[- ]?related|algebra|arithmetic|rate|probab|geometry|statistics/.test(text)) return 'TPA Math Related';
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
  if (categoryCode === 'GI' || categoryCode === 'TA') {
    return normalizeGtTopic(text, categoryCode);
  }
  if (categoryCode === 'MSR') {
    return normalizeMsrTopic(text, contentDomain);
  }
  if (categoryCode === 'TPA') {
    return normalizeTpaTopic(text, contentDomain);
  }

  if (/probab|counting|permut|combinat/.test(text)) return 'Counting & Probability';
  if (/ratio|percent|proportion/.test(text)) return 'Ratios & Percents';
  if (/rate|work|speed|distance|time/.test(text)) return 'Rates & Work';
  if (/number properties|divis|remainder|integer|odd|even|prime|factor|multiple/.test(text)) return 'Number Properties';
  if (/functions?|sequence/.test(text)) return 'Functions & Sequences';
  if (/geometry|triangle|circle|area|volume|coordinate/.test(text)) return 'Geometry';
  if (/statistics|mean|median|standard deviation|variance/.test(text)) return 'Statistics';
  if (/algebra|equation|inequal|quadratic|linear/.test(text)) return 'Algebra';
  if (/arithmetic|fraction|decimal|average/.test(text)) return 'Arithmetic';
  if (/word problem|age problem|mixture|digit problem/.test(text)) return 'Word Problems';
  if (/data sufficiency|\bds\b/.test(text)) return 'Data Sufficiency';
  if (/problem solving|\bps\b/.test(text)) return 'Problem Solving';

  if (/strengthen|support/.test(text)) return 'Strengthen';
  if (/weaken/.test(text)) return 'Weaken';
  if (/assumption/.test(text)) return 'Assumption';
  if (/inference|must be true|best supported/.test(text)) return 'Inference';
  if (/explain|resolve|paradox|discrepancy/.test(text)) return 'Explain';
  if (/boldface/.test(text)) return 'Boldface';
  if (/evaluate|relevant to know/.test(text)) return 'Evaluate';
  if (/flaw|vulnerable to criticism/.test(text)) return 'Flaw';
  if (/method|technique|strategy/.test(text)) return 'Method';
  if (/parallel/.test(text)) return 'Parallel';
  if (/main idea|main point|primary purpose|central idea/.test(text)) return 'Main Idea';
  if (/detail|according to the passage/.test(text)) return 'Detail';
  if (/purpose|serves to|function of/.test(text)) return 'Purpose';
  if (/author('|’)s attitude|tone/.test(text)) return 'Author Attitude';
  if (/organization|structure of the passage/.test(text)) return 'Organization';
  if (/application|apply.*principle|analogous/.test(text)) return 'Application';
  if (/complete/.test(text)) return 'Complete';

  if (/table analysis/.test(text)) return 'Table Analysis';
  if (/graphics interpretation/.test(text)) return 'Graphics Interpretation';
  if (/two-part analysis/.test(text)) return 'Two-Part Analysis';
  if (/multi-source reasoning/.test(text)) return 'Multi-Source Reasoning';

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
  if (MATH_LABELS.includes(normalizedTopic)) return 'math';
  if (VERBAL_LABELS.includes(normalizedTopic)) return 'non_math';
  if (['MSR Math Related', 'TPA Math Related', 'G&T Math Related'].includes(normalizedTopic)) return 'math';
  if (['MSR Non-Math Related', 'TPA Non-Math Related', 'G&T Non-Math Related'].includes(normalizedTopic)) {
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
        `Allowed Quant labels: ${MATH_LABELS.join(', ')}`,
        `Allowed Verbal labels: ${VERBAL_LABELS.join(', ')}`,
        `Allowed DS labels: ${DS_LABELS.join(', ')}`,
        `Allowed G&T labels for GI/TA: ${GT_LABELS.join(', ')}`,
        `Allowed MSR labels: ${MSR_LABELS.join(', ')}`,
        `Allowed TPA labels: ${TPA_LABELS.join(', ')}`,
        `Allowed DI format fallback labels: ${DI_FORMAT_LABELS.join(', ')}`,
        'Allowed fallback label: Other',
        'Keep the same hierarchy: subject -> category -> subcategory.',
        'Keep verbal category labels as CR or RC. Do not replace CR or RC with a white-label category name.',
        'Use the existing Quant and Verbal topic labels unless the item is DS or another DI category.',
        'Use the category_code on each item to choose a white-label subcategory only for DS and DI categories whenever possible.',
        'Never return any label containing "Too Hard".',
        'For DS, use the DS whitelist labels instead of generic math labels.',
        'For GI and TA, use only the G&T whitelist labels.',
        'For MSR and TPA, use only the MSR/TPA whitelist labels.',
        'Use DI format fallback labels only when the category-specific whitelist truly does not fit.',
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
      const topic = normalizeTopicLabel(item?.topic, {
        categoryCode: batchItem?.categoryCode || batchItem?.subjectSubRaw || '',
        contentDomain: item?.content_domain,
      });
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
