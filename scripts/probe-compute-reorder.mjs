import assert from 'node:assert/strict';
import {
  buildDays,
  computeDayReorder,
  computeReorder,
  dayDroppableId,
  dayRowDraggableId,
  sortDayRows,
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

// 7. buildDays keeps a skeleton day visible even when it holds zero tasks.
//    This is the regression guard: moving the last task off a day used to make
//    the day (and its date) vanish, so it could not be dragged back to.
{
  const skeleton = [
    { date: '2026-06-05', week_number: 1, day_label: 'Thu', day_theme: 'A' },
    { date: '2026-06-06', week_number: 1, day_label: 'Fri', day_theme: 'B' },
  ];
  // All tasks live on 06-06; 06-05 has been emptied by drag-moves.
  const tasks = [
    { id: 4, day_date: '2026-06-06', position: 0, week_number: 1, day_label: 'Fri', day_theme: 'B', title: 't4' },
  ];
  const days = buildDays(tasks, skeleton);
  const d05 = days.find((d) => d.date === '2026-06-05');
  assert.ok(d05, 'an emptied skeleton day must still render as a drop target');
  assert.equal(d05.tasks.length, 0);
  assert.equal(d05.label, 'Thu');
  assert.equal(d05.theme, 'A');
  assert.equal(d05.week, 1);
  // Days come back in date order.
  assert.deepEqual(days.map((d) => d.date), ['2026-06-05', '2026-06-06']);
}

// 8. A day that has tasks derives its meta from its first task (unchanged
//    behavior), and tasks on a date absent from the skeleton still render.
{
  const tasks = [
    { id: 1, day_date: '2026-07-01', position: 0, week_number: 3, day_label: 'Wed', day_theme: 'Custom', title: 'x' },
  ];
  const days = buildDays(tasks, []);
  assert.equal(days.length, 1);
  assert.equal(days[0].date, '2026-07-01');
  assert.equal(days[0].theme, 'Custom');
  assert.equal(days[0].tasks.length, 1);
}

// 9. buildDays with no skeleton matches the old task-only grouping.
{
  const days = buildDays(base(), []);
  assert.deepEqual(days.map((d) => d.date), ['2026-06-05', '2026-06-06']);
  assert.deepEqual(days.find((d) => d.date === '2026-06-05').tasks.map((t) => t.id), [1, 2, 3]);
}

// 10. buildDays with first-class day rows orders by sort_order, not date.
{
  const rows = [
    { date: '2026-06-06', week_number: 1, day_label: 'Fri', day_theme: 'B', sort_order: 0 },
    { date: '2026-06-05', week_number: 1, day_label: 'Thu', day_theme: 'A', sort_order: 1 },
  ];
  const built = buildDays([], rows);
  assert.deepEqual(built.map((d) => d.date), ['2026-06-06', '2026-06-05']);
  assert.equal(built[0].theme, 'B');
}

// 11. buildDays groups weeks ahead of sort_order (week is the primary key).
{
  const rows = [
    { date: '2026-06-12', week_number: 2, sort_order: 0 },
    { date: '2026-06-05', week_number: 1, sort_order: 5 },
  ];
  assert.deepEqual(buildDays([], rows).map((d) => d.date), ['2026-06-05', '2026-06-12']);
}

const days3 = () => [
  { date: '2026-06-05', week_number: 1, sort_order: 0 },
  { date: '2026-06-06', week_number: 1, sort_order: 1 },
  { date: '2026-06-07', week_number: 1, sort_order: 2 },
];

// 12. computeDayReorder: drag the last day onto the first → dense 0..n renumber.
{
  const r = computeDayReorder(days3(), '2026-06-07', dayRowDraggableId('2026-06-05'));
  assert.ok(r, 'a real day move should produce updates');
  assert.deepEqual(r.optimisticDays.map((d) => d.date), ['2026-06-07', '2026-06-05', '2026-06-06']);
  assert.deepEqual(
    r.updates.map((u) => [u.date, u.sort_order]),
    [['2026-06-07', 0], ['2026-06-05', 1], ['2026-06-06', 2]],
  );
}

// 13. Cross-week day drag adopts the destination day's week.
{
  const daysX = [
    { date: '2026-06-05', week_number: 1, sort_order: 0 },
    { date: '2026-06-06', week_number: 1, sort_order: 1 },
    { date: '2026-06-12', week_number: 2, sort_order: 2 },
  ];
  const r = computeDayReorder(daysX, '2026-06-12', dayRowDraggableId('2026-06-06'));
  assert.ok(r);
  const moved = r.optimisticDays.find((d) => d.date === '2026-06-12');
  assert.equal(moved.week_number, 1, 'dragged day adopts the destination week');
}

// 14. computeDayReorder no-ops on self-drop and non-day targets.
assert.equal(computeDayReorder(days3(), '2026-06-05', dayRowDraggableId('2026-06-05')), null);
assert.equal(computeDayReorder(days3(), '2026-06-05', 42), null);
assert.equal(computeDayReorder(days3(), '2026-06-05', dayDroppableId('2026-06-06')), null);

// 15. sortDayRows tolerates either week_number or week key shape.
{
  const ordered = sortDayRows([
    { date: '2026-06-09', week: 2, sort_order: 0 },
    { date: '2026-06-05', week: 1, sort_order: 9 },
  ]);
  assert.deepEqual(ordered.map((d) => d.date), ['2026-06-05', '2026-06-09']);
}

console.log('All computeReorder + buildDays + day-reorder probes passed.');
