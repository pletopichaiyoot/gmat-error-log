// Pure helpers for dashboard trend signal. No React, no DOM — unit-testable.
// ESM .mjs so a CJS node:test can require() it under Node 24 require-esm
// (mirrors client/src/studyPlanReorder.mjs).

// Bucket sessions into a chronological accuracy series (oldest→newest).
// sessions: [{ session_date: 'YYYY-MM-DD'|ISO, [accuracyKey]: number }]
export function buildAccuracyTrend(sessions, { limit = 12, accuracyKey = 'answered_accuracy_pct' } = {}) {
  const rows = (Array.isArray(sessions) ? sessions : [])
    .map((s) => ({ date: String(s?.session_date || '').slice(0, 10), acc: Number(s?.[accuracyKey]) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.acc))
    .sort((a, b) => a.date.localeCompare(b.date));
  const series = rows.slice(-limit).map((r) => r.acc);
  const delta = series.length >= 2
    ? Number((series[series.length - 1] - series[0]).toFixed(1))
    : null;
  return { series, delta };
}

// Weakest category = lowest accuracy_pct among rows meeting a min-volume floor.
export function pickWeakestCategory(rows, { minTotal = 5 } = {}) {
  const eligible = (Array.isArray(rows) ? rows : []).filter(
    (r) => Number(r?.total_questions) >= minTotal && Number.isFinite(Number(r?.accuracy_pct)),
  );
  if (!eligible.length) return null;
  return eligible.reduce((worst, r) => (Number(r.accuracy_pct) < Number(worst.accuracy_pct) ? r : worst));
}
