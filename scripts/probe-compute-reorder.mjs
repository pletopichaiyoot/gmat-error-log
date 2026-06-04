import assert from 'node:assert/strict';
import {
  computeReorder,
  dayDroppableId,
  sortTasks,
} from '../client/src/studyPlanReorder.mjs';

const dayMeta = {
  '2026-06-05': { week_number: 1, day_label: 'Thu', day_theme: 'A' },
  '2026-06-06': { week_number: 1, day_label: 'Fri', day_theme: 'B' },
};

const base = () => [
  { id: 1, day_date: '2026-06-05', position: 0, week_number: 1, day_label: 'Thu', day_theme: 'A', title: 't1' },
  { id: 2, day_date: '2026-06-05', position: 1, week_number: 1, day_label: 'Thu', day_theme: 'A', title: 't2' },
  { id: 3, day_date: '2026-06-05', position: 2, week_number: 1, day_label: 'Thu', day_theme: 'A', title: 't3' },
  { id: 4, day_date: '2026-06-06', position: 0, week_number: 1, day_label: 'Fri', day_theme: 'B', title: 't4' },
];

// sortTasks orders by (day_date, position, id).
assert.deepEqual(sortTasks(base()).map((t) => t.id), [1, 2, 3, 4]);

// 1. Within-day reorder: drag id1 over id3 -> [2,3,1].
{
  const r = computeReorder(base(), 1, 3, dayMeta);
  assert.ok(r, 'within-day move should produce a change');
  const order = r.optimisticTasks.filter((t) => t.day_date === '2026-06-05').map((t) => t.id);
  assert.deepEqual(order, [2, 3, 1]);
  assert.equal(r.optimisticTasks.find((t) => t.id === 1).position, 2);
}

// 2. Cross-day move onto a day container (append) -> dest meta stamped, source renumbered.
{
  const r = computeReorder(base(), 1, dayDroppableId('2026-06-06'), dayMeta);
  assert.ok(r);
  const t1 = r.optimisticTasks.find((t) => t.id === 1);
  assert.equal(t1.day_date, '2026-06-06');
  assert.equal(t1.day_label, 'Fri');
  assert.equal(t1.day_theme, 'B');
  const src = r.optimisticTasks.filter((t) => t.day_date === '2026-06-05').map((t) => [t.id, t.position]);
  assert.deepEqual(src, [[2, 0], [3, 1]]);
  const dst = r.optimisticTasks.filter((t) => t.day_date === '2026-06-06').map((t) => [t.id, t.position]);
  assert.deepEqual(dst, [[4, 0], [1, 1]]);
}

// 3. Cross-day move dropped over a specific task -> inserted before it.
{
  const r = computeReorder(base(), 1, 4, dayMeta);
  assert.ok(r);
  const dst = r.optimisticTasks.filter((t) => t.day_date === '2026-06-06').map((t) => t.id);
  assert.deepEqual(dst, [1, 4]);
}

// 4. No-op: dropped over itself.
assert.equal(computeReorder(base(), 1, 1, dayMeta), null);

// 5. No-op: append a task to its own day where it is already last.
assert.equal(computeReorder(base(), 4, dayDroppableId('2026-06-06'), dayMeta), null);

// 6. Dragging the only task out of a day emits no leftover updates for that day.
{
  const r = computeReorder(base(), 4, dayDroppableId('2026-06-05'), dayMeta);
  assert.ok(r);
  assert.equal(r.updates.filter((u) => u.day_date === '2026-06-06').length, 0);
  assert.equal(r.optimisticTasks.filter((t) => t.day_date === '2026-06-06').length, 0);
}

console.log('All computeReorder probes passed.');
