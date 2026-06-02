import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';

function fetchJson(url, opts) {
  return fetch(url, opts).then(async (r) => {
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`HTTP ${r.status}: ${text}`);
    }
    return r.json();
  });
}

const KIND_FULL = { RC: 'Reading Comprehension', LR: 'Logical Reasoning' };
const CONFIDENCE_LEVELS = ['low', 'medium', 'high'];
// GMAT Focus Edition Verbal pace: 23 questions / 45 minutes = 1m 57s per question.
const PER_QUESTION_TARGET_MS = 117 * 1000; // 1m 57s
const sectionBudgetMs = (questionCount) => questionCount * PER_QUESTION_TARGET_MS;
function formatBudgetMs(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function formatRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  const ms = Date.now() - d.getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

// A "set" of practice = the entire section. RC sections still contain multiple
// passages; the SessionView swaps the displayed passage based on the current
// question's passageIdx.
function buildSetForSection(section, questionNumbers) {
  if (!section || !section.questions?.length) return null;
  let questions = section.questions;
  const isSubset = Array.isArray(questionNumbers) && questionNumbers.length > 0;
  if (isSubset) {
    const want = new Set(questionNumbers);
    questions = section.questions.filter((q) => want.has(q.number));
    if (!questions.length) return null;
  }
  return {
    key: isSubset ? `${section.roman}:sub:${[...questionNumbers].sort((a, b) => a - b).join(',')}` : `${section.roman}:all`,
    label: `${section.kind} · Section ${section.roman}`,
    firstQuestion: questions[0].number,
    lastQuestion: questions[questions.length - 1].number,
    questions,
    questionNumbers: isSubset ? questions.map((q) => q.number) : null,
  };
}

// ============== LIBRARY PICKER ==============
// Flat list of every section across every preptest. Treat each section as one
// practice set; PrepTest # is shown as metadata only.
function LsatLibrary({ onPickSection, onExit, onTabChange }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [kindFilter, setKindFilter] = useState('all'); // all | RC | LR
  const [statusFilter, setStatusFilter] = useState('all'); // all | new | progress | done
  const [sortBy, setSortBy] = useState('test'); // test | recent | accuracy

  useEffect(() => {
    setLoading(true);
    fetchJson('/api/lsat/library')
      .then((data) => { setRows(data.sections || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let out = rows.slice();
    if (kindFilter !== 'all') out = out.filter(r => r.kind === kindFilter);
    if (statusFilter === 'new') out = out.filter(r => r.attempted === 0);
    else if (statusFilter === 'progress') out = out.filter(r => r.attempted > 0 && r.attempted < r.questionCount);
    else if (statusFilter === 'done') out = out.filter(r => r.attempted >= r.questionCount && r.questionCount > 0);
    if (sortBy === 'test') {
      out.sort((a, b) => a.testNum - b.testNum || a.sectionRoman.localeCompare(b.sectionRoman));
    } else if (sortBy === 'recent') {
      out.sort((a, b) => (b.lastAttemptedAt || '').localeCompare(a.lastAttemptedAt || ''));
    } else if (sortBy === 'accuracy') {
      const acc = (r) => r.attempted ? r.correct / r.attempted : -1;
      out.sort((a, b) => acc(b) - acc(a));
    }
    return out;
  }, [rows, kindFilter, statusFilter, sortBy]);

  const counts = useMemo(() => {
    const c = { all: rows.length, RC: 0, LR: 0, new: 0, progress: 0, done: 0 };
    for (const r of rows) {
      if (r.kind === 'RC') c.RC++;
      if (r.kind === 'LR') c.LR++;
      if (r.attempted === 0) c.new++;
      else if (r.attempted < r.questionCount) c.progress++;
      else c.done++;
    }
    return c;
  }, [rows]);

  return (
    <div className="lsat-st-shell">
      <LsatTopNav activeTab="library" onTabChange={onTabChange} onExit={onExit} />

      <main className="lsat-lib">
        <div className="lsat-lib-head">
          <h2 className="lsat-lib-title">Pick a section to practice</h2>
          <p className="lsat-lib-sub">
            Each section is one timed set. Per-question time is recorded so you can review pace later.
          </p>
        </div>

        <div className="lsat-lib-controls">
          <div className="lsat-lib-tabs" role="tablist" aria-label="Filter by section type">
            <button
              type="button"
              role="tab"
              className={`lsat-lib-tab ${kindFilter === 'all' ? 'is-active' : ''}`}
              aria-selected={kindFilter === 'all'}
              onClick={() => setKindFilter('all')}
            >
              All <span className="lsat-lib-count">{counts.all}</span>
            </button>
            <button
              type="button"
              role="tab"
              className={`lsat-lib-tab ${kindFilter === 'RC' ? 'is-active' : ''}`}
              aria-selected={kindFilter === 'RC'}
              onClick={() => setKindFilter('RC')}
            >
              Reading Comp <span className="lsat-lib-count">{counts.RC}</span>
            </button>
            <button
              type="button"
              role="tab"
              className={`lsat-lib-tab ${kindFilter === 'LR' ? 'is-active' : ''}`}
              aria-selected={kindFilter === 'LR'}
              onClick={() => setKindFilter('LR')}
            >
              Logical Reasoning <span className="lsat-lib-count">{counts.LR}</span>
            </button>
          </div>
          <div className="lsat-lib-filters">
            <div className="lsat-lib-chip-group" role="group" aria-label="Filter by progress">
              {[
                { key: 'all', label: 'Any' },
                { key: 'new', label: `New (${counts.new})` },
                { key: 'progress', label: `In progress (${counts.progress})` },
                { key: 'done', label: `Done (${counts.done})` },
              ].map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  className={`lsat-lib-chip ${statusFilter === opt.key ? 'is-active' : ''}`}
                  onClick={() => setStatusFilter(opt.key)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <select
              className="lsat-st-select"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              aria-label="Sort"
              style={{ background: '#fff', color: 'var(--st-text)', border: '1px solid var(--st-pill-border)' }}
            >
              <option value="test">Sort: PrepTest order</option>
              <option value="recent">Sort: Recently practiced</option>
              <option value="accuracy">Sort: Highest accuracy</option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="lsat-st-picker-loading">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="lsat-st-empty">No sections match these filters.</div>
        ) : (
          <ul className="lsat-lib-list">
            {filtered.map((r) => {
              const accuracy = r.attempted > 0 ? Math.round((r.correct / r.attempted) * 100) : null;
              const pctDone = r.questionCount > 0 ? Math.round((r.attempted / r.questionCount) * 100) : 0;
              const status = r.attempted === 0 ? 'new' : (r.attempted >= r.questionCount ? 'done' : 'progress');
              return (
                <li key={`${r.testNum}:${r.sectionRoman}`} className="lsat-lib-card">
                  <button type="button" className="lsat-lib-card-btn" onClick={() => onPickSection(r.testNum, r.sectionRoman)}>
                    <div className={`lsat-lib-kind-badge lsat-lib-kind-${r.kind}`}>{r.kind}</div>
                    <div className="lsat-lib-card-main">
                      <div className="lsat-lib-card-title">
                        {KIND_FULL[r.kind] || r.kind}
                        <span className={`lsat-lib-status-dot lsat-lib-status-${status}`} aria-hidden="true" />
                      </div>
                      <div className="lsat-lib-card-meta">
                        <span className="lsat-lib-card-pt">PrepTest {r.testNum}</span>
                        <span className="lsat-lib-card-dot">·</span>
                        <span>Section {r.sectionRoman}</span>
                        <span className="lsat-lib-card-dot">·</span>
                        <span>{r.questionCount} questions{r.kind === 'RC' && r.passageCount ? ` · ${r.passageCount} passages` : ''}</span>
                      </div>
                      <div className="lsat-lib-progress" aria-hidden="true">
                        <div className="lsat-lib-progress-bar" style={{ width: `${pctDone}%` }} />
                      </div>
                      <div className="lsat-lib-card-stats">
                        {r.attempted > 0 ? (
                          <>
                            <span className="lsat-lib-card-stat"><strong>{r.correct}/{r.attempted}</strong> correct{accuracy != null && <> · <strong>{accuracy}%</strong></>}</span>
                            {r.totalTimeMs > 0 && (
                              <span className="lsat-lib-card-stat lsat-lib-card-stat-muted">{formatMs(r.totalTimeMs)} total</span>
                            )}
                            <span className="lsat-lib-card-stat lsat-lib-card-stat-muted">{r.attempted}/{r.questionCount} attempted</span>
                            {r.lastAttemptedAt && (
                              <span className="lsat-lib-card-stat lsat-lib-card-stat-muted">{formatRelative(r.lastAttemptedAt)}</span>
                            )}
                          </>
                        ) : (
                          <span className="lsat-lib-card-stat lsat-lib-card-stat-muted">Not started</span>
                        )}
                      </div>
                    </div>
                    <div className="lsat-lib-cta">
                      {status === 'progress' ? 'Continue' : status === 'done' ? 'Retake' : 'Start'}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="9 18 15 12 9 6"/>
                      </svg>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}

// ============== SHARED TOP-NAV ==============
function LsatTopNav({ activeTab, onTabChange, onExit }) {
  return (
    <header className="lsat-st-topbar">
      <div className="lsat-st-topbar-left">
        <button type="button" className="lsat-st-icon-btn" onClick={onExit} aria-label="Exit to GMAT Dashboard" title="Exit">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <span className="lsat-st-section-label">LSAT Practice</span>
      </div>
      <nav className="lsat-st-topnav" aria-label="Main">
        <button type="button" className={`lsat-st-topnav-item ${activeTab === 'library' ? 'is-active' : ''}`} onClick={() => onTabChange('library')}>Library</button>
        <button type="button" className={`lsat-st-topnav-item ${activeTab === 'sessions' ? 'is-active' : ''}`} onClick={() => onTabChange('sessions')}>Sessions</button>
        <button type="button" className={`lsat-st-topnav-item ${activeTab === 'errors' ? 'is-active' : ''}`} onClick={() => onTabChange('errors')}>Error Log</button>
      </nav>
    </header>
  );
}

// ============== SESSIONS VIEW ==============
function LsatSessionsView({ onPickSection, onExit, onTabChange }) {
  const [sessions, setSessions] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetchJson('/api/lsat/sessions'),
      fetchJson('/api/lsat/attempts'),
    ]).then(([s, a]) => {
      setSessions(s.sessions || []);
      setAttempts(a.attempts || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  // Index attempts by session_id for stat computation.
  const attemptsBySession = useMemo(() => {
    const m = new Map();
    for (const a of attempts) {
      if (a.session_id == null) continue;
      if (!m.has(a.session_id)) m.set(a.session_id, []);
      m.get(a.session_id).push(a);
    }
    return m;
  }, [attempts]);

  return (
    <div className="lsat-st-shell">
      <LsatTopNav activeTab="sessions" onTabChange={onTabChange} onExit={onExit} />
      <main className="lsat-lib">
        <div className="lsat-lib-head">
          <h2 className="lsat-lib-title">Session history</h2>
          <p className="lsat-lib-sub">Every practice session you've started, newest first. Click one to retake the same set.</p>
        </div>
        {loading ? (
          <div className="lsat-st-picker-loading">Loading…</div>
        ) : sessions.length === 0 ? (
          <div className="lsat-st-empty">No sessions yet — start one from the Library.</div>
        ) : (
          <ul className="lsat-sess-list">
            {sessions.map((s) => {
              const sAttempts = attemptsBySession.get(s.id) || [];
              const done = sAttempts.length;
              const correct = sAttempts.filter(a => a.is_correct).length;
              const totalTimeMs = sAttempts.reduce((acc, a) => acc + (a.time_ms || 0), 0);
              const accuracy = done > 0 ? Math.round((correct / done) * 100) : null;
              const total = Array.isArray(s.question_numbers) && s.question_numbers.length
                ? s.question_numbers.length
                : (s.last_question - s.first_question + 1);
              return (
                <li key={s.id} className="lsat-sess-row">
                  <button type="button" className="lsat-sess-btn" onClick={() => onPickSection(s.test_num, s.section_roman, s.question_numbers || null)}>
                    <div className={`lsat-lib-kind-badge lsat-lib-kind-${s.section_kind}`}>{s.section_kind}</div>
                    <div className="lsat-sess-main">
                      <div className="lsat-sess-title">
                        PrepTest {s.test_num} · Section {s.section_roman}
                        <span className={`lsat-sess-status ${s.completed_at ? 'is-done' : 'is-progress'}`}>
                          {s.completed_at ? 'Completed' : 'In progress'}
                        </span>
                      </div>
                      <div className="lsat-sess-meta">
                        <span>{formatRelative(s.started_at)}</span>
                        <span className="lsat-lib-card-dot">·</span>
                        <span>{done}/{total} answered{accuracy != null && <> · <strong>{accuracy}%</strong></>}</span>
                        {totalTimeMs > 0 && (
                          <>
                            <span className="lsat-lib-card-dot">·</span>
                            <span>{formatMs(totalTimeMs)}</span>
                          </>
                        )}
                        {s.mode && (
                          <>
                            <span className="lsat-lib-card-dot">·</span>
                            <span>{s.mode === 'exam' ? 'Exam mode' : s.mode}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <span className="lsat-sess-cta">
                      Retake
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="9 18 15 12 9 6"/>
                      </svg>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}

// ============== ERROR LOG VIEW ==============
function LsatErrorLogView({ onExit, onTabChange }) {
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    fetchJson('/api/lsat/errors')
      .then((data) => { setErrors(data.errors || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="lsat-st-shell">
      <LsatTopNav activeTab="errors" onTabChange={onTabChange} onExit={onExit} />
      <main className="lsat-lib">
        <div className="lsat-lib-head">
          <h2 className="lsat-lib-title">Error Log</h2>
          <p className="lsat-lib-sub">
            All questions you've answered incorrectly, newest first. Tap a row to expand the stem and see your pick vs. the correct answer.
          </p>
        </div>
        {loading ? (
          <div className="lsat-st-picker-loading">Loading…</div>
        ) : errors.length === 0 ? (
          <div className="lsat-st-empty">No errors yet — keep practicing!</div>
        ) : (
          <ul className="lsat-err-list">
            {errors.map((e) => {
              const isOpen = expanded === e.id;
              return (
                <li key={e.id} className={`lsat-err-row ${isOpen ? 'is-open' : ''}`}>
                  <button type="button" className="lsat-err-summary" onClick={() => setExpanded(isOpen ? null : e.id)} aria-expanded={isOpen}>
                    <div className={`lsat-lib-kind-badge lsat-lib-kind-${e.section_kind}`}>{e.section_kind}</div>
                    <div className="lsat-err-main">
                      <div className="lsat-err-title">
                        PrepTest {e.test_num} · Section {e.section_roman} · Q{e.question_number}
                        <span className="lsat-err-pick">
                          <span className="lsat-err-yours">{e.user_answer}</span>
                          <span className="lsat-err-arrow" aria-hidden="true">→</span>
                          <span className="lsat-err-correct">{e.correct_answer}</span>
                        </span>
                      </div>
                      <div className="lsat-err-meta">
                        <span>{formatRelative(e.attempted_at)}</span>
                        {e.time_ms != null && (
                          <>
                            <span className="lsat-lib-card-dot">·</span>
                            <span>{formatMs(e.time_ms)}</span>
                          </>
                        )}
                        {e.confidence && (
                          <>
                            <span className="lsat-lib-card-dot">·</span>
                            <span>Confidence: {e.confidence}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <svg className="lsat-err-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </button>
                  {isOpen && e.question && (
                    <div className="lsat-err-detail">
                      <div className="lsat-err-stem">{e.question.stem}</div>
                      <ul className="lsat-err-choices">
                        {e.question.choices.map((c) => {
                          let cls = 'lsat-err-choice';
                          if (c.label === e.correct_answer) cls += ' is-correct';
                          if (c.label === e.user_answer) cls += ' is-yours';
                          return (
                            <li key={c.label} className={cls}>
                              <span className="lsat-err-choice-label">{c.label}</span>
                              <span className="lsat-err-choice-text">{c.text}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}

// ============== CONFIRMATION (mode selector) ==============
function ConfirmationScreen({ testNum, sectionRoman, subset, onStart, onCancel }) {
  const [section, setSection] = useState(null);
  const [mode, setMode] = useState('exam');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [priorSessions, setPriorSessions] = useState([]);

  useEffect(() => {
    Promise.all([
      fetchJson(`/api/lsat/tests/${testNum}/sections/${sectionRoman}`),
      fetchJson(`/api/lsat/sessions?testNum=${testNum}&sectionRoman=${sectionRoman}`),
    ])
      .then(([secResp, sessResp]) => {
        setSection(secResp.section);
        setPriorSessions(sessResp.sessions || []);
        setLoading(false);
      })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [testNum, sectionRoman]);

  const totalQ = section?.questions.length || 0;
  const isSubset = Array.isArray(subset) && subset.length > 0;
  const displayCount = isSubset ? subset.length : totalQ;
  const passages = section?.passages?.length || 0;
  const priorCount = priorSessions.length;

  return (
    <div className="lsat-st-shell">
      <header className="lsat-st-topbar">
        <div className="lsat-st-topbar-left">
          <button type="button" className="lsat-st-icon-btn" onClick={onCancel} aria-label="Back to library" title="Back">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>
            </svg>
          </button>
          <span className="lsat-st-section-label">Confirm session</span>
        </div>
      </header>
      <main className="lsat-confirm">
        {loading && <div className="lsat-st-picker-loading">Loading…</div>}
        {error && <div className="lsat-st-empty">Error: {error}</div>}
        {section && (
          <>
            <div className="lsat-confirm-head">
              <div className={`lsat-lib-kind-badge lsat-lib-kind-${section.kind}`}>{section.kind}</div>
              <div>
                <h2 className="lsat-confirm-title">{KIND_FULL[section.kind] || section.kind}</h2>
                <div className="lsat-confirm-meta">
                  PrepTest {testNum} · Section {section.roman} · {displayCount} questions
                  {passages && !isSubset ? ` · ${passages} passages` : ''}
                  {isSubset ? ' · review subset' : ''}
                </div>
              </div>
            </div>

            <fieldset className="lsat-confirm-modes">
              <legend className="lsat-confirm-legend">Mode</legend>
              <label className={`lsat-confirm-mode ${mode === 'exam' ? 'is-selected' : ''}`}>
                <input
                  type="radio"
                  name="mode"
                  value="exam"
                  checked={mode === 'exam'}
                  onChange={() => setMode('exam')}
                />
                <div className="lsat-confirm-mode-body">
                  <div className="lsat-confirm-mode-title">Exam Mode</div>
                  <div className="lsat-confirm-mode-desc">
                    Answers lock in after submit. <strong>No correct/incorrect feedback shown</strong> until you finish the section.
                    Section timer counts down to 0, then keeps counting overtime in red.
                  </div>
                </div>
              </label>
              <label className="lsat-confirm-mode is-disabled" aria-disabled="true">
                <input type="radio" name="mode" value="practice" disabled />
                <div className="lsat-confirm-mode-body">
                  <div className="lsat-confirm-mode-title">
                    Practice Mode <span className="lsat-confirm-mode-tag">Coming soon</span>
                  </div>
                  <div className="lsat-confirm-mode-desc">
                    See the correct answer immediately after each submission, with no section timer.
                  </div>
                </div>
              </label>
            </fieldset>

            <div className="lsat-confirm-summary">
              <div className="lsat-confirm-summary-row">
                <span>Time budget</span>
                <strong>{formatBudgetMs(sectionBudgetMs(displayCount))}</strong>
              </div>
              <div className="lsat-confirm-summary-row">
                <span>Questions</span>
                <strong>{displayCount}</strong>
              </div>
              <div className="lsat-confirm-summary-row">
                <span>Target per question</span>
                <strong>1:57</strong>
              </div>
              <div className="lsat-confirm-summary-row lsat-confirm-summary-note">
                <span>GMAT Focus Verbal pace · 23 q / 45 min</span>
              </div>
            </div>

            {priorCount > 0 && (
              <div className="lsat-confirm-prior" role="note">
                <div className="lsat-confirm-prior-icon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>
                  </svg>
                </div>
                <div className="lsat-confirm-prior-body">
                  <strong>You've practiced this section {priorCount}{priorCount === 1 ? ' time' : ' times'} before.</strong>
                  Starting a new session keeps your previous attempts as history — view them in the
                  Sessions and Error Log tabs after.
                </div>
              </div>
            )}

            <div className="lsat-confirm-actions">
              <button type="button" className="lsat-st-link-btn" onClick={onCancel}>← Back to library</button>
              <span className="lsat-st-spacer" />
              <button type="button" className="lsat-st-submit lsat-confirm-start" onClick={() => onStart(mode)}>
                Start session
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ============== SESSION (question UI with timer) ==============
function SessionView({
  selectedTestNum, selectedSectionRoman,
  set, sessionId, section, mode = 'exam',
  onExit, onComplete,
}) {
  const isExam = mode === 'exam';
  const setQuestions = set.questions;
  const [questionIdx, setQuestionIdx] = useState(0);
  const [pickedLetter, setPickedLetter] = useState(null);
  const [confidence, setConfidence] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitResult, setSubmitResult] = useState(null);
  const [attemptsByQ, setAttemptsByQ] = useState({});
  const [navOpen, setNavOpen] = useState(false);
  const [showFinishConfirm, setShowFinishConfirm] = useState(false);
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(Date.now());
  const navRef = useRef(null);
  const startRef = useRef(Date.now());
  const accumulatedRef = useRef(0); // ms accumulated while paused/transitioning

  // Session-level countdown timer. Budget = (per-question target) × question count
  // at GMAT Focus pace (1m 57s/q). After the budget runs out we DO NOT auto-finish;
  // the timer flips to a red "overtime" counter so the user can choose to wrap up.
  const sectionBudget = sectionBudgetMs(setQuestions.length);
  const sessionStartRef = useRef(Date.now());
  const sessionAccRef = useRef(0); // ms accumulated while paused
  const sectionElapsedTotal = paused
    ? sessionAccRef.current
    : (now - sessionStartRef.current + sessionAccRef.current);
  const sectionRemaining = sectionBudget - sectionElapsedTotal; // can be negative (overtime)
  const isOvertime = sectionRemaining < 0;

  const currentQuestion = setQuestions[questionIdx];
  const currentKey = currentQuestion ? `${section.roman}:${currentQuestion.number}` : null;
  const priorAttempt = currentKey ? attemptsByQ[currentKey] : null;

  // Timer tick
  useEffect(() => {
    if (paused || submitted) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [paused, submitted]);

  // Reset timer when question changes
  useEffect(() => {
    startRef.current = Date.now();
    accumulatedRef.current = 0;
    setNow(Date.now());
  }, [questionIdx]);

  // Refresh attempts
  const refreshAttempts = useCallback(() => {
    if (!selectedTestNum) return;
    fetchJson(`/api/lsat/attempts?testNum=${selectedTestNum}`)
      .then((data) => {
        const map = {};
        for (const a of data.attempts || []) map[`${a.section_roman}:${a.question_number}`] = a;
        setAttemptsByQ(map);
      })
      .catch(() => {});
  }, [selectedTestNum]);
  useEffect(() => { refreshAttempts(); }, [refreshAttempts]);

  // Restore prior submitted state. In exam mode we never expose the correct
  // answer back to the UI — only that the answer was saved.
  useEffect(() => {
    if (priorAttempt) {
      setPickedLetter(priorAttempt.user_answer);
      setConfidence(priorAttempt.confidence || null);
      setSubmitted(true);
      setSubmitResult(isExam
        ? { isCorrect: null, correctAnswer: null, locked: true }
        : { isCorrect: !!priorAttempt.is_correct, correctAnswer: priorAttempt.correct_answer });
    } else {
      setPickedLetter(null);
      setConfidence(null);
      setSubmitted(false);
      setSubmitResult(null);
    }
  }, [questionIdx, priorAttempt?.id, isExam]);

  // Keyboard nav
  useEffect(() => {
    function onKey(e) {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.key === 'ArrowLeft' && questionIdx > 0) setQuestionIdx(questionIdx - 1);
      else if (e.key === 'ArrowRight' && questionIdx < setQuestions.length - 1) setQuestionIdx(questionIdx + 1);
      else if (e.key === 'Escape' && navOpen) setNavOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [questionIdx, navOpen, setQuestions.length]);

  // Outside click closes popover
  useEffect(() => {
    if (!navOpen) return;
    function onClick(e) {
      if (navRef.current && !navRef.current.contains(e.target)) setNavOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [navOpen]);

  const elapsedMs = submitted
    ? (priorAttempt?.time_ms ?? 0)
    : (paused ? accumulatedRef.current : (now - startRef.current + accumulatedRef.current));

  function togglePause() {
    if (paused) {
      startRef.current = Date.now();
      sessionStartRef.current = Date.now();
      setPaused(false);
    } else {
      accumulatedRef.current += Date.now() - startRef.current;
      sessionAccRef.current += Date.now() - sessionStartRef.current;
      setPaused(true);
    }
  }

  async function handleSubmit() {
    if (!pickedLetter || !currentQuestion) return;
    const elapsed = paused
      ? accumulatedRef.current
      : (Date.now() - startRef.current + accumulatedRef.current);
    try {
      const r = await fetchJson('/api/lsat/attempts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testNum: selectedTestNum,
          sectionRoman: section.roman,
          sectionKind: section.kind,
          questionNumber: currentQuestion.number,
          userAnswer: pickedLetter,
          confidence,
          timeMs: Math.round(elapsed),
          sessionId,
        }),
      });
      setSubmitted(true);
      // Exam mode: lock the answer but DON'T reveal correctness.
      setSubmitResult(isExam
        ? { isCorrect: null, correctAnswer: null, locked: true }
        : { isCorrect: r.isCorrect, correctAnswer: r.correctAnswer });
      refreshAttempts();
    } catch (e) {
      alert('Failed to save: ' + e.message);
    }
  }

  function handlePrev() { if (questionIdx > 0) setQuestionIdx(questionIdx - 1); }
  function handleNext() {
    if (questionIdx < setQuestions.length - 1) {
      setQuestionIdx(questionIdx + 1);
    } else {
      // Last question — finish session
      onComplete();
    }
  }
  function handleClear() { setPickedLetter(null); setSubmitted(false); setSubmitResult(null); startRef.current = Date.now(); accumulatedRef.current = 0; }

  const sessionScore = useMemo(() => {
    let done = 0, correct = 0, totalTime = 0;
    for (const q of setQuestions) {
      const a = attemptsByQ[`${section.roman}:${q.number}`];
      if (a) { done++; if (a.is_correct) correct++; if (a.time_ms) totalTime += a.time_ms; }
    }
    return { done, correct, total: setQuestions.length, totalTime };
  }, [setQuestions, attemptsByQ, section.roman]);

  // Format mm:ss for the section countdown. When overtime, show absolute value
  // prefixed with "+" so the user sees how far they've run over their target pace.
  const absRemaining = Math.abs(sectionRemaining);
  const sectionMin = Math.floor(absRemaining / 60000);
  const sectionSec = Math.floor((absRemaining % 60000) / 1000);
  const sectionLow = !isOvertime && sectionRemaining < 5 * 60 * 1000; // last 5 min before 0

  // Build passage for RC. Each question carries its own passageIdx so the
  // displayed passage swaps as the user advances through the section.
  const passages = section.passages?.length
    ? section.passages
    : (section.passage ? [{ firstQuestion: 1, text: section.passage }] : []);
  const activePassageIdx = currentQuestion?.passageIdx != null && currentQuestion.passageIdx >= 0
    ? currentQuestion.passageIdx
    : 0;
  const passage = section.kind === 'RC' ? passages[activePassageIdx] : null;
  const showPassage = !!passage;
  const passageNumber = passages.length > 1 ? (activePassageIdx + 1) : null;
  const passageTotal = passages.length;

  if (!currentQuestion) {
    return <div className="lsat-st-shell"><div className="lsat-st-empty">No questions in this set.</div></div>;
  }

  return (
    <div className="lsat-st-shell">
      <header className="lsat-st-topbar">
        <div className="lsat-st-topbar-left">
          <button type="button" className="lsat-st-icon-btn" onClick={onExit} aria-label="Back to set picker" title="Back to set picker">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>
            </svg>
          </button>
          <span className="lsat-st-section-label">{set.label}</span>
          <button type="button" className="lsat-st-icon-btn" onClick={() => setNavOpen((v) => !v)} aria-label="Question navigator" title="All questions in set">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
            </svg>
          </button>
        </div>
        <div className="lsat-st-topbar-right">
          <span className="lsat-st-set-meta">
            PrepTest {selectedTestNum} · {section.kind} · Section {section.roman}
          </span>
          <button
            type="button"
            className="lsat-st-finish-btn"
            onClick={() => setShowFinishConfirm(true)}
            title="Finish now and save only the questions you've answered"
          >
            Finish
          </button>
        </div>

        {navOpen && (
          <div className="lsat-st-nav-popover" ref={navRef} role="dialog" aria-label="Question navigator">
            <div className="lsat-st-nav-popover-header">
              <span>{set.label}</span>
              <span className="lsat-st-nav-popover-stat">{sessionScore.correct}/{sessionScore.done} correct</span>
            </div>
            <div className="lsat-st-nav-grid">
              {setQuestions.map((q, idx) => {
                const a = attemptsByQ[`${section.roman}:${q.number}`];
                const cls = [
                  'lsat-st-nav-chip',
                  idx === questionIdx ? 'is-active' : '',
                  // In exam mode show only "answered" state (no correctness reveal).
                  a ? (isExam ? 'is-answered' : (a.is_correct ? 'is-correct' : 'is-wrong')) : '',
                ].filter(Boolean).join(' ');
                return (
                  <button key={q.number} type="button" className={cls} onClick={() => { setQuestionIdx(idx); setNavOpen(false); }}>
                    {q.number}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </header>

      <div className="lsat-st-subbar">
        <div className="lsat-st-subbar-left">
          <span className="lsat-st-confidence-label">Confidence Rating:</span>
          {CONFIDENCE_LEVELS.map((lv) => (
            <button
              key={lv}
              type="button"
              className={`lsat-st-pill ${confidence === lv ? 'is-active' : ''}`}
              onClick={() => setConfidence(confidence === lv ? null : lv)}
              disabled={submitted}
            >
              {lv.charAt(0).toUpperCase() + lv.slice(1)}
            </button>
          ))}
        </div>
        <div className="lsat-st-subbar-right">
          {isExam && (
            <span
              className={`lsat-st-section-timer ${paused ? 'is-paused' : ''} ${sectionLow ? 'is-low' : ''} ${isOvertime ? 'is-overtime' : ''}`}
              aria-label={isOvertime ? 'Section time exceeded' : 'Section time remaining'}
              title={isOvertime ? 'You have exceeded the GMAT Focus target pace (1m 57s/q). Finish the section when you\'re ready.' : 'Time remaining at GMAT Focus pace (1m 57s/q)'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="13" r="8"/>
                <line x1="12" y1="13" x2="12" y2="9"/>
                <line x1="12" y1="13" x2="15" y2="13"/>
                <line x1="9" y1="2" x2="15" y2="2"/>
              </svg>
              {isOvertime ? '+' : ''}{String(sectionMin).padStart(2, '0')}:{String(sectionSec).padStart(2, '0')}
              {isOvertime && <span className="lsat-st-overtime-tag">OVER</span>}
            </span>
          )}
          <span className={`lsat-st-timer ${paused ? 'is-paused' : ''}`} aria-label="Time on this question" title="Time on this question">
            {formatMs(elapsedMs)}
          </span>
          <span className="lsat-st-score">
            {isExam ? (
              <>{sessionScore.done || 0}<span className="lsat-st-score-of">/{sessionScore.total}</span></>
            ) : (
              <>{sessionScore.correct}/{sessionScore.done || 0}<span className="lsat-st-score-of">/{sessionScore.total}</span></>
            )}
          </span>
          <button
            type="button"
            className={`lsat-st-pause ${paused ? 'is-paused' : ''}`}
            onClick={togglePause}
            disabled={submitted}
            aria-label={paused ? 'Resume timer' : 'Pause timer'}
          >
            {paused ? 'Resume' : 'Pause'}
            {paused ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <polygon points="6,4 20,12 6,20"/>
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="6" y="5" width="4" height="14" rx="0.5"/><rect x="14" y="5" width="4" height="14" rx="0.5"/>
              </svg>
            )}
          </button>
          {!submitted ? (
            <button type="button" className="lsat-st-submit" onClick={handleSubmit} disabled={!pickedLetter}>
              Submit
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/><polyline points="9 12 12 15 16 10"/>
              </svg>
            </button>
          ) : (
            <button type="button" className="lsat-st-submit is-next" onClick={handleNext}>
              {questionIdx >= setQuestions.length - 1 ? 'Finish' : 'Next'}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      <main className={`lsat-st-body ${showPassage ? 'has-passage' : ''}`}>
        {showPassage && (
          <section className="lsat-st-passage" aria-label="Passage">
            {passageNumber && (
              <div className="lsat-st-passage-marker">
                Passage {passageNumber} of {passageTotal}
              </div>
            )}
            <div className="lsat-st-passage-text">{passage.text}</div>
          </section>
        )}

        <section className="lsat-st-question">
          <div className="lsat-st-q-meta">
            <span>Question {currentQuestion.number} · {questionIdx + 1} of {setQuestions.length}</span>
            {priorAttempt && (
              isExam ? (
                <span className="lsat-st-q-status is-locked">
                  Answered{priorAttempt.time_ms ? ` · ${formatMs(priorAttempt.time_ms)}` : ''}
                </span>
              ) : (
                <span className={`lsat-st-q-status ${priorAttempt.is_correct ? 'is-correct' : 'is-wrong'}`}>
                  {priorAttempt.is_correct ? 'Correct' : 'Incorrect'}
                  {priorAttempt.time_ms ? ` · ${formatMs(priorAttempt.time_ms)}` : ''}
                </span>
              )
            )}
          </div>
          <div className="lsat-st-stem">{currentQuestion.stem}</div>

          <div className="lsat-st-choices" role="radiogroup" aria-label="Answer choices">
            {currentQuestion.choices.map((c) => {
              const isPicked = pickedLetter === c.label;
              const isCorrect = submitResult?.correctAnswer === c.label;
              const isWrongPick = submitted && isPicked && submitResult?.isCorrect === false;
              let cls = 'lsat-st-choice';
              // In exam mode, never reveal correctness — only mark the picked answer
              // as locked.
              if (submitted) {
                if (isExam) {
                  if (isPicked) cls += ' is-locked';
                } else {
                  if (isCorrect) cls += ' is-correct';
                  if (isWrongPick) cls += ' is-wrong';
                }
              }
              return (
                <label key={c.label} className={cls}>
                  <input
                    type="radio"
                    name={`q-${currentQuestion.number}`}
                    value={c.label}
                    disabled={submitted}
                    checked={isPicked}
                    onChange={() => setPickedLetter(c.label)}
                  />
                  <span className="lsat-st-choice-text">{c.text}</span>
                </label>
              );
            })}
          </div>

          {submitted && submitResult && (
            <div className="lsat-st-actions">
              {!isExam && (
                <button type="button" className="lsat-st-link-btn" onClick={handleClear}>Retry this question</button>
              )}
              <span className="lsat-st-spacer" />
              <button type="button" className="lsat-st-link-btn" onClick={handlePrev} disabled={questionIdx === 0}>← Previous</button>
              <button type="button" className="lsat-st-link-btn" onClick={handleNext}>
                {questionIdx >= setQuestions.length - 1 ? 'Finish set' : 'Next →'}
              </button>
            </div>
          )}
        </section>
      </main>

      {showFinishConfirm && (
        <div className="lsat-finish-overlay" role="dialog" aria-modal="true" aria-label="Finish session">
          <div className="lsat-finish-card">
            <h3 className="lsat-finish-title">Finish session?</h3>
            {sessionScore.done > 0 ? (
              <p className="lsat-finish-body">
                You've answered <strong>{sessionScore.done}</strong> of{' '}
                <strong>{sessionScore.total}</strong> questions. Only the {sessionScore.done}{' '}
                answered {sessionScore.done === 1 ? 'question' : 'questions'} will be saved to this session.
                {!submitted && pickedLetter ? ' Your current unsubmitted answer will be discarded.' : ''}
              </p>
            ) : (
              <p className="lsat-finish-body">Answer at least one question before finishing.</p>
            )}
            <div className="lsat-finish-actions">
              <button type="button" className="lsat-st-link-btn" onClick={() => setShowFinishConfirm(false)}>
                Keep going
              </button>
              <button
                type="button"
                className="lsat-st-submit"
                disabled={sessionScore.done === 0}
                onClick={() => { setShowFinishConfirm(false); onComplete(); }}
              >
                Finish &amp; review
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============== SESSION SUMMARY ==============
function SessionSummary({ set, attempts, sectionRoman, onBackToPicker, onRetake }) {
  const stats = useMemo(() => {
    let correct = 0, totalTime = 0;
    const rows = set.questions.map((q) => {
      const a = attempts[`${sectionRoman}:${q.number}`];
      if (a?.is_correct) correct++;
      if (a?.time_ms) totalTime += a.time_ms;
      return { q, attempt: a };
    });
    return { rows, correct, total: set.questions.length, totalTime };
  }, [set, attempts, sectionRoman]);
  const accuracy = Math.round((stats.correct / stats.total) * 100);
  const avgTime = stats.totalTime ? stats.totalTime / Math.max(1, stats.total) : 0;

  return (
    <div className="lsat-st-shell">
      <header className="lsat-st-topbar">
        <div className="lsat-st-topbar-left">
          <button type="button" className="lsat-st-icon-btn" onClick={onBackToPicker} aria-label="Back to sets" title="Back to sets">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>
            </svg>
          </button>
          <span className="lsat-st-section-label">{set.label} · Summary</span>
        </div>
      </header>
      <main className="lsat-st-summary">
        <div className="lsat-st-summary-headline">
          <div className="lsat-st-summary-big">{stats.correct}/{stats.total}</div>
          <div className="lsat-st-summary-meta">
            <span>{accuracy}% accuracy</span>
            <span className="lsat-st-summary-dot">·</span>
            <span>{formatMs(stats.totalTime)} total</span>
            <span className="lsat-st-summary-dot">·</span>
            <span>{formatMs(avgTime)} avg / q</span>
          </div>
        </div>
        <table className="lsat-st-summary-table">
          <thead>
            <tr><th>Q</th><th>Your answer</th><th>Correct</th><th>Time</th><th>Confidence</th></tr>
          </thead>
          <tbody>
            {stats.rows.map(({ q, attempt }) => (
              <tr key={q.number} className={attempt ? (attempt.is_correct ? 'is-correct' : 'is-wrong') : ''}>
                <td>{q.number}</td>
                <td>{attempt?.user_answer || '—'}</td>
                <td>{attempt?.correct_answer || q.correct || '—'}</td>
                <td>{attempt?.time_ms ? formatMs(attempt.time_ms) : '—'}</td>
                <td>{attempt?.confidence || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="lsat-st-summary-actions">
          <button type="button" className="lsat-st-link-btn" onClick={onBackToPicker}>← Back to sets</button>
          <span className="lsat-st-spacer" />
          <button type="button" className="lsat-st-submit" onClick={onRetake}>
            Retake this set
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </div>
      </main>
    </div>
  );
}

// ============== ROOT ==============
export default function LsatPractice({ onExit }) {
  const [activeSession, setActiveSession] = useState(null); // { set, sessionId, section, testNum, mode }
  const [pendingPick, setPendingPick] = useState(null); // { testNum, sectionRoman }
  const [view, setView] = useState('library'); // 'library' | 'sessions' | 'errors' | 'confirm' | 'session' | 'summary'

  function handleTabChange(tab) {
    setActiveSession(null);
    setPendingPick(null);
    setView(tab);
  }

  function handlePickSection(testNum, sectionRoman, questionNumbers = null) {
    setPendingPick({ testNum, sectionRoman, questionNumbers: questionNumbers || null });
    setView('confirm');
  }

  async function handleStartSession(mode) {
    if (!pendingPick) return;
    const { testNum, sectionRoman, questionNumbers } = pendingPick;
    try {
      const secResp = await fetchJson(`/api/lsat/tests/${testNum}/sections/${sectionRoman}`);
      const set = buildSetForSection(secResp.section, questionNumbers);
      if (!set) { alert('No questions in this section'); return; }
      const session = await fetchJson('/api/lsat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testNum,
          sectionRoman,
          setKey: set.key,
          setLabel: `PrepTest ${testNum} · ${secResp.section.kind} · Section ${secResp.section.roman}`,
          firstQuestion: set.firstQuestion,
          lastQuestion: set.lastQuestion,
          mode,
          questionNumbers: set.questionNumbers,
        }),
      });
      setActiveSession({
        set: { ...set, label: `PrepTest ${testNum} · ${secResp.section.kind} · Section ${secResp.section.roman}` },
        sessionId: session.id,
        section: secResp.section,
        testNum,
        mode,
      });
      setPendingPick(null);
      setView('session');
    } catch (e) {
      alert('Failed to start session: ' + e.message);
    }
  }

  async function handleSessionComplete() {
    if (activeSession?.sessionId) {
      try { await fetchJson(`/api/lsat/sessions/${activeSession.sessionId}/complete`, { method: 'POST' }); } catch (e) {}
    }
    setView('summary');
  }

  function handleBackToLibrary() {
    setActiveSession(null);
    setPendingPick(null);
    setView('library');
  }

  async function handleRetake() {
    if (!activeSession) return;
    const { testNum, section, sessionId } = activeSession;
    let questionNumbers = null;
    try {
      const resp = await fetchJson(`/api/lsat/sessions/${sessionId}`);
      questionNumbers = resp.session?.question_numbers || null;
    } catch (e) { /* fall back to full section */ }
    handlePickSection(testNum, section.roman, questionNumbers);
  }

  if (view === 'confirm' && pendingPick) {
    return (
      <ConfirmationScreen
        testNum={pendingPick.testNum}
        sectionRoman={pendingPick.sectionRoman}
        subset={pendingPick.questionNumbers}
        onStart={handleStartSession}
        onCancel={handleBackToLibrary}
      />
    );
  }
  if (view === 'session' && activeSession) {
    return (
      <SessionView
        selectedTestNum={activeSession.testNum}
        selectedSectionRoman={activeSession.section.roman}
        set={activeSession.set}
        sessionId={activeSession.sessionId}
        section={activeSession.section}
        mode={activeSession.mode}
        onExit={handleBackToLibrary}
        onComplete={handleSessionComplete}
      />
    );
  }
  if (view === 'summary' && activeSession) {
    return (
      <SummaryWrapper
        set={activeSession.set}
        sectionRoman={activeSession.section.roman}
        selectedTestNum={activeSession.testNum}
        onBackToPicker={handleBackToLibrary}
        onRetake={handleRetake}
      />
    );
  }
  if (view === 'sessions') {
    return <LsatSessionsView onPickSection={handlePickSection} onExit={onExit} onTabChange={handleTabChange} />;
  }
  if (view === 'errors') {
    return <LsatErrorLogView onExit={onExit} onTabChange={handleTabChange} />;
  }
  return <LsatLibrary onPickSection={handlePickSection} onExit={onExit} onTabChange={handleTabChange} />;
}

// Wraps SessionSummary with a fresh fetch of attempts so it shows latest data.
function SummaryWrapper({ set, sectionRoman, selectedTestNum, onBackToPicker, onRetake }) {
  const [attempts, setAttempts] = useState({});
  useEffect(() => {
    fetchJson(`/api/lsat/attempts?testNum=${selectedTestNum}`)
      .then((data) => {
        const map = {};
        for (const a of data.attempts || []) map[`${a.section_roman}:${a.question_number}`] = a;
        setAttempts(map);
      })
      .catch(() => {});
  }, [selectedTestNum]);
  return (
    <SessionSummary
      set={set}
      attempts={attempts}
      sectionRoman={sectionRoman}
      onBackToPicker={onBackToPicker}
      onRetake={onRetake}
    />
  );
}
