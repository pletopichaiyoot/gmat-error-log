import React, { useEffect, useState, useCallback, useRef } from 'react';

const API = '/api/ai-practice';

export default function AiPractice({ onExit }) {
  const [screen, setScreen] = useState('list');      // 'list' | 'runner' | 'result'
  const [activeSet, setActiveSet] = useState(null);  // { slug, title, focusNote, questions[] }
  const [feedbackMode, setFeedbackMode] = useState('end'); // 'end' | 'immediate'
  const [result, setResult] = useState(null);        // submit response

  const startSet = useCallback(async (slug, mode) => {
    const r = await fetch(`${API}/sets/${slug}`);
    if (!r.ok) { alert('Could not load set'); return; }
    const data = await r.json();
    if (!data.questions?.length) { alert('This set has no gradeable questions.'); return; }
    setActiveSet(data);
    setFeedbackMode(mode);
    setScreen('runner');
  }, []);

  const finish = useCallback(async (answers) => {
    const r = await fetch(`${API}/sets/${activeSet.slug}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    const data = await r.json();
    if (!r.ok) { alert(data.error || 'Submit failed'); return; }
    setResult(data);
    setScreen('result');
  }, [activeSet]);

  return (
    <div className="lsat-st-shell">
      <header className="lsat-st-topbar">
        <div className="lsat-st-topbar-left">
          <button type="button" className="lsat-st-icon-btn" onClick={onExit} aria-label="Exit to GMAT Dashboard" title="Exit">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>
            </svg>
          </button>
          <span className="lsat-st-section-label">AI Curated Practice</span>
        </div>
      </header>
      {screen === 'list' && <SetList onStart={startSet} />}
      {screen === 'runner' && (
        <Runner set={activeSet} feedbackMode={feedbackMode} onFinish={finish} onQuit={() => setScreen('list')} />
      )}
      {screen === 'result' && (
        <Result set={activeSet} result={result} onBack={() => { setScreen('list'); setActiveSet(null); setResult(null); }} />
      )}
    </div>
  );
}

function SetList({ onStart }) {
  const [sets, setSets] = useState(null);
  const [mode, setMode] = useState('end');
  useEffect(() => {
    fetch(`${API}/sets`).then((r) => r.json()).then((d) => setSets(d.sets || [])).catch(() => setSets([]));
  }, []);
  if (sets === null) return <main className="lsat-st-body">Loading…</main>;
  if (sets.length === 0) {
    return (
      <main className="lsat-st-body">
        <h2>No practice sets yet</h2>
        <p className="muted">Curate a set with Claude Cowork — it writes a JSON file to
          <code> data/ai-practice-sets/</code>. See the recipe in ANALYSIS.md.</p>
      </main>
    );
  }
  return (
    <main className="lsat-st-body">
      <div className="ai-feedback-toggle">
        Feedback:
        <label><input type="radio" checked={mode === 'end'} onChange={() => setMode('end')} /> End of session</label>
        <label><input type="radio" checked={mode === 'immediate'} onChange={() => setMode('immediate')} /> After each question</label>
      </div>
      <div className="ai-set-grid">
        {sets.map((s) => (
          <div key={s.slug} className="ai-set-card">
            <h3>{s.title}</h3>
            {s.subject && <span className="ai-set-subject">{s.subject}</span>}
            {s.focusNote && <p className="ai-set-note">{s.focusNote}</p>}
            <p className="muted">{s.count} question{s.count === 1 ? '' : 's'}
              {s.completedCount ? ` · practiced ${s.completedCount}×` : ''}</p>
            <button type="button" className="ai-btn-primary" onClick={() => onStart(s.slug, mode)}>
              {s.completedCount ? 'Practice again' : 'Start'}
            </button>
          </div>
        ))}
      </div>
    </main>
  );
}

function Runner({ set, feedbackMode, onFinish, onQuit }) {
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({});        // itemId -> { answer, timeSec, confidence }
  const [revealed, setRevealed] = useState(false);   // immediate mode: reveal current
  const startRef = useRef(Date.now());
  const q = set.questions[idx];
  const last = idx === set.questions.length - 1;

  useEffect(() => { startRef.current = Date.now(); setRevealed(false); }, [idx]);

  const pick = (label) => {
    const timeSec = Math.round((Date.now() - startRef.current) / 1000);
    setAnswers((a) => ({ ...a, [q.itemId]: { answer: label, timeSec, confidence: a[q.itemId]?.confidence || null } }));
  };
  const chosen = answers[q.itemId]?.answer || null;

  const next = () => {
    if (feedbackMode === 'immediate' && !revealed) { setRevealed(true); return; }
    if (last) {
      const payload = set.questions
        .filter((it) => answers[it.itemId])
        .map((it) => ({ itemId: it.itemId, ...answers[it.itemId] }));
      onFinish(payload);
    } else {
      setIdx((i) => i + 1);
    }
  };

  return (
    <main className="lsat-st-body ai-runner">
      <div className="ai-runner-head">
        <span>Question {idx + 1} / {set.questions.length}</span>
        <button type="button" className="ai-btn-ghost" onClick={onQuit}>Quit</button>
      </div>
      <div className="ai-stem">
        {q.question_stem_html
          ? <div dangerouslySetInnerHTML={{ __html: q.question_stem_html }} />
          : <div style={{ whiteSpace: 'pre-line' }}>{q.question_stem}</div>}
      </div>
      <ul className="ai-choices">
        {q.answer_choices.map((c) => (
          <li key={c.label}>
            <button
              type="button"
              className={`ai-choice${chosen === c.label ? ' selected' : ''}`}
              onClick={() => pick(c.label)}
              disabled={feedbackMode === 'immediate' && revealed}
            >
              <b>{c.label}.</b> <span dangerouslySetInnerHTML={{ __html: c.text || '' }} />
            </button>
          </li>
        ))}
      </ul>
      {feedbackMode === 'immediate' && revealed && (
        <p className="muted">Answer recorded — correctness shown on the results screen.</p>
      )}
      <div className="ai-runner-foot">
        <button type="button" className="ai-btn-primary" onClick={next} disabled={!chosen}>
          {feedbackMode === 'immediate' && !revealed ? 'Check' : last ? 'Finish' : 'Next'}
        </button>
      </div>
    </main>
  );
}

function Result({ set, result, onBack }) {
  const byId = new Map((set.questions || []).map((q) => [q.itemId, q]));
  return (
    <main className="lsat-st-body ai-result">
      <h2>Score: {result.score.correct} / {result.score.total}</h2>
      {set.focusNote && <p className="ai-set-note">{set.focusNote}</p>}
      <ol className="ai-review-list">
        {result.results.map((r, i) => {
          const q = byId.get(r.itemId);
          const prior = r.priorAttempt || {};
          return (
            <li key={r.itemId} className={r.correct ? 'ok' : 'bad'}>
              <div className="ai-review-q">{i + 1}. {q?.question_stem?.slice(0, 120) || `Item ${r.itemId}`}…</div>
              <div className="ai-review-meta">
                You: <b>{r.yourAnswer}</b> · Correct: <b>{r.correctAnswer}</b> · {r.correct ? '✓' : '✗'}
                {prior.source && (
                  <span className="muted"> · originally on {prior.source}: {prior.correct ? 'correct' : 'wrong'}</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <button type="button" className="ai-btn-primary" onClick={onBack}>Back to sets</button>
    </main>
  );
}
