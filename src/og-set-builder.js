// Resolve a set-builder filter payload to an ordered list of question ids.
//
// Pure: it takes the pool, the filters and the user's attempt history as plain
// values and returns ids. No database, no file reads — which is what makes the
// RC grouping rules testable.
//
// Two rules carry the design:
//
//  * Filters AND across axes and OR within an axis. An empty selection on an
//    axis means "no constraint", never "nothing".
//  * RC draws WHOLE PASSAGES. A count-based draw that split a group would hand
//    the user three questions about a passage whose other three they never see,
//    which is not practiceable. The delivered count is therefore approximate and
//    the caller reports the real one.

const UNLABELED = '(unlabeled)';
const UNCLASSIFIED = '(unclassified)';

// Fisher-Yates against an injectable rng, so a test can fix the order.
function shuffle(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function matchesAxis(selected, value) {
  if (!Array.isArray(selected) || selected.length === 0) return true;
  return selected.includes(value);
}

function matchesHistory(mode, id, history) {
  if (mode === 'unseen') return !history.attempted.has(id);
  if (mode === 'wrong') return history.wrong.has(id);
  return true;
}

// Everything except the book and kind axes, which gate a whole RC group rather
// than one question.
function matchesQuestion(q, filters, history) {
  return matchesAxis(filters.typeLabels, q.typeLabel || UNLABELED)
    && matchesAxis(filters.questionTypes, q.questionType || UNCLASSIFIED)
    && matchesAxis(filters.difficulties, q.difficulty || UNLABELED)
    && matchesHistory(filters.historyMode, q.id, history);
}

function buildOgSet({ pool, filters, history, rng = Math.random }) {
  const count = Math.max(1, Number(filters.count) || 10);
  const kind = filters.kind === 'RC' ? 'RC' : 'CR';
  const hist = {
    attempted: (history && history.attempted) || new Set(),
    wrong: (history && history.wrong) || new Set(),
  };

  const inScope = pool.questions.filter(
    (q) => q.kind === kind && matchesAxis(filters.books, q.bookCode)
  );

  if (kind === 'CR') {
    const picked = shuffle(inScope.filter((q) => matchesQuestion(q, filters, hist)), rng).slice(0, count);
    return {
      questionIds: picked.map((q) => q.id),
      passageIds: [],
      requested: count,
      actual: picked.length,
      passageCount: 0,
      shortfall: picked.length < count,
    };
  }

  // RC: group by passage, qualify a group on ANY member matching, deliver the
  // group whole and in printed order.
  const groups = new Map();
  for (const q of inScope) {
    const pid = q.passageId || `__no-passage__${q.id}`;
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(q);
  }

  const qualified = [];
  for (const [pid, members] of groups.entries()) {
    if (!members.some((q) => matchesQuestion(q, filters, hist))) continue;
    qualified.push({ pid, members: members.slice().sort((a, b) => (a.number || 0) - (b.number || 0)) });
  }

  // Greedy fit: a group that would overshoot the remaining count is skipped, not
  // truncated. Skipping rather than stopping lets a smaller passage later in the
  // shuffle fill the tail.
  const questionIds = [];
  const passageIds = [];
  for (const group of shuffle(qualified, rng)) {
    if (questionIds.length + group.members.length > count) continue;
    passageIds.push(group.pid);
    for (const q of group.members) questionIds.push(q.id);
    if (questionIds.length >= count) break;
  }

  return {
    questionIds,
    passageIds,
    requested: count,
    actual: questionIds.length,
    passageCount: passageIds.length,
    shortfall: questionIds.length < count,
  };
}

module.exports = { buildOgSet, UNLABELED, UNCLASSIFIED };
