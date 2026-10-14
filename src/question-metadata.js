function normalizedTextOrNull(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeSubjectCode(value) {
  const upper = String(value || '').trim().toUpperCase();
  if (!upper) return '';
  if (['Q', 'QUANT', 'QUANTITATIVE', 'PS'].includes(upper)) return 'Q';
  if (['V', 'VERBAL', 'CR', 'RC'].includes(upper)) return 'V';
  if (['DI', 'DS', 'MSR', 'TPA', 'GI', 'TA'].includes(upper)) return 'DI';
  return '';
}

function inferVerbalCategoryFromDomain(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  const upper = text.toUpperCase();
  if (upper === 'CR' || upper === 'RC') return upper;

  const normalized = text.toLowerCase();
  if (
    /(support|attack|assumption|resolve|argument structure|weaken|strengthen|boldface|evaluate|flaw|parallel|method|complete|explain)/.test(normalized)
  ) {
    return 'CR';
  }
  if (
    /(main idea \/ purpose|detail|structure \/ function|author view|application|main idea|purpose|author attitude|organization)/.test(normalized)
  ) {
    return 'RC';
  }
  return '';
}

function inferCategoryCodeFromCatId(catId) {
  const normalizedCatId = Number(catId);
  if (!Number.isInteger(normalizedCatId)) return '';

  if (normalizedCatId === 1337013 || normalizedCatId === 1336843 || normalizedCatId === 1336863) return 'CR';
  if (normalizedCatId === 1337023 || normalizedCatId === 1336833 || normalizedCatId === 1336853) return 'RC';
  if (normalizedCatId === 1336733 || normalizedCatId === 1336743) return 'DS';
  if (normalizedCatId === 1336753) return 'MSR';
  if (normalizedCatId === 1336763) return 'TA';
  if (normalizedCatId === 1336773) return 'GI';
  if (normalizedCatId === 1336783) return 'TPA';
  if (normalizedCatId === 1336803 || normalizedCatId === 1336813) return 'PS';

  return '';
}

// GMAT Club's Error Log names only the CONTENT topic on a row — its category
// chips read "Word Problems", "Number Properties", "Overlapping Sets" — and
// never the question FORMAT. A Data Sufficiency question therefore arrives
// tagged exactly like a Problem Solving one, and the scraper's category map,
// having nothing else to go on, codes every quant topic 'PS'. Under GMAT Focus
// that is the wrong section: DS is Data Insights, not Quant.
//
// The statement pair is the format's signature and the Error Log's Question
// cell carries it, so it is the one format signal the row holds. Measured over
// the 813 stored quant rows it splits them 189/624, and spot-checking both
// sides found no misfile in either direction.
//
// Deliberately positive-only: a stem truncated before "(1)" stays PS. Missing
// a DS question leaves it where it already was, whereas a false positive would
// push a genuine PS question out of Quant.
const DS_STATEMENT_PAIR = /\(1\)[\s\S]{0,600}\(2\)/;

function looksLikeDataSufficiency(stem) {
  return DS_STATEMENT_PAIR.test(String(stem || ''));
}

function inferCategoryCodeFromTopic(value) {
  const upper = String(value || '').trim().toUpperCase();
  if (!upper) return '';

  if (upper === 'DATA SUFFICIENCY') return 'DS';
  if (upper === 'UNCLEAR TOPIC') return 'DS';
  // PS/DS share these subcategory labels. Default to PS so sources without an
  // explicit category signal (e.g., GMAT Club forum rows) still get a valid
  // subject. StartTest rows already carry an authoritative `category_code`,
  // so this fallback never fires for them.
  if (
    [
      'ALGEBRA & EQUATIONS',
      'ARITHMETIC, FDP & RATIOS',
      'NUMBER PROPERTIES',
      'RATES, WORK & MOTION',
      'STATISTICS',
      'OVERLAPPING SETS',
      'COUNTING & PROBABILITY',
      'GEOMETRY',
      'FUNCTIONS, SEQUENCES & INEQUALITIES',
      'GENERAL WORD PROBLEMS',
    ].includes(upper)
  ) {
    return 'PS';
  }
  if (upper === 'MULTI-SOURCE REASONING' || upper === 'MSR MATH RELATED' || upper === 'MSR NON-MATH RELATED') return 'MSR';
  if (upper === 'MATH-BASED REASONING' || upper === 'NON-MATH REASONING') return '';
  if (upper === 'TABLE ANALYSIS' || upper === 'G&T TABLES') return 'TA';
  if (upper === 'TABLES' || upper === 'MATH-BASED ANALYSIS' || upper === 'NON-MATH ANALYSIS') return 'TA';
  if (upper === 'GRAPHICS INTERPRETATION' || upper === 'G&T GRAPHS' || upper === 'G&T MATH RELATED' || upper === 'G&T NON-MATH RELATED') return 'GI';
  if (upper === 'GRAPHS' || upper === 'MATH-BASED INTERPRETATION' || upper === 'NON-MATH INTERPRETATION') return 'GI';
  if (upper === 'TWO-PART ANALYSIS' || upper === 'TPA MATH RELATED' || upper === 'TPA NON-MATH RELATED') return 'TPA';
  if (upper === 'MATH-BASED REASONING' || upper === 'NON-MATH REASONING') return '';

  return inferVerbalCategoryFromDomain(upper);
}

function normalizeCategoryCode(value, { subjectCode = '', topic = '', catId = null } = {}) {
  const upper = String(value || '').trim().toUpperCase();
  if (upper) {
    if (['PS', 'QUANT', 'Q'].includes(upper)) return 'PS';
    if (['CR', 'RC', 'DS', 'MSR', 'TPA', 'GI', 'TA'].includes(upper)) return upper;
  }

  const categoryFromCatId = inferCategoryCodeFromCatId(catId);
  if (categoryFromCatId) return categoryFromCatId;

  const categoryFromTopic = inferCategoryCodeFromTopic(topic);
  if (categoryFromTopic) return categoryFromTopic;

  if (subjectCode === 'Q') return 'PS';
  if (subjectCode === 'V') return inferVerbalCategoryFromDomain(topic);

  return '';
}

function deriveQuestionMetadata(question = {}, session = {}) {
  const rawTopic = normalizedTextOrNull(question.subcategory || question.topic) || '';
  const subjectCode =
    normalizeSubjectCode(
      question.subject_code ||
        session.subject_code ||
        question.subject ||
        session.subject ||
        question.category_code ||
        question.subject_sub_raw ||
        question.subject_sub
    ) || '';

  const categoryCode =
    normalizeCategoryCode(question.category_code, {
      subjectCode,
      topic: rawTopic,
      catId: question.cat_id,
    }) ||
    normalizeCategoryCode(question.subject_sub_raw, {
      subjectCode,
      topic: rawTopic,
      catId: question.cat_id,
    }) ||
    normalizeCategoryCode(question.subject_sub, {
      subjectCode,
      topic: rawTopic,
      catId: question.cat_id,
    }) ||
    normalizeCategoryCode(session.subject, {
      subjectCode,
      topic: rawTopic,
      catId: question.cat_id,
    }) ||
    '';

  // Rescue a Data Sufficiency row that only had a quant CONTENT topic to go on
  // (see looksLikeDataSufficiency). Gated on the row carrying no authoritative
  // category_code, which is what keeps StartTest and the GMAT Club CAT out of
  // it: both name the format outright, so their 'PS' is a fact rather than the
  // Error Log's inference from a topic chip.
  const resolvedCategoryCode =
    !question.category_code && categoryCode === 'PS' && looksLikeDataSufficiency(question.question_stem)
      ? 'DS'
      : categoryCode;

  const resolvedSubjectCode = normalizeSubjectCode(resolvedCategoryCode) || subjectCode || '';

  return {
    subject_code: resolvedSubjectCode || null,
    category_code: resolvedCategoryCode || null,
    subcategory: normalizedTextOrNull(question.subcategory || question.topic) || null,
  };
}

function enrichQuestionMetadata(row = {}, session = {}) {
  return {
    ...row,
    ...deriveQuestionMetadata(row, session),
  };
}

module.exports = {
  deriveQuestionMetadata,
  enrichQuestionMetadata,
};
