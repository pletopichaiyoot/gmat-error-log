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
import { GripVertical } from 'lucide-react';
import { computeReorder, dayDroppableId } from './studyPlanReorder.mjs';

function fetchJson(url, opts) {
  return fetch(url, opts).then(async (r) => {
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`HTTP ${r.status}: ${text}`);
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
  // Both are 'YYYY-MM-DD'. Returns integer days from A to B (positive if B > A).
  const a = new Date(`${dateStrA}T00:00:00`);
  const b = new Date(`${dateStrB}T00:00:00`);
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

function todayLocalISODate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function groupByDay(tasks) {
  const map = new Map();
  for (const t of tasks) {
    if (!map.has(t.day_date)) {
      map.set(t.day_date, {
        date: t.day_date,
        week: t.week_number,
        label: t.day_label,
        theme: t.day_theme,
        tasks: [],
      });
    }
    map.get(t.day_date).tasks.push(t);
  }
  // Each day's tasks come pre-sorted by position from the server.
  return Array.from(map.values());
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

export default function StudyPlan({ onExit }) {
  const [tasks, setTasks] = useState([]);
  const [meta, setMeta] = useState({});
  const [manualMocks, setManualMocks] = useState([]);
  const [scrapedMocks, setScrapedMocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingMetaTestDate, setEditingMetaTestDate] = useState(false);
  const [testDateDraft, setTestDateDraft] = useState('');
  const [activeId, setActiveId] = useState(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const reorderInFlight = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [plan, mocksData] = await Promise.all([
        fetchJson('/api/study-plan'),
        fetchJson('/api/mocks'),
      ]);
      setTasks(plan.tasks || []);
      setMeta(plan.meta || {});
      setManualMocks((mocksData.mocks || []).map((m) => ({ ...m, source_type: 'manual' })));
      setScrapedMocks(mocksData.mocks_scraped || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ─── Mutations ──────────────────────────────────────────────────────────

  async function toggleStatus(task) {
    const nextStatus = task.status === 'done' ? 'pending' : 'done';
    // Optimistic update.
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
    } catch (e) {
      setError(e.message);
      refresh();
    }
  }

  async function markSkipped(task) {
    const nextStatus = task.status === 'skipped' ? 'pending' : 'skipped';
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: nextStatus } : t)));
    try {
      await fetchJson(`/api/study-plan/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
    } catch (e) {
      setError(e.message);
      refresh();
    }
  }

  async function updateTask(id, patch) {
    try {
      const data = await fetchJson(`/api/study-plan/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      setTasks((prev) => prev.map((t) => (t.id === id ? data.task : t)));
    } catch (e) {
      setError(e.message);
    }
  }

  async function deleteTask(id) {
    if (!window.confirm('Delete this task?')) return;
    try {
      await fetchJson(`/api/study-plan/tasks/${id}`, { method: 'DELETE' });
      setTasks((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setError(e.message);
    }
  }

  async function addTask(day, title) {
    const t = String(title || '').trim();
    if (!t) return;
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
    } catch (e) {
      setError(e.message);
    }
  }

  async function addMock(payload) {
    try {
      const data = await fetchJson('/api/mocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setManualMocks((prev) => [...prev, { ...data.mock, source_type: 'manual' }]);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
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
    } catch (e) {
      setError(e.message);
      return false;
    }
  }

  async function deleteMock(id) {
    if (!window.confirm('Delete this mock result?')) return;
    try {
      await fetchJson(`/api/mocks/${id}`, { method: 'DELETE' });
      setManualMocks((prev) => prev.filter((m) => m.id !== id));
    } catch (e) {
      setError(e.message);
    }
  }

  async function resetPlan() {
    const doneCount = tasks.filter((t) => t.status === 'done').length;
    const notesCount = tasks.filter((t) => t.notes && t.notes.trim()).length;
    let confirmMsg = 'Reset plan to the default 4-week seed?\n\nThis wipes ALL tasks and re-creates them from scratch.';
    if (doneCount > 0 || notesCount > 0) {
      confirmMsg += `\n\nWARNING: You will lose ${doneCount} checked-off task${doneCount === 1 ? '' : 's'}`;
      if (notesCount > 0) confirmMsg += ` and ${notesCount} task${notesCount === 1 ? '' : 's'} with notes`;
      confirmMsg += '.';
    }
    if (!window.confirm(confirmMsg)) return;
    try {
      const data = await fetchJson('/api/study-plan/reset', { method: 'POST' });
      setTasks(data.tasks || []);
      setMeta(data.meta || {});
    } catch (e) {
      setError(e.message);
    }
  }

  async function saveTestDate() {
    const v = (testDateDraft || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      setError('Test date must be YYYY-MM-DD');
      return;
    }
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
    }
  }

  async function reorderTasks(activeTaskId, overId) {
    if (reorderInFlight.current) return;
    const dayMeta = {};
    for (const d of days) {
      dayMeta[d.date] = { week_number: d.week, day_label: d.label, day_theme: d.theme };
    }
    const result = computeReorder(tasks, activeTaskId, overId, dayMeta);
    if (!result) return;
    const prevTasks = tasks;
    reorderInFlight.current = true;
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
    } finally {
      reorderInFlight.current = false;
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

  function handleDragCancel() {
    setActiveId(null);
  }

  // ─── Derived ────────────────────────────────────────────────────────────

  const overall = useMemo(() => progressFor(tasks), [tasks]);
  const days = useMemo(() => groupByDay(tasks), [tasks]);
  const weeks = useMemo(() => groupByWeek(days), [days]);
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

  // ─── Render ─────────────────────────────────────────────────────────────

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
          <Button variant="ghost" size="sm" type="button" onClick={resetPlan} title="Wipe ALL tasks (including progress) and reload from the latest seed in db.js">
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
              <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.7 }}>Test date</div>
              {editingMetaTestDate ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                  <input
                    type="date"
                    value={testDateDraft}
                    onChange={(e) => setTestDateDraft(e.target.value)}
                    style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(0,0,0,0.2)' }}
                  />
                  <Button size="sm" onClick={saveTestDate}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingMetaTestDate(false)}>Cancel</Button>
                </div>
              ) : (
                <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>
                  {testDate || '—'}{' '}
                  <button
                    type="button"
                    onClick={() => { setTestDateDraft(testDate || ''); setEditingMetaTestDate(true); }}
                    style={{ marginLeft: 8, fontSize: 12, background: 'transparent', border: 'none', color: '#6366f1', cursor: 'pointer' }}
                  >
                    edit
                  </button>
                </div>
              )}
            </div>
            <div>
              <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.7 }}>Days to test</div>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>
                {daysToTest == null ? '—' : daysToTest < 0 ? 'past' : `${daysToTest} d`}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.7 }}>Overall progress</div>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>
                {overall.done}/{overall.total} · {overall.pct}%
              </div>
            </div>
          </div>
          <ProgressBar pct={overall.pct} width={260} />
        </div>
      </section>

      <MockResultsPanel
        mocks={mocks}
        onAdd={addMock}
        onUpdate={updateMock}
        onDelete={deleteMock}
      />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
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
    if (delta === 0) return { label: '=', color: 'rgba(0,0,0,0.5)' };
    if (delta > 0) return { label: `▲ ${delta}`, color: '#10b981' };
    return { label: `▼ ${Math.abs(delta)}`, color: '#ef4444' };
  }

  return (
    <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <header style={{ padding: '16px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(99,102,241,0.04)' }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase', opacity: 0.7 }}>
            {mocks.length} mock{mocks.length === 1 ? '' : 's'} recorded
            {scrapedCount > 0 && (
              <span style={{ marginLeft: 8, opacity: 0.85 }}>
                · {scrapedCount} scraped, {manualCount} manual
              </span>
            )}
          </div>
          <h2 style={{ margin: '4px 0 0 0', fontSize: 18, fontWeight: 700 }}>Mock Results</h2>
        </div>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>+ Add mock</Button>
        )}
      </header>

      {mocks.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'rgba(0,0,0,0.02)', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.7 }}>
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
                const tTotal = trend(m, prev, 'total_score');
                const tQ = trend(m, prev, 'quant_score');
                const tDI = trend(m, prev, 'di_score');
                const tV = trend(m, prev, 'verbal_score');
                return (
                  <tr key={m.id} style={{ borderTop: '1px solid rgba(0,0,0,0.05)' }}>
                    <td style={{ padding: '10px 24px', whiteSpace: 'nowrap' }}>{m.mock_date}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>{m.source_label}</span>
                        <SourceTypeChip type={m.source_type} />
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <ScoreCell score={m.total_score} pct={m.total_percentile} trend={tTotal} />
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <ScoreCell score={m.quant_score} pct={m.quant_percentile} trend={tQ} />
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <ScoreCell score={m.di_score} pct={m.di_percentile} trend={tDI} />
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <ScoreCell score={m.verbal_score} pct={m.verbal_percentile} trend={tV} />
                    </td>
                    <td style={{ padding: '10px 24px', textAlign: 'right' }}>
                      {isScraped ? (
                        <span style={{ fontSize: 11, opacity: 0.4 }} title="Scraped from GMAT Official Practice — edit via the dashboard scrape flow">
                          read-only
                        </span>
                      ) : (
                        <>
                          <IconButton title="Edit" onClick={() => setEditingId(m.id)}>✏️</IconButton>
                          <IconButton title="Delete" onClick={() => onDelete(m.id)}>🗑</IconButton>
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
        <MockRowEditor
          mock={null}
          onCancel={() => setAdding(false)}
          onSave={async (payload) => { if (await onAdd(payload)) setAdding(false); }}
        />
      )}

      {latest && (
        <div style={{ padding: '12px 24px', borderTop: '1px solid rgba(0,0,0,0.05)', fontSize: 12, opacity: 0.7 }}>
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
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        padding: '2px 6px',
        borderRadius: 999,
        border: '1px solid',
        borderColor: isScraped ? 'rgba(16,185,129,0.35)' : 'rgba(99,102,241,0.35)',
        color: isScraped ? '#047857' : '#4f46e5',
        background: isScraped ? 'rgba(16,185,129,0.08)' : 'rgba(99,102,241,0.08)',
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
      <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>{score ?? '—'}</span>
        {trend && (
          <span style={{ fontSize: 10, color: trend.color, fontWeight: 700 }}>{trend.label}</span>
        )}
      </div>
      {pct != null && <div style={{ fontSize: 10, opacity: 0.55 }}>{pct}th %ile</div>}
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
  const inputStyle = { padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(0,0,0,0.2)', fontSize: 13, width: '100%' };
  const Cell = ({ children }) => <td style={{ padding: '8px 12px' }}>{children}</td>;
  return (
    <tr style={{ borderTop: '1px solid rgba(0,0,0,0.05)', background: 'rgba(99,102,241,0.05)' }}>
      <td colSpan={7} style={{ padding: '12px 24px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 10 }}>
          <Field label="Date">
            <input type="date" value={draft.mock_date} onChange={(e) => set('mock_date', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Source">
            <input type="text" placeholder="e.g. OPE4" value={draft.source_label} onChange={(e) => set('source_label', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Total score">
            <input type="number" min="205" max="805" step="10" value={draft.total_score} onChange={(e) => set('total_score', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Total %ile">
            <input type="number" min="0" max="100" value={draft.total_percentile} onChange={(e) => set('total_percentile', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Quant">
            <input type="number" min="60" max="90" value={draft.quant_score} onChange={(e) => set('quant_score', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Quant %ile">
            <input type="number" min="0" max="100" value={draft.quant_percentile} onChange={(e) => set('quant_percentile', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="DI">
            <input type="number" min="60" max="90" value={draft.di_score} onChange={(e) => set('di_score', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="DI %ile">
            <input type="number" min="0" max="100" value={draft.di_percentile} onChange={(e) => set('di_percentile', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Verbal">
            <input type="number" min="60" max="90" value={draft.verbal_score} onChange={(e) => set('verbal_score', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Verbal %ile">
            <input type="number" min="0" max="100" value={draft.verbal_percentile} onChange={(e) => set('verbal_percentile', e.target.value)} style={inputStyle} />
          </Field>
        </div>
        <textarea placeholder="Notes (optional)..." value={draft.notes} onChange={(e) => set('notes', e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
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
      <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.7 }}>{label}</span>
      {children}
    </label>
  );
}

function ProgressBar({ pct, width = 200 }) {
  return (
    <div
      style={{
        width,
        height: 10,
        borderRadius: 999,
        background: 'rgba(99,102,241,0.12)',
        overflow: 'hidden',
      }}
      title={`${pct}% complete`}
    >
      <div
        style={{
          width: `${Math.max(0, Math.min(100, pct))}%`,
          height: '100%',
          background: 'linear-gradient(90deg, #6366f1, #8b5cf6)',
          transition: 'width 0.25s ease',
        }}
      />
    </div>
  );
}

function WeekSection({ week, days, today, onToggle, onSkip, onUpdate, onDelete, onAdd }) {
  const allTasks = days.flatMap((d) => d.tasks);
  const prog = progressFor(allTasks);
  const totalMinutes = allTasks.reduce((s, t) => s + (Number(t.est_minutes) || 0), 0);
  const doneMinutes = allTasks
    .filter((t) => t.status === 'done')
    .reduce((s, t) => s + (Number(t.est_minutes) || 0), 0);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <header
        style={{
          padding: '16px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          background: 'rgba(99,102,241,0.04)',
          cursor: 'pointer',
        }}
        onClick={() => setCollapsed((c) => !c)}
      >
        <div>
          <div style={{ fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase', opacity: 0.7 }}>
            {collapsed ? '▶' : '▼'} {prog.done}/{prog.total} tasks · {formatMinutes(doneMinutes)}/{formatMinutes(totalMinutes)}
          </div>
          <h2 style={{ margin: '4px 0 0 0', fontSize: 18, fontWeight: 700 }}>
            {WEEK_LABELS[week] || `Week ${week}`}
          </h2>
        </div>
        <ProgressBar pct={prog.pct} width={200} />
      </header>
      {!collapsed && (
        <div style={{ padding: '8px 0' }}>
          {days.map((day) => (
            <DayCard
              key={day.date}
              day={day}
              isToday={day.date === today}
              isPast={day.date < today}
              onToggle={onToggle}
              onSkip={onSkip}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onAdd={onAdd}
            />
          ))}
        </div>
      )}
    </section>
  );
}

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
    const patch = {
      title: titleDraft,
      description: descDraft || null,
      est_minutes: m === '' ? null : Number(m),
    };
    onUpdate(task.id, patch);
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
        <input
          type="text"
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(0,0,0,0.2)', fontSize: 13 }}
        />
        <textarea
          value={descDraft}
          onChange={(e) => setDescDraft(e.target.value)}
          placeholder="Description (optional)"
          rows={2}
          style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(0,0,0,0.2)', fontSize: 13, resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12 }}>Minutes:</label>
          <input
            type="number"
            min="0"
            value={minutesDraft}
            onChange={(e) => setMinutesDraft(e.target.value)}
            style={{ width: 80, padding: '4px 6px', borderRadius: 6, border: '1px solid rgba(0,0,0,0.2)', fontSize: 13 }}
          />
          <Button size="sm" onClick={saveEdit}>Save</Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '6px 0',
        alignItems: 'flex-start',
        opacity: isSkipped ? 0.5 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={isDone}
        onChange={() => onToggle(task)}
        style={{ marginTop: 4, width: 16, height: 16, cursor: 'pointer', accentColor: '#6366f1' }}
        aria-label={`Mark "${task.title}" as ${isDone ? 'pending' : 'done'}`}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            textDecoration: isDone || isSkipped ? 'line-through' : 'none',
            color: isDone ? 'rgba(0,0,0,0.5)' : 'inherit',
          }}
        >
          {task.title}
          {task.est_minutes ? (
            <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.6, fontWeight: 400 }}>
              {formatMinutes(task.est_minutes)}
            </span>
          ) : null}
        </div>
        {task.description && (
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{task.description}</div>
        )}
        {notesOpen && (
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <textarea
              value={notesDraft}
              onChange={(e) => { setNotesDraft(e.target.value); setNotesDirty(true); }}
              placeholder="Personal notes (what went well, what to fix)..."
              rows={3}
              style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(0,0,0,0.15)', fontSize: 12, resize: 'vertical', background: 'rgba(99,102,241,0.04)' }}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <Button size="sm" disabled={!notesDirty} onClick={saveNotes}>Save notes</Button>
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
      <div style={{ display: 'flex', gap: 4, opacity: 0.7 }}>
        <IconButton
          title={task.notes ? 'View notes' : 'Add notes'}
          onClick={() => setNotesOpen((o) => !o)}
          active={!!task.notes}
        >
          📝
        </IconButton>
        <IconButton title="Edit" onClick={() => setEditing(true)}>✏️</IconButton>
        <IconButton title={isSkipped ? 'Un-skip' : 'Skip'} onClick={() => onSkip(task)}>
          {isSkipped ? '↺' : '⊘'}
        </IconButton>
        <IconButton title="Delete" onClick={() => onDelete(task.id)}>🗑</IconButton>
      </div>
    </div>
  );
}

function IconButton({ children, title, onClick, active }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        background: active ? 'rgba(99,102,241,0.15)' : 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        padding: '2px 6px',
        borderRadius: 4,
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}
