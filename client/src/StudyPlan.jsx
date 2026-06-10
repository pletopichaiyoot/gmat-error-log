import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './components/ui/button';
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
import {
  GripVertical,
  Undo2,
  Redo2,
  Plus,
  Pencil,
  Trash2,
  StickyNote,
  Ban,
  RotateCcw,
  X,
  CalendarPlus,
} from 'lucide-react';
import {
  buildDays,
  computeReorder,
  computeDayReorder,
  dayDroppableId,
  dayRowDraggableId,
  isDayDroppableId,
  isDayRowDraggableId,
  dateFromDayRowId,
} from './studyPlanReorder.mjs';

function fetchJson(url, opts) {
  return fetch(url, opts).then(async (r) => {
    if (!r.ok) {
      const text = await r.text();
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch { /* keep raw text */ }
      throw new Error(msg || `HTTP ${r.status}`);
    }
    return r.json();
  });
}

function formatMinutes(min) {
  if (!Number.isFinite(Number(min)) || min <= 0) return '';
  const m = Math.round(Number(min));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function daysBetween(dateStrA, dateStrB) {
  const a = new Date(`${dateStrA}T00:00:00`);
  const b = new Date(`${dateStrB}T00:00:00`);
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

function todayLocalISODate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDaysISO(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function weekdayLabel(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return '';
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
}

function groupByWeek(days) {
  const map = new Map();
  for (const d of days) {
    if (!map.has(d.week)) map.set(d.week, []);
    map.get(d.week).push(d);
  }
  return Array.from(map.entries()).map(([week, daysInWeek]) => ({ week, days: daysInWeek }));
}

function progressFor(tasks) {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const skipped = tasks.filter((t) => t.status === 'skipped').length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, done, skipped, pct };
}

const WEEK_LABELS = {
  1: 'Week 1 · Diagnostic + DI Reboot',
  2: 'Week 2 · Heavy DI + CR Push',
  3: 'Week 3 · Calibration + Hard-Question Push',
  4: 'Week 4 · Taper + Test',
};

const HISTORY_LIMIT = 100;

// Targets we should never hijack ⌘Z away from (the browser's own text undo).
function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export default function StudyPlan() {
  const [tasks, setTasks] = useState([]);
  const [dayRows, setDayRows] = useState([]);
  const [meta, setMeta] = useState({});
  const [manualMocks, setManualMocks] = useState([]);
  const [scrapedMocks, setScrapedMocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingMetaTestDate, setEditingMetaTestDate] = useState(false);
  const [testDateDraft, setTestDateDraft] = useState('');
  const [activeDrag, setActiveDrag] = useState(null); // { type: 'task' | 'day', id }
  const [toast, setToast] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const reorderInFlight = useRef(false);

  // ─── State mirrors (so snapshot() always reads the latest committed state) ──
  const tasksRef = useRef(tasks);
  const daysRef = useRef(dayRows);
  const metaRef = useRef(meta);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  useEffect(() => { daysRef.current = dayRows; }, [dayRows]);
  useEffect(() => { metaRef.current = meta; }, [meta]);

  // ─── History (multi-level undo / redo) ─────────────────────────────────────
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const historyBusy = useRef(false);
  const [, setHistoryVersion] = useState(0);
  const bumpHistory = () => setHistoryVersion((v) => v + 1);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [plan, mocksData] = await Promise.all([
        fetchJson('/api/study-plan'),
        fetchJson('/api/mocks'),
      ]);
      setTasks(plan.tasks || []);
      setDayRows(plan.days || []);
      setMeta(plan.meta || {});
      setManualMocks((mocksData.mocks || []).map((m) => ({ ...m, source_type: 'manual' })));
      setScrapedMocks(mocksData.mocks_scraped || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  function snapshot() {
    return {
      tasks: tasksRef.current.map((t) => ({ ...t })),
      days: daysRef.current.map((d) => ({ ...d })),
      meta: { ...metaRef.current },
    };
  }

  // Capture the pre-action state. Call at the very start of a mutating handler.
  function pushHistory() {
    setError(null); // a fresh action clears any stale error from a prior failure
    undoStackRef.current.push(snapshot());
    if (undoStackRef.current.length > HISTORY_LIMIT) undoStackRef.current.shift();
    redoStackRef.current = [];
    bumpHistory();
  }

  async function applySnapshot(snap) {
    setTasks(snap.tasks);
    setDayRows(snap.days);
    setMeta(snap.meta);
    try {
      const data = await fetchJson('/api/study-plan/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snap),
      });
      if (data.tasks) setTasks(data.tasks);
      if (data.days) setDayRows(data.days);
      if (data.meta) setMeta(data.meta);
      return true;
    } catch (e) {
      setError(e.message);
      refresh(); // restore failed — fall back to server truth
      return false;
    }
  }

  async function undo() {
    if (historyBusy.current || undoStackRef.current.length === 0) return;
    historyBusy.current = true;
    const current = snapshot();
    const target = undoStackRef.current[undoStackRef.current.length - 1];
    try {
      // Only move entries between the stacks once the server confirms; a failed
      // restore leaves both stacks (and, via refresh, the UI) untouched.
      if (await applySnapshot(target)) {
        undoStackRef.current.pop();
        redoStackRef.current.push(current);
        bumpHistory();
        showToast('Change reverted', { actionLabel: 'Redo', onAction: redo });
      }
    } finally {
      historyBusy.current = false;
    }
  }

  async function redo() {
    if (historyBusy.current || redoStackRef.current.length === 0) return;
    historyBusy.current = true;
    const current = snapshot();
    const target = redoStackRef.current[redoStackRef.current.length - 1];
    try {
      if (await applySnapshot(target)) {
        redoStackRef.current.pop();
        undoStackRef.current.push(current);
        bumpHistory();
        showToast('Change reapplied', { actionLabel: 'Undo', onAction: undo });
      }
    } finally {
      historyBusy.current = false;
    }
  }

  const toastSeq = useRef(0);
  function showToast(message, opts = {}) {
    setToast({
      id: ++toastSeq.current,
      message,
      actionLabel: opts.actionLabel || null,
      onAction: opts.onAction || null,
      duration: opts.duration || 7000,
    });
  }
  function dismissToast() { setToast(null); }

  // Keep latest handlers reachable from the once-attached keyboard listener.
  const actionsRef = useRef({ undo, redo });
  actionsRef.current = { undo, redo };
  useEffect(() => {
    function onKey(e) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z') {
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        if (e.shiftKey) actionsRef.current.redo();
        else actionsRef.current.undo();
      } else if (k === 'y') {
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        actionsRef.current.redo();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ─── Task mutations ─────────────────────────────────────────────────────────

  async function toggleStatus(task) {
    const nextStatus = task.status === 'done' ? 'pending' : 'done';
    pushHistory();
    setTasks((prev) =>
      prev.map((t) =>
        t.id === task.id
          ? { ...t, status: nextStatus, completed_at: nextStatus === 'done' ? new Date().toISOString() : null }
          : t,
      ),
    );
    try {
      await fetchJson(`/api/study-plan/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
    } catch (e) { setError(e.message); refresh(); }
  }

  async function markSkipped(task) {
    const nextStatus = task.status === 'skipped' ? 'pending' : 'skipped';
    pushHistory();
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: nextStatus } : t)));
    try {
      await fetchJson(`/api/study-plan/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
    } catch (e) { setError(e.message); refresh(); }
  }

  async function updateTask(id, patch) {
    pushHistory();
    try {
      const data = await fetchJson(`/api/study-plan/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      setTasks((prev) => prev.map((t) => (t.id === id ? data.task : t)));
    } catch (e) { setError(e.message); }
  }

  async function deleteTask(id) {
    const task = tasks.find((t) => t.id === id);
    pushHistory();
    setTasks((prev) => prev.filter((t) => t.id !== id));
    try {
      await fetchJson(`/api/study-plan/tasks/${id}`, { method: 'DELETE' });
      showToast(`Deleted “${task ? task.title : 'task'}”`, { actionLabel: 'Undo', onAction: undo });
    } catch (e) { setError(e.message); refresh(); }
  }

  async function addTask(day, title) {
    const t = String(title || '').trim();
    if (!t) return;
    pushHistory();
    try {
      const data = await fetchJson('/api/study-plan/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          day_date: day.date,
          week_number: day.week,
          day_label: day.label,
          day_theme: day.theme,
          title: t,
        }),
      });
      setTasks((prev) => [...prev, data.task]);
      showToast('Task added', { actionLabel: 'Undo', onAction: undo });
    } catch (e) { setError(e.message); refresh(); }
  }

  async function reorderTasks(activeTaskId, overId) {
    if (reorderInFlight.current) return;
    const result = computeReorder(tasks, activeTaskId, overId, dayMeta);
    if (!result) return;
    const prevTasks = tasks;
    pushHistory();
    reorderInFlight.current = true;
    setTasks(result.optimisticTasks);
    try {
      const data = await fetchJson('/api/study-plan/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: result.updates }),
      });
      if (data.tasks) setTasks(data.tasks);
      showToast('Task moved', { actionLabel: 'Undo', onAction: undo });
    } catch (e) {
      setError(e.message);
      setTasks(prevTasks);
    } finally {
      reorderInFlight.current = false;
    }
  }

  // ─── Day mutations (first-class days) ───────────────────────────────────────

  async function addDay(week) {
    const taken = new Set(dayRows.map((d) => d.date));
    const inWeek = days.filter((d) => d.week === week);
    const anchor = inWeek.length ? inWeek[inWeek.length - 1].date : todayLocalISODate();
    let date = addDaysISO(anchor, 1);
    while (taken.has(date)) date = addDaysISO(date, 1);
    pushHistory();
    try {
      const data = await fetchJson('/api/study-plan/days', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, week_number: week, day_label: weekdayLabel(date), day_theme: '' }),
      });
      setDayRows((prev) => [...prev, data.day]);
      showToast('Day added', { actionLabel: 'Undo', onAction: undo });
    } catch (e) { setError(e.message); refresh(); }
  }

  async function updateDay(oldDate, patch) {
    const isReschedule = patch.date && patch.date !== oldDate;
    pushHistory();
    try {
      const data = await fetchJson(`/api/study-plan/days/${oldDate}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const nd = data.day;
      setDayRows((prev) => prev.map((d) => (d.date === oldDate ? nd : d)));
      setTasks((prev) =>
        prev.map((t) =>
          t.day_date === oldDate
            ? { ...t, day_date: nd.date, week_number: nd.week_number, day_label: nd.day_label, day_theme: nd.day_theme }
            : t,
        ),
      );
      showToast(isReschedule ? 'Day rescheduled' : 'Day updated', { actionLabel: 'Undo', onAction: undo });
    } catch (e) {
      setError(e.message);
      // Nothing changed — drop the optimistic history entry.
      undoStackRef.current.pop();
      bumpHistory();
    }
  }

  async function deleteDay(date) {
    const day = days.find((d) => d.date === date);
    const n = day ? day.tasks.length : 0;
    pushHistory();
    setDayRows((prev) => prev.filter((d) => d.date !== date));
    setTasks((prev) => prev.filter((t) => t.day_date !== date));
    try {
      await fetchJson(`/api/study-plan/days/${date}`, { method: 'DELETE' });
      const label = n > 0 ? `Day deleted · ${n} task${n === 1 ? '' : 's'}` : 'Day deleted';
      showToast(label, { actionLabel: 'Undo', onAction: undo, duration: 10000 });
    } catch (e) { setError(e.message); refresh(); }
  }

  async function reorderDays(activeDate, overDayRowId) {
    if (reorderInFlight.current) return;
    const result = computeDayReorder(dayRows, activeDate, overDayRowId);
    if (!result) return;
    const prevDays = dayRows;
    const prevTasks = tasks;
    pushHistory();
    reorderInFlight.current = true;
    const movedWeek = result.optimisticDays.find((d) => d.date === activeDate)?.week_number;
    setDayRows(result.optimisticDays);
    setTasks((prev) =>
      prev.map((t) => (t.day_date === activeDate ? { ...t, week_number: movedWeek } : t)),
    );
    try {
      const data = await fetchJson('/api/study-plan/days/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: result.updates }),
      });
      if (data.days) setDayRows(data.days);
      showToast('Day moved', { actionLabel: 'Undo', onAction: undo });
    } catch (e) {
      setError(e.message);
      setDayRows(prevDays);
      setTasks(prevTasks);
    } finally {
      reorderInFlight.current = false;
    }
  }

  // ─── Mock mutations (unchanged behavior) ────────────────────────────────────

  async function addMock(payload) {
    try {
      const data = await fetchJson('/api/mocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setManualMocks((prev) => [...prev, { ...data.mock, source_type: 'manual' }]);
      return true;
    } catch (e) { setError(e.message); return false; }
  }

  async function updateMock(id, payload) {
    try {
      const data = await fetchJson(`/api/mocks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setManualMocks((prev) =>
        prev.map((m) => (m.id === id ? { ...data.mock, source_type: 'manual' } : m)),
      );
      return true;
    } catch (e) { setError(e.message); return false; }
  }

  async function deleteMock(id) {
    if (!window.confirm('Delete this mock result?')) return;
    try {
      await fetchJson(`/api/mocks/${id}`, { method: 'DELETE' });
      setManualMocks((prev) => prev.filter((m) => m.id !== id));
    } catch (e) { setError(e.message); }
  }

  async function resetPlan() {
    const doneCount = tasks.filter((t) => t.status === 'done').length;
    const notesCount = tasks.filter((t) => t.notes && t.notes.trim()).length;
    let confirmMsg = 'Reset plan to the default 4-week seed?\n\nThis wipes ALL tasks and days and re-creates them from scratch.';
    if (doneCount > 0 || notesCount > 0) {
      confirmMsg += `\n\nWARNING: You will lose ${doneCount} checked-off task${doneCount === 1 ? '' : 's'}`;
      if (notesCount > 0) confirmMsg += ` and ${notesCount} task${notesCount === 1 ? '' : 's'} with notes`;
      confirmMsg += '.';
    }
    confirmMsg += '\n\n(You can still undo this afterward.)';
    if (!window.confirm(confirmMsg)) return;
    pushHistory();
    try {
      await fetchJson('/api/study-plan/reset', { method: 'POST' });
      await refresh();
      showToast('Plan reset to defaults', { actionLabel: 'Undo', onAction: undo, duration: 12000 });
    } catch (e) { setError(e.message); }
  }

  async function saveTestDate() {
    const v = (testDateDraft || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { setError('Test date must be YYYY-MM-DD'); return; }
    pushHistory();
    try {
      const data = await fetchJson('/api/study-plan/meta', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test_date: v }),
      });
      setMeta(data.meta);
      setEditingMetaTestDate(false);
    } catch (e) {
      setError(e.message);
      undoStackRef.current.pop();
      bumpHistory();
    }
  }

  // ─── Drag wiring (tasks + whole days share one DndContext) ──────────────────

  function resolveDayRowTarget(overId) {
    if (isDayRowDraggableId(overId)) return overId;
    if (isDayDroppableId(overId)) return dayRowDraggableId(overId.slice('day:'.length));
    if (typeof overId === 'number') {
      const t = tasks.find((x) => x.id === overId);
      return t ? dayRowDraggableId(t.day_date) : null;
    }
    return null;
  }

  function resolveTaskTarget(overId) {
    // A task dropped over a day's drag-handle row lands at the end of that day.
    if (isDayRowDraggableId(overId)) return dayDroppableId(dateFromDayRowId(overId));
    return overId;
  }

  function handleDragStart(event) {
    const id = event.active.id;
    setActiveDrag(isDayRowDraggableId(id) ? { type: 'day', id } : { type: 'task', id });
  }

  function handleDragEnd(event) {
    const { active, over } = event;
    setActiveDrag(null);
    if (!over) return;
    if (isDayRowDraggableId(active.id)) {
      const target = resolveDayRowTarget(over.id);
      if (target) reorderDays(dateFromDayRowId(active.id), target);
    } else {
      reorderTasks(active.id, resolveTaskTarget(over.id));
    }
  }

  function handleDragCancel() { setActiveDrag(null); }

  // ─── Derived ────────────────────────────────────────────────────────────────

  const overall = useMemo(() => progressFor(tasks), [tasks]);
  const days = useMemo(() => buildDays(tasks, dayRows), [tasks, dayRows]);
  const weeks = useMemo(() => groupByWeek(days), [days]);
  const dayMeta = useMemo(() => {
    const m = {};
    for (const d of days) m[d.date] = { week_number: d.week, day_label: d.label, day_theme: d.theme };
    return m;
  }, [days]);
  const dayIds = useMemo(() => days.map((d) => dayRowDraggableId(d.date)), [days]);
  const weekOptions = useMemo(() => {
    const s = new Set(days.map((d) => d.week));
    [1, 2, 3, 4].forEach((w) => s.add(w));
    return Array.from(s).sort((a, b) => a - b);
  }, [days]);
  const mocks = useMemo(() => {
    const combined = [...manualMocks, ...scrapedMocks];
    combined.sort((a, b) => {
      const d = String(a.mock_date || '').localeCompare(String(b.mock_date || ''));
      if (d !== 0) return d;
      if (a.source_type !== b.source_type) return a.source_type === 'manual' ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });
    return combined;
  }, [manualMocks, scrapedMocks]);

  const today = todayLocalISODate();
  const testDate = meta.test_date || null;
  const daysToTest = testDate ? daysBetween(today, testDate) : null;
  const planTitle = meta.plan_title || 'GMAT Study Plan';
  const canUndo = undoStackRef.current.length > 0;
  const canRedo = redoStackRef.current.length > 0;

  const activeTask = activeDrag?.type === 'task' ? tasks.find((t) => t.id === activeDrag.id) : null;
  const activeDay = activeDrag?.type === 'day'
    ? days.find((d) => d.date === dateFromDayRowId(activeDrag.id))
    : null;

  // Keep keyboard handler pointed at the freshest undo/redo closures.
  actionsRef.current = { undo, redo };

  if (loading) {
    return (
      <main className="page-shell">
        <header className="top-bar">
          <div className="top-bar-left">
            <h1 className="top-bar-title">Study Plan</h1>
            <span className="top-bar-status">Loading...</span>
          </div>
        </header>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <header className="top-bar">
        <div className="top-bar-left">
          <h1 className="top-bar-title">{planTitle}</h1>
          {error && <span className="top-bar-status error">{error}</span>}
        </div>
        <div className="top-bar-actions">
          <div className="sp-history" role="group" aria-label="Undo and redo" title="Undo history for this editing session — clears on page reload">
            <button
              type="button"
              className="sp-history-btn"
              onClick={undo}
              disabled={!canUndo}
              title={canUndo ? 'Undo last change (⌘Z)' : 'Nothing to undo'}
              aria-label="Undo last change"
            >
              <Undo2 size={16} aria-hidden="true" />
              <span>Undo</span>
            </button>
            <button
              type="button"
              className="sp-history-btn"
              onClick={redo}
              disabled={!canRedo}
              title={canRedo ? 'Redo (⌘⇧Z)' : 'Nothing to redo'}
              aria-label="Redo change"
            >
              <Redo2 size={16} aria-hidden="true" />
              <span>Redo</span>
            </button>
          </div>
          <Button variant="ghost" size="sm" type="button" onClick={resetPlan} title="Wipe ALL tasks and days and reload from the latest seed (undoable)">
            Reset to defaults
          </Button>
          <Button variant="outline" size="sm" type="button" onClick={() => { window.location.hash = ''; }}>
            ← Back to GMAT Analytics
          </Button>
        </div>
      </header>

      <section className="card" style={{ padding: '20px 24px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <div>
              <div className="sp-stat-label">Test date</div>
              {editingMetaTestDate ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                  <input type="date" value={testDateDraft} onChange={(e) => setTestDateDraft(e.target.value)} className="sp-input" />
                  <Button size="sm" onClick={saveTestDate}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingMetaTestDate(false)}>Cancel</Button>
                </div>
              ) : (
                <div className="sp-stat-value">
                  {testDate || '—'}{' '}
                  <button type="button" className="sp-linkbtn" onClick={() => { setTestDateDraft(testDate || ''); setEditingMetaTestDate(true); }}>edit</button>
                </div>
              )}
            </div>
            <div>
              <div className="sp-stat-label">Days to test</div>
              <div className="sp-stat-value">{daysToTest == null ? '—' : daysToTest < 0 ? 'past' : `${daysToTest} d`}</div>
            </div>
            <div>
              <div className="sp-stat-label">Overall progress</div>
              <div className="sp-stat-value">{overall.done}/{overall.total} · {overall.pct}%</div>
            </div>
          </div>
          <ProgressBar pct={overall.pct} width={260} />
        </div>
      </section>

      <MockResultsPanel mocks={mocks} onAdd={addMock} onUpdate={updateMock} onDelete={deleteMock} />

      {days.length === 0 && (
        <section className="card" style={{ padding: '32px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>No days in your plan yet</div>
          <div style={{ fontSize: 13, color: 'var(--ink-2)', marginBottom: 16 }}>
            Add a day to start building your schedule, or use “Reset to defaults” for the 4-week plan.
          </div>
          <Button size="sm" onClick={() => addDay(1)}>
            <CalendarPlus size={14} aria-hidden="true" style={{ marginRight: 6 }} /> Add a day
          </Button>
        </section>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={dayIds} strategy={verticalListSortingStrategy}>
          {weeks.map(({ week, days: daysInWeek }) => (
            <WeekSection
              key={week}
              week={week}
              days={daysInWeek}
              today={today}
              weekOptions={weekOptions}
              onToggle={toggleStatus}
              onSkip={markSkipped}
              onUpdate={updateTask}
              onDelete={deleteTask}
              onAdd={addTask}
              onAddDay={addDay}
              onEditDay={updateDay}
              onDeleteDay={deleteDay}
              draggingDay={activeDrag?.type === 'day'}
            />
          ))}
        </SortableContext>
        <DragOverlay>
          {activeTask ? <TaskDragPreview task={activeTask} /> : null}
          {activeDay ? <DayDragPreview day={activeDay} /> : null}
        </DragOverlay>
      </DndContext>

      <UndoToast toast={toast} onDismiss={dismissToast} />
    </main>
  );
}

// ─── Mock Results Panel ──────────────────────────────────────────────────────

function MockResultsPanel({ mocks, onAdd, onUpdate, onDelete }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);

  const latest = mocks[mocks.length - 1];
  const previous = mocks.length >= 2 ? mocks[mocks.length - 2] : null;
  const scrapedCount = mocks.filter((m) => m.source_type === 'scraped').length;
  const manualCount = mocks.length - scrapedCount;

  function trend(curr, prev, field) {
    if (curr == null || prev == null) return null;
    const c = curr[field];
    const p = prev[field];
    if (c == null || p == null) return null;
    const delta = c - p;
    if (delta === 0) return { label: '=', color: 'var(--muted)' };
    if (delta > 0) return { label: `▲ ${delta}`, color: '#1f9d55' };
    return { label: `▼ ${Math.abs(delta)}`, color: 'var(--danger)' };
  }

  return (
    <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <header style={{ padding: '16px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--primary-lt)' }}>
        <div>
          <div className="sp-stat-label">
            {mocks.length} mock{mocks.length === 1 ? '' : 's'} recorded
            {scrapedCount > 0 && <span style={{ marginLeft: 8, opacity: 0.85 }}>· {scrapedCount} scraped, {manualCount} manual</span>}
          </div>
          <h2 style={{ margin: '4px 0 0 0', fontSize: 18, fontWeight: 700 }}>Mock Results</h2>
        </div>
        {!adding && <Button size="sm" onClick={() => setAdding(true)}>+ Add mock</Button>}
      </header>

      {mocks.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr className="sp-th-row" style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                <th style={{ padding: '10px 24px' }}>Date</th>
                <th style={{ padding: '10px 12px' }}>Source</th>
                <th style={{ padding: '10px 12px' }}>Total</th>
                <th style={{ padding: '10px 12px' }}>Quant</th>
                <th style={{ padding: '10px 12px' }}>DI</th>
                <th style={{ padding: '10px 12px' }}>Verbal</th>
                <th style={{ padding: '10px 24px', textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {mocks.map((m, idx) => {
                const isScraped = m.source_type === 'scraped';
                if (!isScraped && editingId === m.id) {
                  return <MockRowEditor key={m.id} mock={m} onCancel={() => setEditingId(null)} onSave={async (payload) => { if (await onUpdate(m.id, payload)) setEditingId(null); }} />;
                }
                const prev = idx > 0 ? mocks[idx - 1] : null;
                return (
                  <tr key={m.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '10px 24px', whiteSpace: 'nowrap' }}>{m.mock_date}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>{m.source_label}</span>
                        <SourceTypeChip type={m.source_type} />
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px' }}><ScoreCell score={m.total_score} pct={m.total_percentile} trend={trend(m, prev, 'total_score')} /></td>
                    <td style={{ padding: '10px 12px' }}><ScoreCell score={m.quant_score} pct={m.quant_percentile} trend={trend(m, prev, 'quant_score')} /></td>
                    <td style={{ padding: '10px 12px' }}><ScoreCell score={m.di_score} pct={m.di_percentile} trend={trend(m, prev, 'di_score')} /></td>
                    <td style={{ padding: '10px 12px' }}><ScoreCell score={m.verbal_score} pct={m.verbal_percentile} trend={trend(m, prev, 'verbal_score')} /></td>
                    <td style={{ padding: '10px 24px', textAlign: 'right' }}>
                      {isScraped ? (
                        <span style={{ fontSize: 11, opacity: 0.5 }} title="Scraped from GMAT Official Practice — edit via the dashboard scrape flow">read-only</span>
                      ) : (
                        <>
                          <IconButton title="Edit" onClick={() => setEditingId(m.id)}><Pencil size={14} /></IconButton>
                          <IconButton title="Delete" onClick={() => onDelete(m.id)}><Trash2 size={14} /></IconButton>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <MockRowEditor mock={null} onCancel={() => setAdding(false)} onSave={async (payload) => { if (await onAdd(payload)) setAdding(false); }} />
      )}

      {latest && (
        <div style={{ padding: '12px 24px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--ink-2)' }}>
          {previous ? (
            <>Latest: <strong>{latest.source_label}</strong> ({latest.mock_date}) — Total {latest.total_score} vs prev {previous.total_score} ({(latest.total_score - previous.total_score) >= 0 ? '+' : ''}{latest.total_score - previous.total_score}).</>
          ) : (
            <>Baseline established. Add more mocks to see trend.</>
          )}
        </div>
      )}
    </section>
  );
}

function SourceTypeChip({ type }) {
  if (type !== 'scraped' && type !== 'manual') return null;
  const isScraped = type === 'scraped';
  return (
    <span
      title={isScraped ? 'Imported from GMAT Official Practice scrape' : 'Manually entered'}
      style={{
        fontSize: 9, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
        padding: '2px 6px', borderRadius: 999, border: '1px solid',
        borderColor: isScraped ? 'rgba(16,185,129,0.35)' : 'rgba(61,122,94,0.35)',
        color: isScraped ? '#047857' : 'var(--primary)',
        background: isScraped ? 'rgba(16,185,129,0.08)' : 'var(--primary-lt)',
      }}
    >
      {isScraped ? 'scraped' : 'manual'}
    </span>
  );
}

function ScoreCell({ score, pct, trend }) {
  if (score == null && pct == null) return <span style={{ opacity: 0.4 }}>—</span>;
  return (
    <div>
      <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, fontVariantNumeric: 'tabular-nums' }}>
        <span>{score ?? '—'}</span>
        {trend && <span style={{ fontSize: 10, color: trend.color, fontWeight: 700 }}>{trend.label}</span>}
      </div>
      {pct != null && <div style={{ fontSize: 10, color: 'var(--ink-2)' }}>{pct}th %ile</div>}
    </div>
  );
}

function MockRowEditor({ mock, onCancel, onSave }) {
  const [draft, setDraft] = useState({
    mock_date: mock?.mock_date || new Date().toISOString().slice(0, 10),
    source_label: mock?.source_label || '',
    total_score: mock?.total_score ?? '',
    total_percentile: mock?.total_percentile ?? '',
    quant_score: mock?.quant_score ?? '',
    quant_percentile: mock?.quant_percentile ?? '',
    di_score: mock?.di_score ?? '',
    di_percentile: mock?.di_percentile ?? '',
    verbal_score: mock?.verbal_score ?? '',
    verbal_percentile: mock?.verbal_percentile ?? '',
    notes: mock?.notes || '',
  });
  function set(field, v) { setDraft((d) => ({ ...d, [field]: v })); }
  return (
    <tr style={{ borderTop: '1px solid var(--border)', background: 'var(--primary-lt)' }}>
      <td colSpan={7} style={{ padding: '12px 24px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 10 }}>
          <Field label="Date"><input type="date" value={draft.mock_date} onChange={(e) => set('mock_date', e.target.value)} className="sp-input sp-input-full" /></Field>
          <Field label="Source"><input type="text" placeholder="e.g. OPE4" value={draft.source_label} onChange={(e) => set('source_label', e.target.value)} className="sp-input sp-input-full" /></Field>
          <Field label="Total score"><input type="number" min="205" max="805" step="10" value={draft.total_score} onChange={(e) => set('total_score', e.target.value)} className="sp-input sp-input-full" /></Field>
          <Field label="Total %ile"><input type="number" min="0" max="100" value={draft.total_percentile} onChange={(e) => set('total_percentile', e.target.value)} className="sp-input sp-input-full" /></Field>
          <Field label="Quant"><input type="number" min="60" max="90" value={draft.quant_score} onChange={(e) => set('quant_score', e.target.value)} className="sp-input sp-input-full" /></Field>
          <Field label="Quant %ile"><input type="number" min="0" max="100" value={draft.quant_percentile} onChange={(e) => set('quant_percentile', e.target.value)} className="sp-input sp-input-full" /></Field>
          <Field label="DI"><input type="number" min="60" max="90" value={draft.di_score} onChange={(e) => set('di_score', e.target.value)} className="sp-input sp-input-full" /></Field>
          <Field label="DI %ile"><input type="number" min="0" max="100" value={draft.di_percentile} onChange={(e) => set('di_percentile', e.target.value)} className="sp-input sp-input-full" /></Field>
          <Field label="Verbal"><input type="number" min="60" max="90" value={draft.verbal_score} onChange={(e) => set('verbal_score', e.target.value)} className="sp-input sp-input-full" /></Field>
          <Field label="Verbal %ile"><input type="number" min="0" max="100" value={draft.verbal_percentile} onChange={(e) => set('verbal_percentile', e.target.value)} className="sp-input sp-input-full" /></Field>
        </div>
        <textarea placeholder="Notes (optional)..." value={draft.notes} onChange={(e) => set('notes', e.target.value)} rows={2} className="sp-input sp-input-full" style={{ resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Button size="sm" onClick={() => onSave(draft)}>Save</Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </td>
    </tr>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="sp-stat-label">{label}</span>
      {children}
    </label>
  );
}

function ProgressBar({ pct, width = 200 }) {
  return (
    <div className="sp-progress" style={{ width }} title={`${pct}% complete`}>
      <div className="sp-progress-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

function WeekSection({ week, days, today, weekOptions, onToggle, onSkip, onUpdate, onDelete, onAdd, onAddDay, onEditDay, onDeleteDay, draggingDay }) {
  const allTasks = days.flatMap((d) => d.tasks);
  const prog = progressFor(allTasks);
  const totalMinutes = allTasks.reduce((s, t) => s + (Number(t.est_minutes) || 0), 0);
  const doneMinutes = allTasks.filter((t) => t.status === 'done').reduce((s, t) => s + (Number(t.est_minutes) || 0), 0);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <header className="sp-week-head" onClick={() => setCollapsed((c) => !c)}>
        <div>
          <div className="sp-stat-label">
            {collapsed ? '▶' : '▼'} {prog.done}/{prog.total} tasks · {formatMinutes(doneMinutes)}/{formatMinutes(totalMinutes)}
          </div>
          <h2 style={{ margin: '4px 0 0 0', fontSize: 18, fontWeight: 700 }}>{WEEK_LABELS[week] || `Week ${week}`}</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ProgressBar pct={prog.pct} width={200} />
          <button type="button" className="sp-addday-btn" onClick={(e) => { e.stopPropagation(); onAddDay(week); }} title={`Add a day to ${WEEK_LABELS[week] || `Week ${week}`}`}>
            <CalendarPlus size={14} aria-hidden="true" /> Add day
          </button>
        </div>
      </header>
      {!collapsed && (
        <div style={{ padding: '8px 0' }}>
          {days.map((day) => (
            <DayCard
              key={day.date}
              day={day}
              isToday={day.date === today}
              isPast={day.date < today}
              weekOptions={weekOptions}
              onToggle={onToggle}
              onSkip={onSkip}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onAdd={onAdd}
              onEditDay={onEditDay}
              onDeleteDay={onDeleteDay}
              draggingDay={draggingDay}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DayCard({ day, isToday, isPast, weekOptions, onToggle, onSkip, onUpdate, onDelete, onAdd, onEditDay, onDeleteDay, draggingDay }) {
  const prog = progressFor(day.tasks);
  const totalMinutes = day.tasks.reduce((s, t) => s + (Number(t.est_minutes) || 0), 0);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [editingDay, setEditingDay] = useState(false);

  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: dayDroppableId(day.date) });
  const { setNodeRef: setDayRef, attributes, listeners, transform, transition, isDragging } =
    useSortable({ id: dayRowDraggableId(day.date) });

  const cardStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
  };

  function submitAdd() {
    if (draft.trim()) {
      onAdd(day, draft.trim());
      setDraft('');
      setAdding(false);
    }
  }

  return (
    <div ref={setDayRef} style={cardStyle} className={`sp-day${isToday ? ' is-today' : ''}${draggingDay ? ' sp-day-dragmode' : ''}`}>
      <div className="sp-day-head">
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 }}>
          <button
            type="button"
            className="sp-day-grip"
            {...attributes}
            {...listeners}
            title="Drag to reorder or move this day to another week"
            aria-label={`Drag day ${day.label || ''} ${day.date}`}
          >
            <GripVertical size={15} aria-hidden="true" />
          </button>
          <span className={`sp-day-date${isToday ? ' is-today' : ''}${isPast ? ' is-past' : ''}`}>
            {day.label ? `${day.label} · ` : ''}{day.date}
            {isToday && <span style={{ marginLeft: 6 }}>· today</span>}
          </span>
          {day.theme
            ? <span className="sp-day-theme">{day.theme}</span>
            : <span className="sp-day-theme sp-day-theme-empty">Untitled day</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums', marginRight: 2 }}>
            {prog.done}/{prog.total} · {formatMinutes(totalMinutes)}
          </span>
          <IconButton title="Edit day (date, week, theme)" onClick={() => setEditingDay((v) => !v)} active={editingDay}><Pencil size={14} /></IconButton>
          <IconButton title="Delete this day and its tasks" onClick={() => onDeleteDay(day.date)}><Trash2 size={14} /></IconButton>
        </div>
      </div>

      {editingDay && (
        <DayEditor
          day={day}
          weekOptions={weekOptions}
          onCancel={() => setEditingDay(false)}
          onSave={(patch) => { onEditDay(day.date, patch); setEditingDay(false); }}
        />
      )}

      <div ref={setDropRef} className={`sp-day-drop${isOver ? ' is-over' : ''}`} style={{ minHeight: day.tasks.length === 0 ? 36 : undefined }}>
        <SortableContext items={day.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {day.tasks.map((task) => (
            <SortableTaskRow key={task.id} task={task} onToggle={onToggle} onSkip={onSkip} onUpdate={onUpdate} onDelete={onDelete} />
          ))}
        </SortableContext>
        {day.tasks.length === 0 && (
          <div className="sp-day-empty">{isOver ? 'Drop here' : 'No tasks — drag one here'}</div>
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
              className="sp-input"
              style={{ flex: 1 }}
            />
            <Button size="sm" onClick={submitAdd}>Add</Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setDraft(''); }}>Cancel</Button>
          </div>
        ) : (
          <button type="button" className="sp-addtask-btn" onClick={() => setAdding(true)}>
            <Plus size={13} aria-hidden="true" /> add task
          </button>
        )}
      </div>
    </div>
  );
}

function DayEditor({ day, weekOptions, onCancel, onSave }) {
  const [date, setDate] = useState(day.date);
  const [week, setWeek] = useState(day.week);
  const [theme, setTheme] = useState(day.theme || '');
  const [label, setLabel] = useState(day.label || '');

  function save() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    onSave({
      date,
      week_number: Number(week),
      day_label: label.trim() || weekdayLabel(date),
      day_theme: theme.trim(),
    });
  }

  return (
    <div className="sp-day-editor">
      <Field label="Date">
        <input
          type="date"
          value={date}
          onChange={(e) => { setDate(e.target.value); if (e.target.value) setLabel(weekdayLabel(e.target.value)); }}
          className="sp-input sp-input-full"
        />
      </Field>
      <Field label="Week">
        <select value={week} onChange={(e) => setWeek(e.target.value)} className="sp-input sp-input-full">
          {weekOptions.map((w) => <option key={w} value={w}>{`Week ${w}`}</option>)}
        </select>
      </Field>
      <Field label="Theme">
        <input type="text" value={theme} onChange={(e) => setTheme(e.target.value)} placeholder="e.g. DS technique drill" className="sp-input sp-input-full" />
      </Field>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <Button size="sm" onClick={save}>Save day</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function SortableTaskRow({ task, onToggle, onSkip, onUpdate, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
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
        className="sp-task-grip"
        {...attributes}
        {...listeners}
        title="Drag to reorder or move to another day"
        aria-label={`Drag task: ${task.title}`}
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <TaskRow task={task} onToggle={onToggle} onSkip={onSkip} onUpdate={onUpdate} onDelete={onDelete} />
      </div>
    </div>
  );
}

function TaskDragPreview({ task }) {
  if (!task) return null;
  return (
    <div className="sp-drag-preview">
      <GripVertical size={16} style={{ color: 'var(--muted)' }} aria-hidden="true" />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
    </div>
  );
}

function DayDragPreview({ day }) {
  if (!day) return null;
  return (
    <div className="sp-drag-preview sp-drag-preview-day">
      <GripVertical size={16} style={{ color: 'var(--muted)' }} aria-hidden="true" />
      <span style={{ fontWeight: 700 }}>{day.label ? `${day.label} · ` : ''}{day.date}</span>
      {day.theme && <span style={{ color: 'var(--ink-2)' }}>{day.theme}</span>}
      <span style={{ color: 'var(--ink-2)', fontSize: 11 }}>{day.tasks.length} task{day.tasks.length === 1 ? '' : 's'}</span>
    </div>
  );
}

function TaskRow({ task, onToggle, onSkip, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [descDraft, setDescDraft] = useState(task.description || '');
  const [minutesDraft, setMinutesDraft] = useState(task.est_minutes || '');
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState(task.notes || '');
  const [notesDirty, setNotesDirty] = useState(false);

  useEffect(() => { setTitleDraft(task.title); }, [task.title]);
  useEffect(() => { setDescDraft(task.description || ''); }, [task.description]);
  useEffect(() => { setMinutesDraft(task.est_minutes || ''); }, [task.est_minutes]);
  useEffect(() => { setNotesDraft(task.notes || ''); setNotesDirty(false); }, [task.notes]);

  function saveEdit() {
    const m = String(minutesDraft).trim();
    onUpdate(task.id, {
      title: titleDraft,
      description: descDraft || null,
      est_minutes: m === '' ? null : Number(m),
    });
    setEditing(false);
  }

  function saveNotes() {
    onUpdate(task.id, { notes: notesDraft || null });
    setNotesDirty(false);
  }

  const isDone = task.status === 'done';
  const isSkipped = task.status === 'skipped';

  if (editing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0 8px 28px' }}>
        <input type="text" value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} className="sp-input sp-input-full" />
        <textarea value={descDraft} onChange={(e) => setDescDraft(e.target.value)} placeholder="Description (optional)" rows={2} className="sp-input sp-input-full" style={{ resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12 }}>Minutes:</label>
          <input type="number" min="0" value={minutesDraft} onChange={(e) => setMinutesDraft(e.target.value)} className="sp-input" style={{ width: 80 }} />
          <Button size="sm" onClick={saveEdit}>Save</Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 10, padding: '6px 0', alignItems: 'flex-start', opacity: isSkipped ? 0.5 : 1 }}>
      <input
        type="checkbox"
        checked={isDone}
        onChange={() => onToggle(task)}
        className="sp-check"
        aria-label={`Mark "${task.title}" as ${isDone ? 'pending' : 'done'}`}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, textDecoration: isDone || isSkipped ? 'line-through' : 'none', color: isDone ? 'var(--ink-2)' : 'inherit' }}>
          {task.title}
          {task.est_minutes ? <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--ink-2)', fontWeight: 400 }}>{formatMinutes(task.est_minutes)}</span> : null}
        </div>
        {task.description && <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 2 }}>{task.description}</div>}
        {notesOpen && (
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <textarea
              value={notesDraft}
              onChange={(e) => { setNotesDraft(e.target.value); setNotesDirty(true); }}
              placeholder="Personal notes (what went well, what to fix)..."
              rows={3}
              className="sp-input sp-input-full"
              style={{ resize: 'vertical', background: 'rgba(61,122,94,0.04)' }}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <Button size="sm" disabled={!notesDirty} onClick={saveNotes}>Save notes</Button>
              <Button size="sm" variant="ghost" onClick={() => { setNotesDraft(task.notes || ''); setNotesDirty(false); setNotesOpen(false); }}>Close</Button>
            </div>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <IconButton title={task.notes ? 'View notes' : 'Add notes'} onClick={() => setNotesOpen((o) => !o)} active={!!task.notes}><StickyNote size={14} /></IconButton>
        <IconButton title="Edit" onClick={() => setEditing(true)}><Pencil size={14} /></IconButton>
        <IconButton title={isSkipped ? 'Un-skip' : 'Skip'} onClick={() => onSkip(task)}>{isSkipped ? <RotateCcw size={14} /> : <Ban size={14} />}</IconButton>
        <IconButton title="Delete" onClick={() => onDelete(task.id)}><Trash2 size={14} /></IconButton>
      </div>
    </div>
  );
}

function IconButton({ children, title, onClick, active }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className={`sp-iconbtn${active ? ' is-active' : ''}`}>
      {children}
    </button>
  );
}

function UndoToast({ toast, onDismiss }) {
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!toast || hovered) return undefined;
    const t = setTimeout(onDismiss, toast.duration);
    return () => clearTimeout(t);
  }, [toast, hovered, onDismiss]);
  useEffect(() => {
    if (!toast) return undefined;
    function onKey(e) { if (e.key === 'Escape') onDismiss(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toast, onDismiss]);

  if (!toast) return null;
  return (
    <div className="sp-toast-wrap" role="status" aria-live="polite">
      <div className="sp-toast" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        <span className="sp-toast-msg">{toast.message}</span>
        {toast.actionLabel && toast.onAction && (
          <button type="button" className="sp-toast-action" onClick={() => { toast.onAction(); onDismiss(); }}>
            {toast.actionLabel}
          </button>
        )}
        <button type="button" className="sp-toast-close" onClick={onDismiss} aria-label="Dismiss"><X size={15} /></button>
      </div>
    </div>
  );
}
