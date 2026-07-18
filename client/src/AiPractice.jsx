import React, { useEffect, useState, useCallback, useRef } from 'react';

const API = '/api/ai-practice';
const CONFIDENCE = ['low', 'medium', 'high'];
const PER_Q_BUDGET_MS = 120000; // GMAT Focus pace ≈ 2 min / question

function formatMs(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const pad2 = (n) => String(n).padStart(2, '0');

// ---- shared icons (match the LSAT test surface) ----
const IconBack = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
);
const IconGrid = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
);
const IconClock = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8" /><line x1="12" y1="13" x2="12" y2="9" /><line x1="12" y1="13" x2="15" y2="13" /><line x1="9" y1="2" x2="15" y2="2" /></svg>
);
const IconCheck = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><polyline points="9 12 12 15 16 10" /></svg>
);
const IconNext = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
);

export default function AiPractice({ onExit }) {
  const [screen, setScreen] = useState('list');       // 'list' | 'runner' | 'result'
  const [activeSet, setActiveSet] = useState(null);
  const [mode, setMode] = useState('exam');           // 'exam' | 'review'
  const [result, setResult] = useState(null);
  const [totalTimeSec, setTotalTimeSec] = useState(0);

  const startSet = useCallback(async (slug, m) => {
    try {
      const r = await fetch(`${API}/sets/${slug}`);
      const data = await r.json();
      if (!r.ok) { alert(data.error || 'Could not load set'); return; }
      if (!data.questions?.length) { alert('This set has no gradeable questions.'); return; }
      setActiveSet(data); setMode(m); setResult(null); setScreen('runner');
    } catch (e) { alert('Could not load set: ' + e.message); }
  }, []);

  const finish = useCallback(async (answers) => {
    try {
      const time = answers.reduce((s, a) => s + (a.timeSec || 0), 0);
      const r = await fetch(`${API}/sets/${activeSet.slug}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers, feedbackMode: mode === 'exam' ? 'end' : 'immediate' }),
      });
      const data = await r.json();
      if (!r.ok) { alert(data.error || 'Submit failed'); return; }
      setTotalTimeSec(time); setResult(data); setScreen('result');
    } catch (e) { alert('Submit failed: ' + e.message); }
  }, [activeSet, mode]);

  const backToList = () => { setScreen('list'); setActiveSet(null); setResult(null); };

  if (screen === 'runner') {
    return <Runner set={activeSet} mode={mode} onFinish={finish} onExit={backToList} />;
  }
  if (screen === 'result') {
    return <Result set={activeSet} result={result} totalTimeSec={totalTimeSec} mode={mode} onBack={backToList} onExit={onExit} />;
  }
  return <SetList onStart={startSet} onExit={onExit} />;
}

// ============================== SET LIST ==============================
function SetList({ onStart, onExit }) {
  const [sets, setSets] = useState(null);
  const [mode, setMode] = useState('exam');
  useEffect(() => {
    fetch(`${API}/sets`).then((r) => r.json()).then((d) => setSets(d.sets || [])).catch(() => setSets([]));
  }, []);

  return (
    <div className="lsat-st-shell">
      <header className="lsat-st-topbar">
        <div className="lsat-st-topbar-left">
          <button type="button" className="lsat-st-icon-btn" onClick={onExit} aria-label="Exit to GMAT Dashboard" title="Exit"><IconBack /></button>
          <span className="lsat-st-section-label">AI Curated Practice</span>
        </div>
      </header>
      <main className="lsat-st-body">
        {sets === null ? (
          <p className="muted">Loading sets…</p>
        ) : sets.length === 0 ? (
          <div className="ai-empty">
            <h2 className="ai-empty-title">No practice sets yet</h2>
            <p className="ai-empty-body">Sets are curated for you — pulled from the questions you’ve missed. When one is ready it shows up here as a timed, test-like drill. (Sets live in <code>data/ai-practice-sets/</code>; see the recipe in ANALYSIS.md.)</p>
          </div>
        ) : (
          <div className="ai-picker">
            <div className="ai-picker-head">
              <h2 className="ai-picker-title">Choose a set</h2>
              <div className="ai-mode-toggle" role="radiogroup" aria-label="Feedback timing">
                <button type="button" role="radio" aria-checked={mode === 'exam'} className={`ai-mode-opt ${mode === 'exam' ? 'is-active' : ''}`} onClick={() => setMode('exam')}>
                  <span className="ai-mode-name">Exam</span>
                  <span className="ai-mode-desc">Answers lock; score at the end</span>
                </button>
                <button type="button" role="radio" aria-checked={mode === 'review'} className={`ai-mode-opt ${mode === 'review' ? 'is-active' : ''}`} onClick={() => setMode('review')}>
                  <span className="ai-mode-name">Review</span>
                  <span className="ai-mode-desc">See the answer after each question</span>
                </button>
              </div>
            </div>
            <div className="ai-set-grid">
              {sets.map((s) => (
                <article key={s.slug} className="ai-set-card">
                  <div className="ai-set-card-top">
                    {s.subject && <span className="ai-set-subject">{s.subject}</span>}
                    <span className="ai-set-count">{s.count} Q{s.completedCount ? ` · done ${s.completedCount}×` : ''}</span>
                  </div>
                  <h3>{s.title}</h3>
                  {s.focusNote && <p className="ai-set-note">{s.focusNote}</p>}
                  <button type="button" className="ai-btn-primary ai-set-start" onClick={() => onStart(s.slug, mode)}>
                    {s.completedCount ? 'Practice again' : 'Start'}
                  </button>
                </article>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ============================== RUNNER ==============================
function Runner({ set, mode, onFinish, onExit }) {
  const questions = set.questions;
  const isExam = mode === 'exam';

  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({});   // itemId -> { answer, timeSec, confidence, submitted }
  const [feedback, setFeedback] = useState({}); // itemId -> { correct, correctAnswer }  (review only)
  const [navOpen, setNavOpen] = useState(false);
  const [showFinish, setShowFinish] = useState(false);
  const [paused, setPaused] = useState(false);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(Date.now());

  const navRef = useRef(null);
  const qStartRef = useRef(Date.now());
  const qAccRef = useRef(0);
  const sessStartRef = useRef(Date.now());
  const sessAccRef = useRef(0);

  const q = questions[idx];
  const cur = answers[q.itemId] || null;
  const submitted = !!cur?.submitted;
  const chosen = cur?.answer || null;
  const fb = feedback[q.itemId] || null;

  // Review mode holds BOTH clocks while you read the revealed answer; exam mode
  // stays continuously timed like the real test.
  const reviewFrozen = !isExam && submitted;
  const clockStopped = paused || reviewFrozen;

  // Section countdown at GMAT Focus pace; goes negative into red overtime.
  const sectionBudget = PER_Q_BUDGET_MS * questions.length;
  const sectionElapsed = clockStopped ? sessAccRef.current : (now - sessStartRef.current + sessAccRef.current);
  const sectionRemaining = sectionBudget - sectionElapsed;
  const isOvertime = sectionRemaining < 0;
  const absR = Math.abs(sectionRemaining);
  const secMin = Math.floor(absR / 60000);
  const secSec = Math.floor((absR % 60000) / 1000);
  const sectionLow = !isOvertime && sectionRemaining < 5 * 60000;

  const qElapsed = submitted
    ? (cur.timeSec || 0) * 1000
    : (paused ? qAccRef.current : (now - qStartRef.current + qAccRef.current));

  const answeredCount = questions.filter((it) => answers[it.itemId]?.submitted).length;

  // Ticker stops when either clock is stopped (manual pause or review reveal).
  useEffect(() => {
    if (clockStopped) return undefined;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [clockStopped]);

  // Auto-pause the section clock when a review answer is revealed; resume on
  // leaving it. Banks/restarts the running segment just like the pause button.
  useEffect(() => {
    if (paused) return; // pause button owns the accumulation while paused
    if (reviewFrozen) sessAccRef.current += Date.now() - sessStartRef.current;
    else sessStartRef.current = Date.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewFrozen]);

  // Reset the per-question timer on navigation.
  useEffect(() => {
    qStartRef.current = Date.now();
    qAccRef.current = (answers[questions[idx].itemId]?.timeSec || 0) * 1000;
    setNow(Date.now());
    setNavOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  // Arrow-key navigation between questions.
  useEffect(() => {
    function onKey(e) {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.key === 'ArrowLeft' && idx > 0) setIdx(idx - 1);
      else if (e.key === 'ArrowRight' && idx < questions.length - 1) setIdx(idx + 1);
      else if (e.key === 'Escape') { if (navOpen) setNavOpen(false); else if (showFinish) setShowFinish(false); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [idx, navOpen, showFinish, questions.length]);

  useEffect(() => {
    if (!navOpen) return undefined;
    function onClick(e) { if (navRef.current && !navRef.current.contains(e.target)) setNavOpen(false); }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [navOpen]);

  const pick = (label) => {
    if (submitted) return;
    setAnswers((a) => ({ ...a, [q.itemId]: { ...(a[q.itemId] || {}), answer: label } }));
  };
  const toggleConfidence = (lv) => {
    if (submitted) return;
    setAnswers((a) => ({ ...a, [q.itemId]: { ...(a[q.itemId] || {}), confidence: a[q.itemId]?.confidence === lv ? null : lv } }));
  };

  function togglePause() {
    if (paused) {
      qStartRef.current = Date.now();
      sessStartRef.current = Date.now();
      setPaused(false);
    } else {
      qAccRef.current += Date.now() - qStartRef.current;
      sessAccRef.current += Date.now() - sessStartRef.current;
      setPaused(true);
    }
  }

  async function submit() {
    if (!chosen) return;
    const elapsedMs = paused ? qAccRef.current : (Date.now() - qStartRef.current + qAccRef.current);
    const timeSec = Math.round(elapsedMs / 1000);
    setAnswers((a) => ({ ...a, [q.itemId]: { ...(a[q.itemId] || {}), answer: chosen, timeSec, submitted: true } }));
    if (!isExam) {
      setChecking(true);
      try {
        const r = await fetch(`${API}/sets/${set.slug}/grade`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId: q.itemId, answer: chosen }),
        });
        if (r.ok) { const d = await r.json(); setFeedback((f) => ({ ...f, [q.itemId]: { correct: d.correct, correctAnswer: d.correctAnswer } })); }
      } catch (_e) { /* leave unrevealed on network error */ }
      setChecking(false);
    }
  }

  function unlock() {
    setAnswers((a) => ({ ...a, [q.itemId]: { ...(a[q.itemId] || {}), submitted: false } }));
    setFeedback((f) => { const n = { ...f }; delete n[q.itemId]; return n; });
    qStartRef.current = Date.now();
    qAccRef.current = (answers[q.itemId]?.timeSec || 0) * 1000;
  }

  const goPrev = () => { if (idx > 0) setIdx(idx - 1); };
  const goNext = () => { if (idx < questions.length - 1) setIdx(idx + 1); else setShowFinish(true); };

  function doFinish() {
    const payload = questions
      .filter((it) => answers[it.itemId]?.submitted && answers[it.itemId]?.answer)
      .map((it) => ({ itemId: it.itemId, answer: answers[it.itemId].answer, timeSec: answers[it.itemId].timeSec, confidence: answers[it.itemId].confidence || null }));
    onFinish(payload);
  }

  return (
    <div className="lsat-st-shell">
      <header className="lsat-st-topbar">
        <div className="lsat-st-topbar-left">
          <button type="button" className="lsat-st-icon-btn" onClick={onExit} aria-label="Back to set picker" title="Back to set picker"><IconBack /></button>
          <span className="lsat-st-section-label">{set.title}</span>
          <button type="button" className="lsat-st-icon-btn" onClick={() => setNavOpen((v) => !v)} aria-label="Question navigator" title="All questions in this set"><IconGrid /></button>
        </div>
        <div className="lsat-st-topbar-right">
          <span className="lsat-st-set-meta">{set.subject || 'Mixed'} · {questions.length} questions · {isExam ? 'Exam' : 'Review'}</span>
          <button type="button" className="lsat-st-finish-btn" onClick={() => setShowFinish(true)} title="End now and save answered questions">End Session</button>
        </div>

        {navOpen && (
          <div className="lsat-st-nav-popover" ref={navRef} role="dialog" aria-label="Question navigator">
            <div className="lsat-st-nav-popover-header">
              <span>{set.title}</span>
              <span className="lsat-st-nav-popover-stat">{answeredCount}/{questions.length} answered</span>
            </div>
            <div className="lsat-st-nav-grid">
              {questions.map((it, i) => {
                const a = answers[it.itemId];
                const f = feedback[it.itemId];
                const state = a?.submitted
                  ? (isExam ? 'is-answered' : (f ? (f.correct ? 'is-correct' : 'is-wrong') : 'is-answered'))
                  : '';
                const cls = ['lsat-st-nav-chip', i === idx ? 'is-active' : '', state].filter(Boolean).join(' ');
                return (
                  <button key={it.itemId} type="button" className={cls} onClick={() => { setIdx(i); setNavOpen(false); }}>{i + 1}</button>
                );
              })}
            </div>
          </div>
        )}
      </header>

      <div className="lsat-st-subbar">
        <div className="lsat-st-subbar-left">
          <span className="lsat-st-confidence-label">Confidence:</span>
          {CONFIDENCE.map((lv) => (
            <button key={lv} type="button" className={`lsat-st-pill ${cur?.confidence === lv ? 'is-active' : ''}`} onClick={() => toggleConfidence(lv)} disabled={submitted}>
              {lv.charAt(0).toUpperCase() + lv.slice(1)}
            </button>
          ))}
        </div>
        <div className="lsat-st-subbar-right">
          <span
            className={`lsat-st-section-timer ${clockStopped ? 'is-paused' : ''} ${sectionLow ? 'is-low' : ''} ${isOvertime ? 'is-overtime' : ''}`}
            aria-label={isOvertime ? 'Section time exceeded' : 'Section time remaining'}
            title={reviewFrozen ? 'Paused while you review the answer' : isOvertime ? 'Past GMAT Focus target pace (~2 min/question). Wrap up when ready.' : 'Time remaining at GMAT Focus pace (~2 min/question)'}
          >
            <IconClock />{isOvertime ? '+' : ''}{pad2(secMin)}:{pad2(secSec)}{isOvertime && <span className="lsat-st-overtime-tag">OVER</span>}
          </span>
          <span className={`lsat-st-timer ${clockStopped ? 'is-paused' : ''}`} aria-label="Time on this question" title="Time on this question">{formatMs(qElapsed)}</span>
          <span className="lsat-st-score">{answeredCount}<span className="lsat-st-score-of">/{questions.length}</span></span>
          <button type="button" className={`lsat-st-pause ${paused ? 'is-paused' : ''}`} onClick={togglePause} disabled={submitted} aria-label={paused ? 'Resume timer' : 'Pause timer'}>
            {paused ? 'Resume' : 'Pause'}
            {paused
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6,4 20,12 6,20" /></svg>
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="0.5" /><rect x="14" y="5" width="4" height="14" rx="0.5" /></svg>}
          </button>
          {!submitted ? (
            <button type="button" className="lsat-st-submit" onClick={submit} disabled={!chosen || checking || paused}>{checking ? 'Checking…' : 'Submit'}<IconCheck /></button>
          ) : (
            <button type="button" className="lsat-st-submit is-next" onClick={goNext}>{idx >= questions.length - 1 ? 'Finish' : 'Next'}<IconNext /></button>
          )}
        </div>
      </div>

      <main className="lsat-st-body">
        <section className="lsat-st-question">
          <div className="lsat-st-q-meta">
            <span>Question {idx + 1} of {questions.length}{q.difficulty ? ` · ${q.difficulty}` : ''}{q.topic ? ` · ${q.topic}` : ''}</span>
            {submitted && (
              isExam
                ? <span className="lsat-st-q-status is-locked">Answered · {formatMs((cur.timeSec || 0) * 1000)}</span>
                : fb
                  ? <span className={`lsat-st-q-status ${fb.correct ? 'is-correct' : 'is-wrong'}`}>{fb.correct ? 'Correct' : 'Incorrect'} · {formatMs((cur.timeSec || 0) * 1000)}</span>
                  : null
            )}
          </div>

          <div className="lsat-st-stem">
            {q.question_stem_html
              ? <span dangerouslySetInnerHTML={{ __html: q.question_stem_html }} />
              : q.question_stem}
          </div>

          <div className="lsat-st-choices" role="radiogroup" aria-label="Answer choices">
            {q.answer_choices.map((c) => {
              const isPicked = chosen === c.label;
              let cls = 'lsat-st-choice';
              if (submitted) {
                if (isExam) { if (isPicked) cls += ' is-locked'; }
                else if (fb) {
                  if (c.label === fb.correctAnswer) cls += ' is-correct';
                  else if (isPicked && !fb.correct) cls += ' is-wrong';
                }
              }
              return (
                <label key={c.label} className={cls}>
                  <input type="radio" name={`q-${q.itemId}`} value={c.label} disabled={submitted} checked={isPicked} onChange={() => pick(c.label)} />
                  <span className="lsat-st-choice-text"><b className="ai-choice-letter">{c.label}.</b> <span dangerouslySetInnerHTML={{ __html: c.text || '' }} /></span>
                </label>
              );
            })}
          </div>

          {!isExam && submitted && fb && (
            <div className={`ai-reveal ${fb.correct ? 'is-correct' : 'is-wrong'}`} role="status">
              <span className="ai-reveal-mark">{fb.correct ? '✓' : '✗'}</span>
              <span className="ai-reveal-text">
                {fb.correct
                  ? <>Correct — the answer is <b>{fb.correctAnswer}</b>.</>
                  : <>Incorrect. You chose <b>{chosen}</b>; the correct answer is <b>{fb.correctAnswer}</b>.</>}
                <span className="ai-reveal-hint"> Timer paused — press Next to continue.</span>
              </span>
            </div>
          )}

          {submitted && (
            <div className="lsat-st-actions">
              <button type="button" className="lsat-st-link-btn" onClick={unlock}>{isExam ? 'Change answer' : 'Retry this question'}</button>
              <span className="lsat-st-spacer" />
              <button type="button" className="lsat-st-link-btn" onClick={goPrev} disabled={idx === 0}>← Previous</button>
              <button type="button" className="lsat-st-link-btn" onClick={goNext}>{idx >= questions.length - 1 ? 'Finish set' : 'Next →'}</button>
            </div>
          )}
        </section>
      </main>

      {showFinish && (
        <div className="lsat-finish-overlay" role="dialog" aria-modal="true" aria-label="Finish session">
          <div className="lsat-finish-card">
            <h3 className="lsat-finish-title">Finish session?</h3>
            {answeredCount > 0 ? (
              <p className="lsat-finish-body">
                You’ve answered <strong>{answeredCount}</strong> of <strong>{questions.length}</strong> questions. Only answered questions are saved to this session.
                {!submitted && chosen ? ' Your current unsubmitted answer will be discarded.' : ''}
              </p>
            ) : (
              <p className="lsat-finish-body">Answer at least one question before finishing.</p>
            )}
            <div className="lsat-finish-actions">
              <button type="button" className="lsat-st-link-btn" onClick={() => setShowFinish(false)}>Keep going</button>
              <button type="button" className="lsat-st-submit" disabled={answeredCount === 0} onClick={() => { setShowFinish(false); doFinish(); }}>Finish &amp; review</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================== RESULT ==============================
function Result({ set, result, totalTimeSec, onBack, onExit }) {
  const byId = new Map((set.questions || []).map((q) => [q.itemId, q]));
  const total = result.score.total || 0;
  const correct = result.score.correct || 0;
  const accuracy = total ? Math.round((correct / total) * 100) : 0;
  const avgSec = total ? Math.round(totalTimeSec / total) : 0;

  return (
    <div className="lsat-st-shell">
      <header className="lsat-st-topbar">
        <div className="lsat-st-topbar-left">
          <button type="button" className="lsat-st-icon-btn" onClick={onBack} aria-label="Back to set picker" title="Back to set picker"><IconBack /></button>
          <span className="lsat-st-section-label">Results — {set.title}</span>
        </div>
        <div className="lsat-st-topbar-right">
          <button type="button" className="lsat-st-finish-btn" onClick={onExit} title="Back to dashboard">Dashboard</button>
        </div>
      </header>

      <main className="lsat-st-body">
        <div className="ai-report">
          <div className="ai-report-score">
            <div className="ai-report-big">{correct}<span className="ai-report-of">/{total}</span></div>
            <div className="ai-report-label">correct</div>
          </div>
          <dl className="ai-report-stats">
            <div><dt>Accuracy</dt><dd>{accuracy}%</dd></div>
            <div><dt>Total time</dt><dd>{formatMs(totalTimeSec * 1000)}</dd></div>
            <div><dt>Avg / question</dt><dd>{formatMs(avgSec * 1000)}</dd></div>
          </dl>
        </div>

        {set.focusNote && <p className="ai-report-note">{set.focusNote}</p>}

        <ol className="ai-review-list">
          {result.results.map((r, i) => {
            const q = byId.get(r.itemId);
            const prior = r.priorAttempt || {};
            const stem = q?.question_stem ? q.question_stem.replace(/\s+/g, ' ').trim() : `Item ${r.itemId}`;
            return (
              <li key={r.itemId} className={r.correct ? 'ok' : 'bad'}>
                <div className="ai-review-q"><span className="ai-review-n">{i + 1}</span>{stem.slice(0, 130)}{stem.length > 130 ? '…' : ''}</div>
                <div className="ai-review-meta">
                  <span className={`ai-review-result ${r.correct ? 'ok' : 'bad'}`}>{r.correct ? '✓ Correct' : '✗ Wrong'}</span>
                  <span className="muted">you</span> <b>{r.yourAnswer || '—'}</b>
                  <span className="muted">answer</span> <b>{r.correctAnswer || '—'}</b>
                  {prior.source && <span className="muted">· first attempt on {prior.source}: {prior.correct ? 'correct' : 'wrong'}</span>}
                </div>
              </li>
            );
          })}
        </ol>

        <div className="ai-report-actions">
          <button type="button" className="ai-btn-primary" onClick={onBack}>Back to sets</button>
        </div>
      </main>
    </div>
  );
}
