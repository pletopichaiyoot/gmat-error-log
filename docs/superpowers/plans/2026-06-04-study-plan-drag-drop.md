# Study Plan Drag-and-Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user drag study-plan tasks to reorder them within a day and move them to a different day, persisting immediately.

**Architecture:** Frontend uses @dnd-kit (one `DndContext`, per-day `SortableContext` + droppable). The drag-result math lives in a pure, framework-free helper module that a plain-node probe script verifies. A single new backend endpoint rewrites the affected days' `position`/`day_date`/`week_number`/`day_label`/`day_theme` in one SQLite transaction and returns the refreshed task list. No schema change.

**Tech Stack:** React 18, @dnd-kit/core + @dnd-kit/sortable + @dnd-kit/utilities, Express, sqlite3 (raw), lucide-react (icons).

**Spec:** `docs/superpowers/specs/2026-06-04-study-plan-drag-drop-design.md`

**Testing note:** This repo has **no automated test framework** (per CLAUDE.md). "Tests" here are: (a) a standalone `node` assertion probe for the pure reorder math, (b) a `typeof` wiring check + optional `curl` for the backend, and (c) manual verification against the running app. Do **not** add Vitest/Jest — it's out of scope.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `package.json` / `package-lock.json` | Modify | Add the three @dnd-kit packages. |
| `client/src/studyPlanReorder.mjs` | Create | Pure, framework-free reorder math (`sortTasks`, `computeReorder`, day-droppable id helpers). ESM `.mjs` so plain `node` can import it. |
| `scripts/probe-compute-reorder.mjs` | Create | Node assertion probe for `computeReorder` (the "unit test"). |
| `src/db.js` | Modify | Add `reorderStudyPlanTasks(updates)` (transactional batch update) + export it. |
| `src/server.js` | Modify | Add `POST /api/study-plan/reorder` route + import the db function. |
| `client/src/StudyPlan.jsx` | Modify | Wire @dnd-kit: `DndContext`, sensors, `SortableTaskRow`, droppable `DayCard`, `DragOverlay`, and the `reorderTasks` persistence handler. |

---

## Task 1: Add @dnd-kit dependencies

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install the three packages**

Run:
```bash
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```
Expected: npm adds `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` to `dependencies` in `package.json` and updates `package-lock.json`. No errors.

- [ ] **Step 2: Verify they resolve**

Run:
```bash
node -e "require.resolve('@dnd-kit/core'); require.resolve('@dnd-kit/sortable'); require.resolve('@dnd-kit/utilities'); console.log('ok')"
```
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add @dnd-kit for study plan drag-and-drop"
```

---

## Task 2: Pure reorder-math helper + node probe (test-first)

This is the bug-prone math, so write the probe first, watch it fail, then implement.

**Files:**
- Create: `client/src/studyPlanReorder.mjs`
- Create: `scripts/probe-compute-reorder.mjs`

- [ ] **Step 1: Write the failing probe**

Create `scripts/probe-compute-reorder.mjs`:
```js
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

console.log('All computeReorder probes passed.');
```

- [ ] **Step 2: Run the probe to verify it fails**

Run:
```bash
node scripts/probe-compute-reorder.mjs
```
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `../client/src/studyPlanReorder.mjs` (the helper doesn't exist yet).

- [ ] **Step 3: Implement the helper**

Create `client/src/studyPlanReorder.mjs`:
```js
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
```

- [ ] **Step 4: Run the probe to verify it passes**

Run:
```bash
node scripts/probe-compute-reorder.mjs
```
Expected: PASS — prints `All computeReorder probes passed.` and exits 0.

- [ ] **Step 5: Commit**

```bash
git add client/src/studyPlanReorder.mjs scripts/probe-compute-reorder.mjs
git commit -m "feat: pure reorder math for study plan drag-and-drop + node probe"
```

---

## Task 3: Backend — `reorderStudyPlanTasks` in db.js

**Files:**
- Modify: `src/db.js` — add the function (place it right after `deleteStudyPlanTask`, which ends at line 3780) and export it (study-plan block in `module.exports`, after `updateStudyPlanTask,` ~line 4452).

- [ ] **Step 1: Add the function after `deleteStudyPlanTask`**

Insert after the `deleteStudyPlanTask` function (after line 3780, before `getStudyPlanMeta`):
```js
// Batch-reorder study plan tasks atomically. `updates` is an array of
// { id, day_date, week_number, day_label, day_theme, position } describing the
// full ordering of each affected day. Wrapped in one transaction so per-day
// position values never collide mid-write. User fields (status/notes/title/
// description/est_minutes/completed_at) are never touched. Returns the fresh
// full task list.
async function reorderStudyPlanTasks(updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error('updates must be a non-empty array');
  }
  const clean = updates.map((u) => {
    const id = Number(u.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('each update needs a positive integer id');
    const dayDate = String(u.day_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayDate)) throw new Error('day_date must be YYYY-MM-DD');
    const position = Number(u.position);
    if (!Number.isFinite(position)) throw new Error('position must be a finite number');
    const weekNumber = Number(u.week_number);
    if (!Number.isFinite(weekNumber)) throw new Error('week_number must be a finite number');
    return {
      id,
      day_date: dayDate,
      week_number: weekNumber,
      day_label: u.day_label == null ? null : String(u.day_label),
      day_theme: u.day_theme == null ? null : String(u.day_theme),
      position,
    };
  });

  await run('BEGIN');
  try {
    for (const u of clean) {
      await run(
        `UPDATE study_plan_tasks
            SET day_date = ?, week_number = ?, day_label = ?, day_theme = ?, position = ?,
                updated_at = datetime('now')
          WHERE id = ?`,
        [u.day_date, u.week_number, u.day_label, u.day_theme, u.position, u.id],
      );
    }
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK');
    throw err;
  }
  return await listStudyPlanTasks();
}
```

- [ ] **Step 2: Export it**

In `src/db.js` `module.exports`, in the `// Study plan` block, add the line after `updateStudyPlanTask,`:
```js
  updateStudyPlanTask,
  reorderStudyPlanTasks,
  deleteStudyPlanTask,
```

- [ ] **Step 3: Verify the export wires up**

Run:
```bash
node -e "const db=require('./src/db'); console.log(typeof db.reorderStudyPlanTasks)"
```
Expected: prints `function`.

- [ ] **Step 4: Verify input validation rejects bad input (no DB write)**

Run:
```bash
node -e "require('./src/db').reorderStudyPlanTasks([]).then(()=>console.log('NO THROW (bad)')).catch(e=>console.log('threw:', e.message))"
```
Expected: prints `threw: updates must be a non-empty array`.

- [ ] **Step 5: Commit**

```bash
git add src/db.js
git commit -m "feat: reorderStudyPlanTasks transactional batch update"
```

---

## Task 4: Backend — `POST /api/study-plan/reorder` route

**Files:**
- Modify: `src/server.js` — add `reorderStudyPlanTasks` to the `require('./db')` destructure (after `updateStudyPlanTask,` at line 34); add the route after the `DELETE /api/study-plan/tasks/:id` handler (ends line 1641).

- [ ] **Step 1: Import the db function**

In `src/server.js`, in the `require('./db')` destructure block (lines 31–47), add after `updateStudyPlanTask,` (line 34):
```js
  updateStudyPlanTask,
  reorderStudyPlanTasks,
```

- [ ] **Step 2: Add the route**

In `src/server.js`, immediately after the `app.delete('/api/study-plan/tasks/:id', ...)` handler (after line 1641, before the `/api/study-plan/sync` route), add:
```js
app.post('/api/study-plan/reorder', async (req, res) => {
  try {
    const updates = (req.body && req.body.updates) || [];
    const tasks = await reorderStudyPlanTasks(updates);
    res.json({ tasks });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Verify the route responds (with the dev server running)**

With the API running (`npm run dev` or `npm run dev:api`), fetch the current plan, then send back the first day's existing ordering verbatim (a harmless no-op that only bumps `updated_at`):
```bash
curl -s http://localhost:4310/api/study-plan | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const {tasks}=JSON.parse(s);
  const firstDay=tasks[0]?.day_date;
  const updates=tasks.filter(t=>t.day_date===firstDay).map(t=>({
    id:t.id,day_date:t.day_date,week_number:t.week_number,
    day_label:t.day_label,day_theme:t.day_theme,position:t.position}));
  process.stdout.write(JSON.stringify({updates}));
});" | curl -s -X POST http://localhost:4310/api/study-plan/reorder \
  -H 'Content-Type: application/json' -d @- | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const r=JSON.parse(s);
  console.log('tasks returned:', Array.isArray(r.tasks)?r.tasks.length:r);
});"
```
Expected: prints `tasks returned: <N>` where N is the total task count (a JSON object with a `tasks` array came back, status 200).

- [ ] **Step 4: Verify a malformed body 400s**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:4310/api/study-plan/reorder \
  -H 'Content-Type: application/json' -d '{"updates":[]}'
```
Expected: prints `400`.

- [ ] **Step 5: Commit**

```bash
git add src/server.js
git commit -m "feat: POST /api/study-plan/reorder endpoint"
```

---

## Task 5: Frontend — wire @dnd-kit into StudyPlan.jsx

**Files:**
- Modify: `client/src/StudyPlan.jsx`

- [ ] **Step 1: Add imports**

At the top of `client/src/StudyPlan.jsx`, after the existing imports (after line 2, `import { Button } ...`), add:
```jsx
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCorners,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { computeReorder, dayDroppableId } from './studyPlanReorder.mjs';
```

- [ ] **Step 2: Add sensors, active-drag state, and the reorder handler inside `StudyPlan`**

In the `StudyPlan` component, after the existing state declarations (after line 86, `const [testDateDraft, setTestDateDraft] = useState('');`), add:
```jsx
  const [activeId, setActiveId] = useState(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
```

Then, after the `saveTestDate` function (after line 272), add the reorder handlers:
```jsx
  async function reorderTasks(activeTaskId, overId) {
    const dayMeta = {};
    for (const d of days) {
      dayMeta[d.date] = { week_number: d.week, day_label: d.label, day_theme: d.theme };
    }
    const result = computeReorder(tasks, activeTaskId, overId, dayMeta);
    if (!result) return;
    const prevTasks = tasks;
    setTasks(result.optimisticTasks);
    try {
      const data = await fetchJson('/api/study-plan/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: result.updates }),
      });
      if (data.tasks) setTasks(data.tasks);
    } catch (e) {
      setError(e.message);
      setTasks(prevTasks);
    }
  }

  function handleDragStart(event) {
    setActiveId(event.active.id);
  }

  function handleDragEnd(event) {
    const { active, over } = event;
    setActiveId(null);
    if (over) reorderTasks(active.id, over.id);
  }
```

Note: `days` is declared with `useMemo` at line 277, below these handlers in source order. Because `handleDragStart`/`handleDragEnd`/`reorderTasks` are function declarations invoked only on a drag event (not during render), their `days`/`tasks` closures resolve to the current render's values at call time. No reordering of existing lines is required.

- [ ] **Step 3: Wrap the weeks render in `DndContext` + `DragOverlay`**

In `StudyPlan`'s returned JSX, replace the `weeks.map(...)` block (lines 379–391):
```jsx
      {weeks.map(({ week, days: daysInWeek }) => (
        <WeekSection
          key={week}
          week={week}
          days={daysInWeek}
          today={today}
          onToggle={toggleStatus}
          onSkip={markSkipped}
          onUpdate={updateTask}
          onDelete={deleteTask}
          onAdd={addTask}
        />
      ))}
```
with:
```jsx
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {weeks.map(({ week, days: daysInWeek }) => (
          <WeekSection
            key={week}
            week={week}
            days={daysInWeek}
            today={today}
            onToggle={toggleStatus}
            onSkip={markSkipped}
            onUpdate={updateTask}
            onDelete={deleteTask}
            onAdd={addTask}
          />
        ))}
        <DragOverlay>
          {activeId != null ? (
            <TaskDragPreview task={tasks.find((t) => t.id === activeId)} />
          ) : null}
        </DragOverlay>
      </DndContext>
```

- [ ] **Step 4: Make `DayCard` a droppable that renders sortable rows**

Replace the entire `DayCard` function (lines 713–805) with this version (adds `useDroppable`, the `SortableContext`, `SortableTaskRow`, and an empty-day drop zone; everything else unchanged):
```jsx
function DayCard({ day, isToday, isPast, onToggle, onSkip, onUpdate, onDelete, onAdd }) {
  const prog = progressFor(day.tasks);
  const totalMinutes = day.tasks.reduce((s, t) => s + (Number(t.est_minutes) || 0), 0);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const { setNodeRef, isOver } = useDroppable({ id: dayDroppableId(day.date) });

  function submitAdd() {
    if (draft.trim()) {
      onAdd(day, draft.trim());
      setDraft('');
      setAdding(false);
    }
  }

  return (
    <div
      style={{
        padding: '12px 24px',
        borderTop: '1px solid rgba(0,0,0,0.05)',
        background: isToday ? 'rgba(99,102,241,0.07)' : 'transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              color: isToday ? '#6366f1' : isPast ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.6)',
            }}
          >
            {day.label} · {day.date}
            {isToday && <span style={{ marginLeft: 6 }}>· today</span>}
          </span>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{day.theme}</span>
        </div>
        <span style={{ fontSize: 11, opacity: 0.6 }}>
          {prog.done}/{prog.total} · {formatMinutes(totalMinutes)}
        </span>
      </div>
      <div
        ref={setNodeRef}
        style={{
          marginTop: 8,
          borderRadius: 8,
          outline: isOver ? '2px dashed rgba(99,102,241,0.5)' : '2px dashed transparent',
          outlineOffset: 2,
          transition: 'outline-color 0.15s ease',
          minHeight: day.tasks.length === 0 ? 36 : undefined,
        }}
      >
        <SortableContext items={day.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {day.tasks.map((task) => (
            <SortableTaskRow
              key={task.id}
              task={task}
              onToggle={onToggle}
              onSkip={onSkip}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          ))}
        </SortableContext>
        {day.tasks.length === 0 && (
          <div style={{ fontSize: 12, opacity: 0.45, padding: '8px 0 8px 28px', fontStyle: 'italic' }}>
            {isOver ? 'Drop here' : 'No tasks — drag one here'}
          </div>
        )}
      </div>
      <div style={{ marginTop: 4 }}>
        {adding ? (
          <div style={{ display: 'flex', gap: 6, marginLeft: 28 }}>
            <input
              autoFocus
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitAdd();
                if (e.key === 'Escape') { setAdding(false); setDraft(''); }
              }}
              placeholder="New task..."
              style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(0,0,0,0.2)', fontSize: 13 }}
            />
            <Button size="sm" onClick={submitAdd}>Add</Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setDraft(''); }}>Cancel</Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            style={{
              marginLeft: 28,
              fontSize: 12,
              background: 'transparent',
              border: 'none',
              color: '#6366f1',
              cursor: 'pointer',
              padding: '4px 0',
            }}
          >
            + add task
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add `SortableTaskRow` and `TaskDragPreview` components**

Immediately after the `DayCard` function (before `function TaskRow(...)`, currently line 807), add:
```jsx
function SortableTaskRow({ task, onToggle, onSkip, onUpdate, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    display: 'flex',
    alignItems: 'flex-start',
    gap: 4,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <button
        type="button"
        {...attributes}
        {...listeners}
        title="Drag to reorder or move to another day"
        aria-label={`Drag task: ${task.title}`}
        style={{
          cursor: 'grab',
          background: 'transparent',
          border: 'none',
          padding: '8px 2px 0 0',
          color: 'rgba(0,0,0,0.3)',
          touchAction: 'none',
          lineHeight: 1,
        }}
      >
        <GripVertical size={16} />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <TaskRow
          task={task}
          onToggle={onToggle}
          onSkip={onSkip}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
}

function TaskDragPreview({ task }) {
  if (!task) return null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 8,
        background: '#fff',
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
        border: '1px solid rgba(99,102,241,0.4)',
        fontSize: 14,
        fontWeight: 500,
        maxWidth: 480,
        cursor: 'grabbing',
      }}
    >
      <GripVertical size={16} style={{ color: 'rgba(0,0,0,0.3)' }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {task.title}
      </span>
    </div>
  );
}
```

- [ ] **Step 6: Lint the changed files**

Run:
```bash
npm run lint
```
Expected: 0 errors (warnings are tolerated per the repo baseline). If the run reports a NEW error in `StudyPlan.jsx` or `studyPlanReorder.mjs`, fix it before continuing.

- [ ] **Step 7: Build the frontend to confirm it compiles**

Run:
```bash
npm run build:web
```
Expected: Vite build completes with no errors (the `./studyPlanReorder.mjs` import and @dnd-kit imports resolve).

- [ ] **Step 8: Commit**

```bash
git add client/src/StudyPlan.jsx
git commit -m "feat: drag-and-drop reordering in the study plan UI"
```

---

## Task 6: End-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Start the app**

Run (if not already running):
```bash
npm run dev
```
Then open `http://localhost:5173/#study-plan` (or navigate to the Study Plan view from the dashboard).

- [ ] **Step 2: Reorder within a day**

Grab a task by its grip handle and drop it above/below a sibling in the same day. Expected: order updates immediately. Reload the page — the new order persists.

- [ ] **Step 3: Move to another day (same week)**

Drag a task onto a different day card in the same week. Expected: it lands there, the source day's count drops, the destination's rises. Reload — persists.

- [ ] **Step 4: Move across weeks**

Drag a task to a day in a different week section. Expected: after drop, it renders under the destination week (correct week label). Reload — persists.

- [ ] **Step 5: Drop onto an empty day**

Find or clear a day with no tasks, then drag a task onto its "No tasks — drag one here" zone. Expected: task appears there; persists after reload.

- [ ] **Step 6: Buttons still work (no drag hijack)**

Click a task's checkbox, ✏️ edit, 📝 notes, ⊘ skip, and 🗑 delete. Expected: all behave exactly as before — a click is not swallowed as a drag (5px activation distance).

- [ ] **Step 7: Final commit (only if any fix was needed in steps 2–6)**

```bash
git add -A
git commit -m "fix: study plan drag-and-drop verification follow-ups"
```
If no fixes were needed, skip this step.

---

## Self-Review (completed by plan author)

- **Spec coverage:** reorder-within-day (Tasks 2, 5, 6); move-to-another-day incl. cross-week (Tasks 2, 5, 6); no schema change (confirmed — Task 3 writes only existing columns); new `POST /reorder` endpoint returning the full task list (Tasks 3, 4); @dnd-kit + grip handle + empty-day drop + optimistic/rollback (Task 5); manual verification (Task 6). All spec sections map to a task.
- **Placeholder scan:** none — every code step contains complete code; every command has expected output.
- **Type/name consistency:** `computeReorder(tasks, activeId, overId, dayMeta)`, `dayDroppableId`, `sortTasks` used identically in the helper (Task 2), the probe (Task 2), and the component (Task 5). `reorderStudyPlanTasks(updates)` defined (Task 3), exported (Task 3), imported + called (Task 4). Endpoint shape `{ updates }` → `{ tasks }` consistent across Tasks 3, 4, 5. `SortableTaskRow` / `TaskDragPreview` defined in Task 5 Step 5 and referenced in Task 5 Steps 3–4.
```
