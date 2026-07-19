import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, StickyNote, Ban, RotateCcw, ArrowRight } from 'lucide-react';
import { Button } from './components/ui/button';
import ProgressRing from './components/ProgressRing';

// Self-contained "Today's Plan" dashboard panel. It reads and writes the same
// study-plan store the full board uses (`/api/study-plan/*`), so every edit here
// shows up on the Study Plan board and vice-versa — SQLite is the source of truth.

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

function todayLocalISODate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysBetween(a, b) {
  const da = new Date(`${a}T00:00:00`);
  const db = new Date(`${b}T00:00:00`);
  return Math.round((db - da) / 86400000);
}

function formatMinutes(min) {
  const m = Math.round(Number(min));
  if (!Number.isFinite(m) || m <= 0) return '';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function weekdayLabel(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return '';
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
}

function prettyDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function TodayPlan({ collapsed, onToggleCollapse }) {
  const [tasks, setTasks] = useState([]);
  const [dayRows, setDayRows] = useState([]);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const plan = await fetchJson('/api/study-plan');
      setTasks(plan.tasks || []);
      setDayRows(plan.days || []);
      setMeta(plan.meta || {});
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const today = todayLocalISODate();

  // Resolve which day to show: today if it exists in the plan, otherwise the
  // nearest upcoming day that has content (the plan may skip calendar days).
  const { focusDate, isToday, dayRow, dayTasks } = useMemo(() => {
    const byDate = new Map();
    for (const t of tasks) {
      if (!byDate.has(t.day_date)) byDate.set(t.day_date, []);
      byDate.get(t.day_date).push(t);
    }
    const rowByDate = new Map(dayRows.map((d) => [d.date, d]));
    const allDates = new Set([...byDate.keys(), ...rowByDate.keys()]);

    let focus = null;
    let isT = false;
    if (allDates.has(today)) {
      focus = today;
      isT = true;
    } else {
      const upcoming = [...allDates].filter((d) => d > today).sort();
      focus = upcoming[0] || null;
    }
    const dTasks = focus
      ? (byDate.get(focus) || [])
        .slice()
        .sort((a, b) => (a.position - b.position) || (a.id - b.id))
      : [];
    return { focusDate: focus, isToday: isT, dayRow: focus ? rowByDate.get(focus) || null : null, dayTasks: dTasks };
  }, [tasks, dayRows, today]);

  const label = dayRow?.day_label || (focusDate ? weekdayLabel(focusDate) : '');
  const theme = dayRow?.day_theme || dayTasks[0]?.day_theme || '';

  const total = dayTasks.length;
  const done = dayTasks.filter((t) => t.status === 'done').length;
  const skipped = dayTasks.filter((t) => t.status === 'skipped').length;
  const remainingMin = dayTasks
    .filter((t) => t.status === 'pending')
    .reduce((s, t) => s + (Number(t.est_minutes) || 0), 0);
  const allDone = total > 0 && done + skipped === total;

  const testDate = meta.test_date || null;
  const daysToTest = testDate && /^\d{4}-\d{2}-\d{2}$/.test(testDate) ? daysBetween(today, testDate) : null;

  // ─── Write-through mutations (optimistic, fall back to server truth) ────────
  async function patchTask(id, patch, optimistic) {
    setError(null);
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...optimistic } : t)));
    try {
      const data = await fetchJson(`/api/study-plan/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (data.task) setTasks((prev) => prev.map((t) => (t.id === id ? data.task : t)));
    } catch (e) {
      setError(e.message);
      refresh();
    }
  }

  function toggleTask(task) {
    const next = task.status === 'done' ? 'pending' : 'done';
    patchTask(
      task.id,
      { status: next },
      { status: next, completed_at: next === 'done' ? new Date().toISOString() : null },
    );
  }

  function skipTask(task) {
    const next = task.status === 'skipped' ? 'pending' : 'skipped';
    patchTask(task.id, { status: next }, { status: next });
  }

  function saveTaskEdit(id, patch) {
    patchTask(id, patch, patch);
  }

  function saveNotes(id, notes) {
    patchTask(id, { notes: notes || null }, { notes: notes || null });
  }

  async function deleteTask(id) {
    const prev = tasks;
    setError(null);
    setTasks((p) => p.filter((t) => t.id !== id));
    try {
      await fetchJson(`/api/study-plan/tasks/${id}`, { method: 'DELETE' });
    } catch (e) {
      setError(e.message);
      setTasks(prev);
    }
  }

  async function addTask(title) {
    const t = String(title || '').trim();
    if (!t || !focusDate) return;
    setError(null);
    try {
      const data = await fetchJson('/api/study-plan/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          day_date: focusDate,
          week_number: dayRow?.week_number ?? dayTasks[0]?.week_number ?? 1,
          day_label: label,
          day_theme: theme,
          title: t,
        }),
      });
      if (data.task) setTasks((prev) => [...prev, data.task]);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <section id="today" className="page-section today-plan">
      <div className="section-header">
        <h2>Today’s Plan</h2>
        <div className="section-header-actions">
          <a className="today-fulllink" href="#study-plan">
            Full plan <ArrowRight size={13} aria-hidden="true" />
          </a>
          <button
            type="button"
            className="collapse-toggle"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label="Toggle Today’s Plan section"
          >
            {collapsed ? '+' : '−'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="today-body">
          {loading && <TodaySkeleton />}

          {!loading && error && (
            <div className="status error" role="alert">{error}</div>
          )}

          {!loading && !error && !focusDate && (
            <div className="today-empty">
              <p className="today-empty-msg">No upcoming days in your plan.</p>
              <Button size="sm" asChild>
                <a href="#study-plan">Open the study plan</a>
              </Button>
            </div>
          )}

          {!loading && !error && focusDate && (
            <>
              <div className="today-head">
                <div className="today-head-main">
                  <div className="today-daterow">
                    <span className={`today-daychip${isToday ? ' is-today' : ''}`}>
                      {isToday ? 'Today' : 'Next up'}
                    </span>
                    <span className="today-datelabel">
                      {label ? `${label} · ` : ''}{prettyDate(focusDate)}
                    </span>
                  </div>
                  {theme && <p className="today-theme">{theme}</p>}
                </div>
                {daysToTest != null && (
                  <div className="today-countdown" title={`Test date ${testDate}`}>
                    <span className="today-countdown-num">{daysToTest < 0 ? '—' : daysToTest}</span>
                    <span className="sp-stat-label">{daysToTest === 1 ? 'day to test' : 'days to test'}</span>
                  </div>
                )}
              </div>

              {total > 0 && (
                <div className="today-progress">
                  <div className="today-progress-meta">
                    <span className="today-progress-count">
                      {done}/{total} done{skipped ? ` · ${skipped} skipped` : ''}
                    </span>
                    {remainingMin > 0 && (
                      <span className="today-progress-time">{formatMinutes(remainingMin)} left</span>
                    )}
                  </div>
                  <ProgressRing value={done} total={total} size={40} />
                </div>
              )}

              {allDone && (
                <p className="today-clear">All done for today — nice work.</p>
              )}

              {total === 0 ? (
                <p className="today-notasks">No tasks scheduled for this day yet.</p>
              ) : (
                <ul className="today-tasks">
                  {dayTasks.map((task) => (
                    <TodayTaskRow
                      key={task.id}
                      task={task}
                      onToggle={toggleTask}
                      onSkip={skipTask}
                      onSave={saveTaskEdit}
                      onSaveNotes={saveNotes}
                      onDelete={deleteTask}
                    />
                  ))}
                </ul>
              )}

              <AddTaskInline onAdd={addTask} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function TodayTaskRow({ task, onToggle, onSkip, onSave, onSaveNotes, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [minutesDraft, setMinutesDraft] = useState(task.est_minutes || '');
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState(task.notes || '');
  const [notesDirty, setNotesDirty] = useState(false);

  useEffect(() => { setTitleDraft(task.title); }, [task.title]);
  useEffect(() => { setMinutesDraft(task.est_minutes || ''); }, [task.est_minutes]);
  useEffect(() => { setNotesDraft(task.notes || ''); setNotesDirty(false); }, [task.notes]);

  const isDone = task.status === 'done';
  const isSkipped = task.status === 'skipped';

  function saveEdit() {
    const title = titleDraft.trim();
    if (!title) return;
    const m = String(minutesDraft).trim();
    onSave(task.id, { title, est_minutes: m === '' ? null : Number(m) });
    setEditing(false);
  }

  function cancelEdit() {
    setTitleDraft(task.title);
    setMinutesDraft(task.est_minutes || '');
    setEditing(false);
  }

  if (editing) {
    return (
      <li className="today-task today-task-editing">
        <div className="today-edit">
          <input
            type="text"
            value={titleDraft}
            autoFocus
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }}
            className="sp-input sp-input-full"
            aria-label="Task title"
          />
          <div className="today-edit-row">
            <label className="today-edit-mins">
              <span className="sp-stat-label">Minutes</span>
              <input
                type="number"
                min="0"
                value={minutesDraft}
                onChange={(e) => setMinutesDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }}
                className="sp-input"
                style={{ width: 84 }}
              />
            </label>
            <div className="today-edit-actions">
              <Button size="sm" onClick={saveEdit}>Save</Button>
              <Button size="sm" variant="ghost" onClick={cancelEdit}>Cancel</Button>
            </div>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className={`today-task${isDone ? ' is-done' : ''}${isSkipped ? ' is-skipped' : ''}`}>
      <input
        type="checkbox"
        className="sp-check"
        checked={isDone}
        onChange={() => onToggle(task)}
        aria-label={`Mark “${task.title}” as ${isDone ? 'not done' : 'done'}`}
      />
      <div className="today-task-main">
        <div className="today-task-title">
          <span className="today-task-text">{task.title}</span>
          {task.est_minutes ? <span className="today-task-mins">{formatMinutes(task.est_minutes)}</span> : null}
          {isSkipped && <span className="today-task-flag">skipped</span>}
        </div>
        {task.description && <p className="today-task-desc">{task.description}</p>}
        {notesOpen && (
          <div className="today-notes">
            <textarea
              value={notesDraft}
              onChange={(e) => { setNotesDraft(e.target.value); setNotesDirty(true); }}
              placeholder="Notes — what went well, what to fix…"
              rows={3}
              className="sp-input sp-input-full today-notes-field"
            />
            <div className="today-notes-actions">
              <Button
                size="sm"
                disabled={!notesDirty}
                onClick={() => { onSaveNotes(task.id, notesDraft); setNotesDirty(false); }}
              >
                Save notes
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { setNotesDraft(task.notes || ''); setNotesDirty(false); setNotesOpen(false); }}
              >
                Close
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="today-task-actions">
        <IconBtn title={task.notes ? 'View notes' : 'Add notes'} active={!!task.notes} onClick={() => setNotesOpen((o) => !o)}>
          <StickyNote size={14} aria-hidden="true" />
        </IconBtn>
        <IconBtn title="Edit task" onClick={() => setEditing(true)}>
          <Pencil size={14} aria-hidden="true" />
        </IconBtn>
        <IconBtn title={isSkipped ? 'Un-skip' : 'Skip'} onClick={() => onSkip(task)}>
          {isSkipped ? <RotateCcw size={14} aria-hidden="true" /> : <Ban size={14} aria-hidden="true" />}
        </IconBtn>
        <IconBtn title="Delete task" onClick={() => onDelete(task.id)}>
          <Trash2 size={14} aria-hidden="true" />
        </IconBtn>
      </div>
    </li>
  );
}

function AddTaskInline({ onAdd }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  function submit() {
    const v = draft.trim();
    if (!v) return;
    onAdd(v);
    setDraft('');
    setAdding(false);
  }

  if (!adding) {
    return (
      <button type="button" className="today-addtask" onClick={() => setAdding(true)}>
        <Plus size={14} aria-hidden="true" /> Add task
      </button>
    );
  }
  return (
    <div className="today-addtask-row">
      <input
        type="text"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') { setAdding(false); setDraft(''); }
        }}
        placeholder="New task…"
        className="sp-input sp-input-full"
        aria-label="New task title"
      />
      <Button size="sm" onClick={submit}>Add</Button>
      <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setDraft(''); }}>Cancel</Button>
    </div>
  );
}

function IconBtn({ children, title, onClick, active }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className={`sp-iconbtn${active ? ' is-active' : ''}`}>
      {children}
    </button>
  );
}

function TodaySkeleton() {
  return (
    <div className="today-skeleton" aria-hidden="true">
      <div className="today-skel-head" />
      <div className="today-skel-row" />
      <div className="today-skel-row" />
      <div className="today-skel-row" />
    </div>
  );
}
