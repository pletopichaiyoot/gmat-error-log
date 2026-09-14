// scripts/og/select-source.js
// A re-OCR'd book has two text layers, and neither is better everywhere.
// Measured on OG13: Tesseract's redo fixes the body text — 418 lines of "(0"
// misread for "(C)" drop to zero and glued words fall to the clean-text
// baseline — but it rasterizes the answer-key table into numbers with no
// letter column, and loses two thirds of the question numbers in the answer
// explanations (707 numbered lines become 243).
//
// So the layer is chosen per region, by how well that region actually parses
// for the job it does: keys recovered, questions with a full set of choices,
// explanation entries carrying a key. No per-book table to maintain, and the
// choice re-measures itself if the OCR is ever redone differently.

const { parseAnswerKey } = require('./answer-key');
const { parseQuestions } = require('./questions');
const { parseExplanations } = require('./explanations');

const REGIONS = ['practice', 'key', 'explanations'];

function scoreRegions(regions) {
  const key = parseAnswerKey(regions.key || []).keys.size;
  const practice = parseQuestions(regions.practice || []).questions
    .filter(q => q.choices.length === 5).length;
  const explanations = parseExplanations(regions.explanations || []).entries
    .filter(e => e.key).length;
  return { practice, key, explanations };
}

// candidates: [{tag, regions}] or [{tag, error}] for a layer that would not parse.
function pickRegions(candidates) {
  const usable = candidates.filter(c => c.regions);
  if (usable.length === 0) {
    const why = candidates.map(c => `${c.tag}: ${c.error || 'no regions'}`).join('; ');
    throw new Error(`No usable text layer — ${why}`);
  }

  const scored = usable.map(c => ({ ...c, score: scoreRegions(c.regions) }));
  const regions = {};
  const sources = {};
  const scores = {};
  for (const region of REGIONS) {
    // Ties keep the earlier candidate, so a single layer needs no special case.
    let best = scored[0];
    for (const c of scored) if (c.score[region] > best.score[region]) best = c;
    regions[region] = best.regions[region];
    sources[region] = best.tag;
    scores[region] = Object.fromEntries(scored.map(c => [c.tag, c.score[region]]));
  }
  return { regions, sources, scores };
}

module.exports = { pickRegions, scoreRegions };
