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

function normalizeCategoryCode(value, { subjectCode = '', topic = '', catId = null } = {}) {
  const upper = String(value || '').trim().toUpperCase();
  if (upper) {
    if (['QUANT', 'Q', 'PS'].includes(upper)) return 'Quant';
    if (['CR', 'RC', 'DS', 'MSR', 'TPA', 'GI', 'TA'].includes(upper)) return upper;
  }

  const normalizedCatId = Number(catId);
  if (Number.isInteger(normalizedCatId)) {
    if (normalizedCatId === 1337013) return 'CR';
    if (normalizedCatId === 1337023) return 'RC';
  }

  if (subjectCode === 'Q') return 'Quant';
  if (subjectCode === 'V') return inferVerbalCategoryFromDomain(topic);
  if (subjectCode === 'DI') {
    const topicUpper = String(topic || '').trim().toUpperCase();
    if (topicUpper === 'DATA SUFFICIENCY') return 'DS';
  }

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

  return {
    subject_code: subjectCode || null,
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
