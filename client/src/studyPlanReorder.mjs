// Pure, framework-free helpers for drag-reordering study-plan tasks.
// No React / dnd-kit imports, so the move math can be verified with plain node
// (see scripts/probe-compute-reorder.mjs).

const DAY_PREFIX = 'day:';

// Droppable id for a day container (distinct from numeric task ids).
export function dayDroppableId(dayDate) {
  return `${DAY_PREFIX}${dayDate}`;
}
export function isDayDroppableId(id) {
  return typeof id === 'string' && id.startsWith(DAY_PREFIX);
}
export function dayDateFromDroppableId(id) {
  return String(id).slice(DAY_PREFIX.length);
}

// Stable order: (day_date, position, id) — the order GET /api/study-plan returns.
export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    if (a.day_date !== b.day_date) return a.day_date < b.day_date ? -1 : 1;
    const pa = Number(a.position ?? 0);
    const pb = Number(b.position ?? 0);
    if (pa !== pb) return pa - pb;
    return Number(a.id) - Number(b.id);
  });
}

function arrayMove(arr, from, to) {
  const copy = arr.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

function groupIdsByDay(sortedTasks) {
  const m = new Map();
  for (const t of sortedTasks) {
    if (!m.has(t.day_date)) m.set(t.day_date, []);
    m.get(t.day_date).push(t.id);
  }
  return m;
}

// Given current flat tasks, the dragged task id, the drop target
// (`overId` = a numeric task id OR a `day:DATE` droppable id), and a
// day -> { week_number, day_label, day_theme } map, return
// { optimisticTasks, updates } or null if the drop is a no-op.
//
// `updates` contains the full ordering for each affected day (1 day for an
// in-day reorder, 2 for a cross-day move): one
// { id, day_date, week_number, day_label, day_theme, position } per task.
export function computeReorder(tasks, activeId, overId, dayMeta) {
  if (overId == null || activeId === overId) return null;
  const sorted = sortTasks(tasks);
  const byId = new Map(sorted.map((t) => [t.id, t]));
  const active = byId.get(activeId);
  if (!active) return null;

  const srcDay = active.day_date;
  const grouped = groupIdsByDay(sorted);

  // Resolve destination day + its final ordered id list (including active).
  let destDay;
  let destIds;
  if (isDayDroppableId(overId)) {
    destDay = dayDateFromDroppableId(overId);
    const base = (grouped.get(destDay) || []).filter((id) => id !== activeId);
    base.push(activeId); // dropping on the container appends to the end
    destIds = base;
  } else {
    const overTask = byId.get(overId);
    if (!overTask) return null;
    destDay = overTask.day_date;
    if (srcDay === destDay) {
      const ids = grouped.get(destDay) || [];
      destIds = arrayMove(ids, ids.indexOf(activeId), ids.indexOf(overId));
    } else {
      const ids = (grouped.get(destDay) || []).slice();
      ids.splice(ids.indexOf(overId), 0, activeId);
      destIds = ids;
    }
  }

  const meta = dayMeta[destDay] || {};
  const patched = new Map(); // id -> updated task object
  const updates = [];

  // Destination day: contiguous positions; the moved task gets dest-day meta.
  destIds.forEach((id, i) => {
    const t = byId.get(id);
    const isActive = id === activeId;
    const next = {
      ...t,
      day_date: destDay,
      week_number: isActive ? (meta.week_number ?? t.week_number) : t.week_number,
      day_label: isActive ? (meta.day_label ?? t.day_label ?? null) : (t.day_label ?? null),
      day_theme: isActive ? (meta.day_theme ?? t.day_theme ?? null) : (t.day_theme ?? null),
      position: i,
    };
    patched.set(id, next);
    updates.push({
      id,
      day_date: next.day_date,
      week_number: next.week_number,
      day_label: next.day_label,
      day_theme: next.day_theme,
      position: i,
    });
  });

  // Source day (only if different): renumber the remaining tasks 0..n-1.
  if (srcDay !== destDay) {
    const srcIds = (grouped.get(srcDay) || []).filter((id) => id !== activeId);
    srcIds.forEach((id, i) => {
      const t = byId.get(id);
      patched.set(id, { ...t, position: i });
      updates.push({
        id,
        day_date: t.day_date,
        week_number: t.week_number,
        day_label: t.day_label ?? null,
        day_theme: t.day_theme ?? null,
        position: i,
      });
    });
  }

  // No-op detection: every update already matches the current row.
  const isNoop = updates.every((u) => {
    const cur = byId.get(u.id);
    return cur && cur.day_date === u.day_date && Number(cur.position ?? 0) === u.position;
  });
  if (isNoop) return null;

  const optimisticTasks = sortTasks(tasks.map((t) => patched.get(t.id) || t));
  return { optimisticTasks, updates };
}
