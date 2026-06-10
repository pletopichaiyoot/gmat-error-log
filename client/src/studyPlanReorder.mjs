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

// Stable flat order for first-class day rows: (week, sort_order, date). Both the
// renderer and the day-drag math sort with this so display and persistence agree.
export function sortDayRows(days) {
  return [...(days || [])].sort((a, b) => {
    const wa = Number(a.week_number ?? a.week ?? 0);
    const wb = Number(b.week_number ?? b.week ?? 0);
    if (wa !== wb) return wa - wb;
    const sa = Number(a.sort_order ?? 0);
    const sb = Number(b.sort_order ?? 0);
    if (sa !== sb) return sa - sb;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
}

// Build the ordered day list for rendering by merging first-class day rows (from
// the server, authoritative for meta + ordering) with the tasks that live on
// each day. Days persist independently of tasks, so an emptied or newly-added
// day still renders. A task whose date has no day row is defensively given a
// synthesized day (floated to the end of its week) so nothing is ever hidden.
export function buildDays(tasks, days = []) {
  const sortedTasks = sortTasks(tasks);
  const map = new Map();
  for (const d of days || []) {
    map.set(d.date, {
      date: d.date,
      week: d.week_number,
      label: d.day_label,
      theme: d.day_theme,
      sort_order: Number(d.sort_order ?? 0),
      tasks: [],
    });
  }
  for (const t of sortedTasks) {
    if (!map.has(t.day_date)) {
      map.set(t.day_date, {
        date: t.day_date,
        week: t.week_number,
        label: t.day_label,
        theme: t.day_theme,
        sort_order: Number.MAX_SAFE_INTEGER,
        tasks: [],
      });
    }
    map.get(t.day_date).tasks.push(t);
  }
  return Array.from(map.values()).sort((a, b) => {
    const wa = Number(a.week ?? 0);
    const wb = Number(b.week ?? 0);
    if (wa !== wb) return wa - wb;
    const sa = Number(a.sort_order ?? 0);
    const sb = Number(b.sort_order ?? 0);
    if (sa !== sb) return sa - sb;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
}

// Droppable/draggable id helpers for whole-day dragging. Day rows use a distinct
// `dayrow:` namespace so the drag handler can tell a day drag from a task drag
// (numeric id) or a task-drop-onto-day (`day:` id).
const DAY_ROW_PREFIX = 'dayrow:';
export function dayRowDraggableId(date) {
  return `${DAY_ROW_PREFIX}${date}`;
}
export function isDayRowDraggableId(id) {
  return typeof id === 'string' && id.startsWith(DAY_ROW_PREFIX);
}
export function dateFromDayRowId(id) {
  return String(id).slice(DAY_ROW_PREFIX.length);
}

// Given the current day rows, the dragged day's date, and the drop target
// (`overId` = a `dayrow:DATE` id), return { optimisticDays, updates } with a
// dense 0..n-1 sort_order renumber, or null for a no-op / non-day drop. Dropping
// onto a day in another week moves the dragged day into that week.
export function computeDayReorder(days, activeDate, overId) {
  if (overId == null || !isDayRowDraggableId(overId)) return null;
  const overDate = dateFromDayRowId(overId);
  if (overDate === activeDate) return null;
  const ordered = sortDayRows(days);
  const fromIdx = ordered.findIndex((d) => d.date === activeDate);
  const toIdx = ordered.findIndex((d) => d.date === overDate);
  if (fromIdx === -1 || toIdx === -1) return null;
  const destWeek = Number(ordered[toIdx].week_number);
  const moved = arrayMove(ordered, fromIdx, toIdx).map((d, i) => ({
    ...d,
    week_number: d.date === activeDate ? destWeek : Number(d.week_number),
    sort_order: i,
  }));
  const byDate = new Map((days || []).map((d) => [d.date, d]));
  const isNoop = moved.every((d) => {
    const cur = byDate.get(d.date);
    return cur && Number(cur.sort_order ?? 0) === d.sort_order && Number(cur.week_number) === d.week_number;
  });
  if (isNoop) return null;
  return {
    optimisticDays: moved,
    updates: moved.map((d) => ({ date: d.date, sort_order: d.sort_order, week_number: d.week_number })),
  };
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
// Contract: `dayMeta` must contain the destination day. If it is absent, the
// moved task silently retains its source-day meta (caller always supplies the
// drop-target day, so this is a defensive fallback, not the normal path).
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
      const fromIdx = ids.indexOf(activeId);
      const toIdx = ids.indexOf(overId);
      if (fromIdx === -1 || toIdx === -1) return null;
      destIds = arrayMove(ids, fromIdx, toIdx);
    } else {
      const ids = (grouped.get(destDay) || []).filter((id) => id !== activeId);
      const overIdx = ids.indexOf(overId);
      if (overIdx === -1) return null;
      ids.splice(overIdx, 0, activeId);
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
