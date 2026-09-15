import React, { useCallback, useEffect, useRef, useState } from 'react';
import PassageLines from './PassageLines';

// GMAT Official Guide book practice (#og). Questions come from
// data/gmat-og-questions.json through /api/og/*; only the answers are stored.
//
// Three screens: a filter-based Builder, a Runner, and a Summary. The test
// chrome (.lsat-st-*) is shared with the LSAT and AI-curated surfaces.
//
// Practice mode reveals the key and the book's explanation right after each
// answer; Timed mode holds both back until the summary. The server hands both
// back one answer at a time either way — the question payload carries neither —
// so Timed cannot be read out of the network tab in advance.

const API = '/api/og';
const CONFIDENCE = ['low', 'medium', 'high'];
const PER_Q_BUDGET_MS = 120000; // GMAT Focus pace ≈ 2 min / question

const pad2 = (n) => String(n).padStart(2, '0');
function formatMs(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}
const postJson = (url, body) =>
  fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ---- icons (match the LSAT / AI-curated test surface) ----
const IconBack = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
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

// A multi-select chip row. An empty selection means "no constraint", which the
// label says outright so the user is not left guessing.
function ChipMulti({ label, options, selected, onToggle }) {
  return (
    <div className="og-filter">
      <div className="og-filter-label">{label}<span className="og-filter-hint">{selected.length ? '' : ' · any'}</span></div>
      <div className="og-chip-row">
        {options.map((o) => (
          // A zero-count option is still shown — OG13 contributes no CR at all,
          // and hiding the book would be more confusing than greying it — but it
          // cannot be selected, since choosing it could only empty the set.
          <button
            key={o.label}
            type="button"
            className={`og-chip${selected.includes(o.label) ? ' is-on' : ''}`}
            onClick={() => onToggle(o.label)}
            disabled={o.count === 0}
            title={o.count === 0 ? 'No questions of this kind in the pool' : undefined}
          >
            {o.label}<span className="og-chip-count">{o.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Builder({ onStart, onExit }) {
  const [library, setLibrary] = useState(null);
  const [error, setError] = useState(null);
  const [kind, setKind] = useState('CR');
  const [books, setBooks] = useState([]);
  const [typeLabels, setTypeLabels] = useState([]);
  const [difficulties, setDifficulties] = useState([]);
  const [historyMode, setHistoryMode] = useState('all');
  const [count, setCount] = useState(10);
  const [mode, setMode] = useState('practice');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchJson(`${API}/library`).then(setLibrary).catch((e) => setError(e.message));
  }, []);

  // Switching subject invalidates the type-label selection: the two subjects'
  // label vocabularies do not overlap.
  useEffect(() => { setTypeLabels([]); setPreview(null); }, [kind]);

  const filters = { books, kind, typeLabels, difficulties, historyMode, count: Number(count) || 10 };

  const runPreview = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await postJson(`${API}/build-set`, { filters }));
    } catch (e) {
      setError(e.message);
      setPreview(null);
    }
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [books, kind, typeLabels, difficulties, historyMode, count]);

  const toggle = (setter, list) => (value) =>
    setter(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  async function start() {
    if (!preview || preview.set.actual === 0) return;
    setBusy(true);
    try {
      const label = `OG ${kind} · ${preview.set.actual} questions`;
      const { id } = await postJson(`${API}/sessions`, {
        questionIds: preview.set.questionIds, mode, setLabel: label, filters,
      });
      onStart({ sessionId: id, mode, questions: preview.questions, passages: preview.passages, label });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  if (error && !library) {
    return <div className="lsat-st-shell"><main className="lsat-st-body"><p className="og-error">{error}</p></main></div>;
  }
  if (!library) {
    return <div className="lsat-st-shell"><main className="lsat-st-body"><p className="muted">Loading the question pool…</p></main></div>;
  }

  const lib = library.library;
  return (
    <div className="lsat-st-shell">
      <header className="lsat-st-topbar">
        <div className="lsat-st-topbar-left">
          <button type="button" className="lsat-st-icon-btn" onClick={onExit} aria-label="Exit to GMAT Dashboard" title="Exit"><IconBack /></button>
          <span className="lsat-st-section-label">GMAT OG Book Practice</span>
        </div>
        <div className="lsat-st-topbar-right">
          <span className="lsat-st-set-meta">
            {lib.totals.CR} CR · {lib.totals.RC} RC across {lib.totals.passages} passages · {library.history.attempted} seen, {library.history.wrong} missed
          </span>
        </div>
      </header>

      <main className="lsat-st-body og-builder">
        <div className="og-filter">
          <div className="og-filter-label">Subject</div>
          <div className="og-chip-row">
            {['CR', 'RC'].map((k) => (
              <button key={k} type="button" className={`og-chip${kind === k ? ' is-on' : ''}`} onClick={() => setKind(k)}>
                {k === 'CR' ? 'Critical Reasoning' : 'Reading Comprehension'}<span className="og-chip-count">{lib.totals[k]}</span>
              </button>
            ))}
          </div>
        </div>

        <ChipMulti
          label="Book"
          options={lib.books.map((b) => ({ label: b.code, count: b.counts[kind] }))}
          selected={books}
          onToggle={toggle(setBooks, books)}
        />
        <ChipMulti label="Question type" options={lib.typeLabels[kind]} selected={typeLabels} onToggle={toggle(setTypeLabels, typeLabels)} />
        <ChipMulti label="Difficulty" options={lib.difficulties[kind]} selected={difficulties} onToggle={toggle(setDifficulties, difficulties)} />

        <div className="og-filter">
          <div className="og-filter-label">History</div>
          <div className="og-chip-row">
            {[['all', 'All questions'], ['unseen', 'Unseen only'], ['wrong', 'Previously wrong']].map(([v, l]) => (
              <button key={v} type="button" className={`og-chip${historyMode === v ? ' is-on' : ''}`} onClick={() => setHistoryMode(v)}>{l}</button>
            ))}
          </div>
        </div>

        <div className="og-filter og-filter-row">
          <label className="og-filter-label" htmlFor="og-count">Questions</label>
          <input id="og-count" type="number" min="1" max="50" value={count} onChange={(e) => setCount(e.target.value)} className="og-count-input" />
          <div className="og-chip-row">
            {[['practice', 'Practice · explain as I go'], ['timed', 'Timed · explain at the end']].map(([v, l]) => (
              <button key={v} type="button" className={`og-chip${mode === v ? ' is-on' : ''}`} onClick={() => setMode(v)}>{l}</button>
            ))}
          </div>
        </div>

        <div className="og-builder-actions">
          <button type="button" className="lsat-st-submit" onClick={runPreview} disabled={busy}>Preview set</button>
          {preview && (
            <>
              <span className="og-preview-note">
                {preview.set.actual === 0
                  ? 'No questions match those filters.'
                  : kind === 'RC'
                    ? `${preview.set.actual} questions across ${preview.set.passageCount} whole passages${preview.set.shortfall ? ` — fewer than the ${preview.set.requested} requested; RC is drawn a whole passage at a time.` : ''}`
                    : `${preview.set.actual} questions${preview.set.shortfall ? ` — fewer than the ${preview.set.requested} requested. No filter was relaxed.` : ''}`}
              </span>
              <button type="button" className="lsat-st-submit is-next" onClick={start} disabled={busy || preview.set.actual === 0}>Start<IconNext /></button>
            </>
          )}
        </div>
        {error && <p className="og-error">{error}</p>}
      </main>
    </div>
  );
}

// The book's own answer explanation: a Situation / Reasoning pair and one
// rationale per choice. 100 of the 368 questions are keyed but unenriched, so
// the missing case is normal and says so.
function Explanation({ explanation, correct, picked }) {
  if (!explanation) {
    return <p className="og-explanation-missing">This question is keyed but the book&rsquo;s explanation was not recovered for it.</p>;
  }
  const letters = Object.keys(explanation.choices || {}).sort();
  return (
    <div className="og-explanation">
      {explanation.situation && <p><b>Situation.</b> {explanation.situation}</p>}
      {explanation.reasoning && <p><b>Reasoning.</b> {explanation.reasoning}</p>}
      {letters.map((l) => (
        <p key={l} className={`og-exp-choice${l === correct ? ' is-correct' : ''}${l === picked && l !== correct ? ' is-picked' : ''}`}>
          <b>{l}.</b> {explanation.choices[l]}
        </p>
      ))}
    </div>
  );
}

function Runner({ session, onFinish, onExit }) {
  const { questions, passages, mode, sessionId, label } = session;
  const isTimed = mode === 'timed';
  const passageById = new Map((passages || []).map((p) => [p.id, p]));

  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({});   // id -> { answer, timeSec, confidence, submitted }
  const [feedback, setFeedback] = useState({}); // id -> { isCorrect, correctAnswer, explanation }
  const [paused, setPaused] = useState(false);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState(null);

  const qStartRef = useRef(Date.now());
  const qAccRef = useRef(0);
  const sessStartRef = useRef(Date.now());
  const sessAccRef = useRef(0);

  const q = questions[idx];
  const cur = answers[q.id] || null;
  const submitted = !!cur?.submitted;
  const chosen = cur?.answer || null;
  const fb = feedback[q.id] || null;
  const revealed = !isTimed && submitted && fb;

  // Practice mode holds both clocks while the explanation is on screen; Timed
  // stays continuously timed like the real test.
  const clockStopped = paused || !!revealed;

  const budget = PER_Q_BUDGET_MS * questions.length;
  const elapsed = clockStopped ? sessAccRef.current : (now - sessStartRef.current + sessAccRef.current);
  const remaining = budget - elapsed;
  const over = remaining < 0;
  const absR = Math.abs(remaining);

  const qElapsed = submitted ? (cur.timeSec || 0) * 1000 : (paused ? qAccRef.current : now - qStartRef.current + qAccRef.current);
  const answeredCount = questions.filter((x) => answers[x.id]?.submitted).length;

  useEffect(() => {
    if (clockStopped) return undefined;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [clockStopped]);

  // Bank the running segment when an explanation appears, restart it on leaving.
  useEffect(() => {
    if (paused) return; // the pause button owns accumulation while paused
    if (revealed) sessAccRef.current += Date.now() - sessStartRef.current;
    else sessStartRef.current = Date.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed]);

  useEffect(() => {
    qStartRef.current = Date.now();
    qAccRef.current = (answers[questions[idx].id]?.timeSec || 0) * 1000;
    setNow(Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  useEffect(() => {
    function onKey(e) {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.key === 'ArrowLeft' && idx > 0) setIdx(idx - 1);
      else if (e.key === 'ArrowRight' && idx < questions.length - 1) setIdx(idx + 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [idx, questions.length]);

  const pick = (letter) => {
    if (submitted) return;
    setAnswers((a) => ({ ...a, [q.id]: { ...(a[q.id] || {}), answer: letter } }));
  };
  const toggleConfidence = (lv) => {
    if (submitted) return;
    setAnswers((a) => ({ ...a, [q.id]: { ...(a[q.id] || {}), confidence: a[q.id]?.confidence === lv ? null : lv } }));
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
    if (!chosen || checking) return;
    const ms = paused ? qAccRef.current : Date.now() - qStartRef.current + qAccRef.current;
    const timeSec = Math.round(ms / 1000);
    setChecking(true);
    setError(null);
    try {
      const r = await postJson(`${API}/attempts`, {
        questionId: q.id, userAnswer: chosen, timeMs: ms,
        confidence: answers[q.id]?.confidence || null, sessionId,
      });
      setAnswers((a) => ({ ...a, [q.id]: { ...(a[q.id] || {}), answer: chosen, timeSec, submitted: true } }));
      setFeedback((f) => ({ ...f, [q.id]: { isCorrect: r.isCorrect, correctAnswer: r.correctAnswer, explanation: r.explanation } }));
    } catch (e) {
      setError(e.message); // leave the question unsubmitted so it can be retried
    }
    setChecking(false);
  }

  async function finish() {
    // The attempts are already saved one by one; completing only freezes the
    // session's contents, so a failure here is not worth blocking the review.
    try { await postJson(`${API}/sessions/${sessionId}/complete`, {}); } catch (e) { /* ignore */ }
    onFinish({ questions, answers, feedback });
  }

  const goNext = () => { if (idx < questions.length - 1) setIdx(idx + 1); else finish(); };
  const passage = q.passageId ? passageById.get(q.passageId) : null;

  return (
    <div className="lsat-st-shell">
      <header className="lsat-st-topbar">
        <div className="lsat-st-topbar-left">
          <button type="button" className="lsat-st-icon-btn" onClick={onExit} aria-label="Back to the set builder" title="Back to the set builder"><IconBack /></button>
          <span className="lsat-st-section-label">{label}</span>
        </div>
        <div className="lsat-st-topbar-right">
          <span className="lsat-st-set-meta">{q.bookCode} · {q.typeLabel || q.kind} · {q.difficulty || 'Unrated'} · {isTimed ? 'Timed' : 'Practice'}</span>
          <button type="button" className="lsat-st-finish-btn" onClick={finish} title="End now and review what was answered">End Session</button>
        </div>
      </header>

      <div className="lsat-st-subbar">
        <div className="lsat-st-subbar-left">
          <span className="lsat-st-confidence-label">Confidence:</span>
          {CONFIDENCE.map((lv) => (
            <button key={lv} type="button" className={`lsat-st-confidence-btn${answers[q.id]?.confidence === lv ? ' is-on' : ''}`} onClick={() => toggleConfidence(lv)} disabled={submitted}>{lv}</button>
          ))}
        </div>
        <div className="lsat-st-subbar-right">
          <button type="button" className="lsat-st-icon-btn" onClick={togglePause} title={paused ? 'Resume' : 'Pause'}>{paused ? 'Resume' : 'Pause'}</button>
          <span className={`lsat-st-timer${over ? ' is-over' : ''}`}>
            <IconClock />{over ? '+' : ''}{pad2(Math.floor(absR / 60000))}:{pad2(Math.floor((absR % 60000) / 1000))}
            {over && <span className="lsat-st-overtime-tag">OVER</span>}
          </span>
          <span className="lsat-st-score">{answeredCount}<span className="lsat-st-score-of">/{questions.length}</span></span>
          {!submitted
            ? <button type="button" className="lsat-st-submit" onClick={submit} disabled={!chosen || checking || paused}>{checking ? 'Checking…' : 'Submit'}<IconCheck /></button>
            : <button type="button" className="lsat-st-submit is-next" onClick={goNext}>{idx >= questions.length - 1 ? 'Finish' : 'Next'}<IconNext /></button>}
        </div>
      </div>

      <main className={`lsat-st-body${passage ? ' has-passage' : ''}`}>
        {passage && (
          <section className="lsat-st-passage" aria-label="Passage">
            <div className="lsat-st-passage-marker">{q.bookCode} · page {passage.page}</div>
            <PassageLines lines={passage.lines} text={passage.text} className="lsat-st-passage-body" />
          </section>
        )}
        <section className="lsat-st-question">
          <div className="lsat-st-q-meta">
            <span>Question {idx + 1} of {questions.length}</span>
            <span>{formatMs(qElapsed)}</span>
          </div>
          {q.stemHtml
            ? <div className="lsat-st-stem" dangerouslySetInnerHTML={{ __html: q.stemHtml }} />
            : <div className="lsat-st-stem">{q.stem}</div>}
          <div className="lsat-st-choices" role="radiogroup" aria-label="Answer choices">
            {q.choices.map((c) => {
              const isPick = chosen === c.label;
              const isKey = revealed && fb.correctAnswer === c.label;
              const isWrongPick = revealed && isPick && !fb.isCorrect;
              return (
                <button
                  key={c.label}
                  type="button"
                  role="radio"
                  aria-checked={isPick}
                  className={`lsat-st-choice${isPick ? ' is-picked' : ''}${isKey ? ' is-correct' : ''}${isWrongPick ? ' is-wrong' : ''}`}
                  onClick={() => pick(c.label)}
                  disabled={submitted}
                >
                  <span className="lsat-st-choice-text"><b>{c.label}.</b> {c.text}</span>
                </button>
              );
            })}
          </div>
          {submitted && isTimed && <p className="og-timed-note">Answer saved. Explanations come at the end of the set.</p>}
          {revealed && (
            <>
              <p className={`og-verdict${fb.isCorrect ? ' is-correct' : ' is-wrong'}`}>
                {fb.isCorrect ? 'Correct.' : `Incorrect — the answer is ${fb.correctAnswer}.`}
              </p>
              <Explanation explanation={fb.explanation} correct={fb.correctAnswer} picked={chosen} />
            </>
          )}
          {error && <p className="og-error">{error}</p>}
          <div className="lsat-st-actions">
            <button type="button" onClick={() => setIdx(Math.max(0, idx - 1))} disabled={idx === 0} className="lsat-st-link-btn">Previous</button>
            <button type="button" onClick={() => setIdx(Math.min(questions.length - 1, idx + 1))} disabled={idx >= questions.length - 1} className="lsat-st-link-btn">Next</button>
          </div>
        </section>
      </main>
    </div>
  );
}

// End-of-set review. In Timed mode this is the first place the keys and the
// book's explanations appear.
function Summary({ result, onAgain, onExit }) {
  const { questions, answers, feedback } = result;
  const answered = questions.filter((q) => answers[q.id]?.submitted);
  const correct = answered.filter((q) => feedback[q.id]?.isCorrect).length;
  const [openId, setOpenId] = useState(null);

  return (
    <div className="lsat-st-shell">
      <header className="lsat-st-topbar">
        <div className="lsat-st-topbar-left">
          <button type="button" className="lsat-st-icon-btn" onClick={onExit} aria-label="Exit to GMAT Dashboard" title="Exit"><IconBack /></button>
          <span className="lsat-st-section-label">Set review</span>
        </div>
        <div className="lsat-st-topbar-right">
          <span className="lsat-st-set-meta">
            {correct}/{answered.length} correct{answered.length < questions.length ? ` · ${questions.length - answered.length} unanswered` : ''}
          </span>
          <button type="button" className="lsat-st-finish-btn" onClick={onAgain}>Build another set</button>
        </div>
      </header>
      <main className="lsat-st-body og-summary">
        {questions.map((q, i) => {
          const a = answers[q.id];
          const f = feedback[q.id];
          const open = openId === q.id;
          return (
            <div key={q.id} className={`og-summary-row${f ? (f.isCorrect ? ' is-correct' : ' is-wrong') : ''}`}>
              <button type="button" className="og-summary-head" onClick={() => setOpenId(open ? null : q.id)}>
                <span className="og-summary-n">{i + 1}</span>
                <span className="og-summary-stem">{(q.stem || '').slice(0, 110)}…</span>
                <span className="og-summary-verdict">
                  {!a?.submitted ? 'skipped' : f ? `${a.answer} / ${f.correctAnswer}` : a.answer}
                </span>
                <span className="og-summary-time">{formatMs((a?.timeSec || 0) * 1000)}</span>
              </button>
              {open && (
                <div className="og-summary-detail">
                  <div className="lsat-st-stem">{q.stem}</div>
                  {q.choices.map((c) => (
                    <p key={c.label} className={`og-exp-choice${f && c.label === f.correctAnswer ? ' is-correct' : ''}${a?.answer === c.label && f && !f.isCorrect ? ' is-picked' : ''}`}>
                      <b>{c.label}.</b> {c.text}
                    </p>
                  ))}
                  {f && <Explanation explanation={f.explanation} correct={f.correctAnswer} picked={a?.answer} />}
                </div>
              )}
            </div>
          );
        })}
      </main>
    </div>
  );
}

export default function GmatOgPractice({ onExit }) {
  const [session, setSession] = useState(null);
  const [result, setResult] = useState(null);

  if (result) {
    return <Summary result={result} onAgain={() => { setResult(null); setSession(null); }} onExit={onExit} />;
  }
  if (session) {
    return <Runner session={session} onFinish={setResult} onExit={() => setSession(null)} />;
  }
  return <Builder onStart={setSession} onExit={onExit} />;
}
