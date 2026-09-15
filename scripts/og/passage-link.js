// scripts/og/passage-link.js
// Assign each RC question its passage, using the ranges the answer
// explanations print ("Questions 1-3 refer to the passage on page 358.").
// That reference is the only place the books state which questions share a
// passage, and which printed page it sits on.

function passageIdFor(bookCode, page) {
  return `${bookCode}-RC-p${page}`;
}

function linkQuestionsToPassages(section, bookCode) {
  section.unlinked = [];
  if (section.kind !== 'RC') return section;

  const refs = [...section.passageRefs].sort((a, b) => a.firstQuestion - b.firstQuestion);
  for (let i = 1; i < refs.length; i++) {
    if (refs[i].firstQuestion <= refs[i - 1].lastQuestion) {
      throw new Error(
        `passage ranges overlap: ${refs[i - 1].firstQuestion}-${refs[i - 1].lastQuestion} ` +
        `and ${refs[i].firstQuestion}-${refs[i].lastQuestion}`);
    }
  }

  for (const q of section.questions) {
    const ref = refs.find(r => q.number >= r.firstQuestion && q.number <= r.lastQuestion);
    // A reference printed as "the passage above" carries no page, so it cannot
    // name a passage to fetch.
    q.passageId = ref && ref.page ? passageIdFor(bookCode, ref.page) : null;
    if (!q.passageId) section.unlinked.push(q.id);
  }
  return section;
}

module.exports = { linkQuestionsToPassages, passageIdFor };
