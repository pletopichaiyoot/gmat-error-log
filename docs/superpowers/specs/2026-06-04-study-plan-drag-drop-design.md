# Study Plan — Drag-and-Drop Rearranging

**Date:** 2026-06-04
**Status:** Approved (design), pending implementation plan
**Area:** `client/src/StudyPlan.jsx`, `src/server.js`, `src/db.js`

## Goal

Let the user rearrange study-plan tasks by drag-and-drop:

1. **Reorder within a day** — change the order of tasks inside one day.
2. **Move to another day** — drag a task to a different day (including a different week).

Changes persist immediately with optimistic UI, matching how task toggles and edits already behave in this view.

## Non-goals (YAGNI)

- No up/down buttons or "move to day…" picker — drag-and-drop only (chosen interaction).
- No moving tasks to arbitrary dates outside the rendered plan grid — only onto days that already exist in the plan.
- No multi-select / bulk drag — one task at a time.
- No reordering of weeks or days themselves — only tasks within/between days.
- No touch-gesture tuning — this is a single-user, macOS desktop app.

## Data model

**No schema change.** `study_plan_tasks` already carries every column a move needs:

| Column | Role in this feature |
|---|---|
| `position` | Per-day ordering integer (`ORDER BY day_date, position, id`). Rewritten on reorder. |
| `day_date` | Which day the task belongs to. Rewritten on cross-day move. |
| `week_number` | Which week section it renders under. Updated to match destination day. |
| `day_label` | Day label (e.g., "Mon"). Updated to match destination day. |
| `day_theme` | Day theme text. Updated to match destination day. |

User-owned fields — `status`, `completed_at`, `notes`, `title`, `description`, `est_minutes` — are **never** touched by a move.

### Invariant

After any move, each affected day's tasks have contiguous `position` values `0..n-1` in their displayed order. The frontend computes these and sends the full per-day ordering; the backend writes them verbatim in one transaction.

## Backend

### New endpoint: `POST /api/study-plan/reorder`

Request body:

```json
{
  "updates": [
    { "id": 12, "day_date": "2026-06-05", "week_number": 1, "day_label": "Thu", "day_theme": "DI Reboot", "position": 0 },
    { "id": 13, "day_date": "2026-06-05", "week_number": 1, "day_label": "Thu", "day_theme": "DI Reboot", "position": 1 }
  ]
}
```

- `updates` contains every task in each **affected** day: 1 day's worth for an in-day reorder, 2 days' worth for a cross-day move.
- Each entry is a full placement: `id`, `day_date`, `week_number`, `day_label`, `day_theme`, `position`.

Response: `{ "tasks": [...] }` — the complete refreshed task list (same shape as `GET /api/study-plan`'s `tasks`), so the client reconciles against server truth rather than trusting its optimistic guess.

Handler placement: alongside the other `/api/study-plan/*` routes in `src/server.js` (after the `PATCH /tasks/:id` route). Returns `400` on a malformed body, `500` on a DB error.

### New db function: `reorderStudyPlanTasks(updates)` in `src/db.js`

- Validates: `updates` is a non-empty array; each entry has a positive integer `id`, a `YYYY-MM-DD` `day_date`, a finite `position`, a finite `week_number`. `day_label`/`day_theme` may be null.
- Wraps all writes in a single transaction (`BEGIN`/`COMMIT`, `ROLLBACK` on error) so intermediate states never violate per-day position uniqueness.
- For each entry, `UPDATE study_plan_tasks SET day_date=?, week_number=?, day_label=?, day_theme=?, position=?, updated_at=datetime('now') WHERE id=?`.
- Ignores ids that don't exist (defensive; a stale client shouldn't 500 the batch). After commit, returns `listStudyPlanTasks()`.

This reuses the column semantics already present in `updateStudyPlanTask`; it does not call that function per-row (to keep everything in one transaction).

## Frontend

### Dependencies

Add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` (React 18 compatible; ~10KB gz combined). Installed via `npm install` and committed to `package.json` / `package-lock.json`.

### Component structure (all in `StudyPlan.jsx`)

```
StudyPlan
└─ DndContext  (sensors, collision detection, onDragStart/Over/End)
   └─ WeekSection (×N)
      └─ DayCard  ← droppable container; renders SortableContext over its tasks
         └─ SortableTaskRow (×N)  ← wraps existing TaskRow, adds grip handle
   └─ DragOverlay  (floating preview of the dragged row)
```

- **`DndContext`** lives at the `StudyPlan` level (one context spanning all weeks/days, so cross-week drags work). Sensors: `PointerSensor` with `activationConstraint: { distance: 5 }` (so a click on the checkbox/edit/notes/delete buttons is not swallowed as a drag) and `KeyboardSensor` (accessibility). Collision detection: `closestCorners` (robust for multi-container vertical lists).
- **`DayCard`** registers as a droppable keyed by `day.date` and wraps its tasks in a `SortableContext` (items = the day's task ids, `verticalListSortingStrategy`). It must remain a valid drop target when it has **zero tasks** — render a slim "drop here" placeholder zone so empty days can receive a task.
- **`SortableTaskRow`** uses `useSortable({ id: task.id })`. Drag is initiated only from a **grip handle** (lucide `GripVertical`) placed at the row's left edge; `listeners`/`attributes` attach to the handle, not the whole row. The existing `TaskRow` UI (checkbox, title, notes, edit, skip, delete) renders unchanged inside it.
- **`DragOverlay`** renders a static copy of the dragged task's row for a clean floating preview.

### State & persistence flow

- `tasks` remains the single flat source of truth, **kept sorted by `(day_date, position, id)`** — the same order the API returns — so `groupByDay` → `groupByWeek` render correctly without extra sorting.
- `onDragStart`: record the active task id (drives the `DragOverlay`).
- `onDragOver`: when the pointer moves over a different day's container, move the task between containers in local state so the user sees it land live (standard dnd-kit multi-container pattern).
- `onDragEnd`:
  1. Compute the final ordering of the affected day(s).
  2. For a cross-day move, stamp the moved task's `week_number`/`day_label`/`day_theme` from the destination day.
  3. Reassign contiguous `position` values within each affected day.
  4. `setTasks(optimisticSortedArray)`.
  5. `POST /api/study-plan/reorder` with the affected days' full ordering.
  6. On success, replace state with the returned `tasks`. On error, `setError(...)` and `refresh()` to roll back.
- A no-op drop (dropped in its original slot) makes no network call.

### Helper

`computeReorder(tasks, activeId, overId/overDayDate, daysIndex)` — a pure function that takes the current flat task list and the drag result, and returns `{ optimisticTasks, updates }`. Keeping this pure makes the move math reviewable and isolates it from dnd-kit event plumbing.

## Edge cases

| Case | Behavior |
|---|---|
| Drag a `done`/`skipped` task | Allowed; status, `completed_at`, and notes preserved. |
| Drag across weeks | Destination `week_number`/`label`/`theme` applied; row re-renders under the destination `WeekSection`. |
| Drop onto an empty day | Works — `DayCard` is a drop target even with no tasks. |
| Click vs. drag | Disambiguated by the 5px pointer activation distance + handle-only drag. |
| Drop in original position | No-op; no network call. |
| Reorder request fails | Optimistic state rolled back via `refresh()`; error surfaced in the top bar. |
| Collapsed week | Tasks in a collapsed `WeekSection` aren't rendered, so they're simply not drop targets while collapsed — acceptable; the user expands to drag. |

## Testing & verification

No automated test suite exists in this repo. Verification is manual against the running app (`npm run dev`, web on :5173, API on :4310):

1. Reorder two tasks within one day → order holds after a page refresh.
2. Drag a task to a different day in the same week → lands there, persists after refresh, source day re-numbers.
3. Drag a task to a day in a different week → renders under the new week section after refresh.
4. Drag onto an empty day → task appears there and persists.
5. Click the checkbox / edit / notes / delete buttons → still work (not hijacked by drag).
6. `npm run lint` → no new errors.

Optional: drive steps 1–4 via Playwright/CDP against the running app to confirm drop math and persistence programmatically.

## Risks

- **dnd-kit multi-container reorder is fiddly.** The `onDragOver` cross-container move + `onDragEnd` finalize is the standard but error-prone part; the pure `computeReorder` helper plus manual verification mitigate this.
- **Activation distance tuning.** Too small hijacks clicks; too large feels unresponsive. 5px is the documented sweet spot; adjust if clicks misfire during manual testing.
