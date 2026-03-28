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
    /(weaken|strengthen|assumption|boldface|evaluate|flaw|parallel|method|complete|explain)/.test(normalized)
  ) {
    return 'CR';
  }
  if (
    /(main idea|detail|purpose|author attitude|organization|application)/.test(normalized)
  ) {
    return 'RC';
  }
  return '';
}

function inferCategoryCodeFromCatId(catId) {
  const normalizedCatId = Number(catId);
  if (!Number.isInteger(normalizedCatId)) return '';

  if (normalizedCatId === 1337013 || normalizedCatId === 1336833 || normalizedCatId === 1336853) return 'RC';
  if (normalizedCatId === 1337023 || normalizedCatId === 1336843 || normalizedCatId === 1336863) return 'CR';
  if (normalizedCatId === 1336733 || normalizedCatId === 1336743) return 'DS';
  if (normalizedCatId === 1336753) return 'MSR';
  if (normalizedCatId === 1336763) return 'TA';
  if (normalizedCatId === 1336773) return 'GI';
  if (normalizedCatId === 1336783) return 'TPA';
  if (normalizedCatId === 1336803 || normalizedCatId === 1336813) return 'PS';

  return '';
}

function inferCategoryCodeFromTopic(value) {
  const upper = String(value || '').trim().toUpperCase();
  if (!upper) return '';

  if (upper === 'DATA SUFFICIENCY') return 'DS';
  if (upper === 'MULTI-SOURCE REASONING' || upper === 'MSR MATH RELATED' || upper === 'MSR NON-MATH RELATED') return 'MSR';
  if (upper === 'TABLE ANALYSIS' || upper === 'G&T TABLES') return 'TA';
  if (upper === 'GRAPHICS INTERPRETATION' || upper === 'G&T GRAPHS' || upper === 'G&T MATH RELATED' || upper === 'G&T NON-MATH RELATED') return 'GI';
  if (upper === 'TWO-PART ANALYSIS' || upper === 'TPA MATH RELATED' || upper === 'TPA NON-MATH RELATED') return 'TPA';

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

  const resolvedSubjectCode = normalizeSubjectCode(categoryCode) || subjectCode || '';

  return {
    subject_code: resolvedSubjectCode || null,
    category_code: categoryCode || null,
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
  normalizeSubjectCode,
  normalizeCategoryCode,
  deriveQuestionMetadata,
  enrichQuestionMetadata,
};
