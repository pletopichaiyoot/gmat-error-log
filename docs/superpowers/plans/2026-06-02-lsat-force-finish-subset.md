# LSAT Force-Finish Replayable Subset — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user finish an LSAT practice session early via a top-bar button, record only the answered questions as the session, and replay that exact subset from Session History.

**Architecture:** A session's answered questions are its attempts. On completion (force or natural), the server freezes the answered question numbers onto the session (`lsat_sessions.question_numbers`, JSON). The Library still practices full sections; Session History "Retake" rebuilds a set filtered to the frozen numbers and starts a new subset session. The question UI is subset-agnostic — it renders whatever `set.questions` it receives.

**Tech Stack:** Node + Express + raw sqlite3 (`src/db.js`, `src/server.js`); React (`client/src/LsatPractice.jsx`); plain CSS (`client/src/styles.css`).

> **Testing note (read first):** This repo has **no automated test suite** (`CLAUDE.md`: "No tests"). Per the project's actual conventions, each task is verified with **runnable checks**: `npm run lint` (must stay at 0 errors), `curl` against the dev API on `127.0.0.1:4310`, and browser checks against the dev web app on `localhost:5173`. Do **not** scaffold Vitest/Jest — that's out of scope. Assume `npm run dev` is running (API on 4310, web on 5173); the backend re-runs its `ALTER TABLE` migrations on restart.

---

## File Structure

- `src/db.js` — add `question_numbers` column + migration; freeze on complete; accept `questionNumbers` on create; parse JSON on read. (DB access layer — all SQLite lives here.)
- `src/server.js` — pass `questionNumbers` through the create route; return `answeredCount` from the complete route. (HTTP layer.)
- `client/src/LsatPractice.jsx` — Finish button + confirm dialog in `SessionView`; subset-aware `buildSetForSection`, `ConfirmationScreen`, parent routing, History retake, Summary filtering. (Entire LSAT UI lives in this one file, per existing convention.)
- `client/src/styles.css` — styles for the Finish button and confirm overlay.

---

## Task 1: DB column + parse `question_numbers` on read

**Files:**
- Modify: `src/db.js` (migration block ~line 369; `listLsatSessions` ~476; `getLsatSession` ~485)

- [ ] **Step 1: Back up the live DB before the migration runs**

Run:
```bash
cp data/gmat-error-log.db "data/gmat-error-log.db.bak-question-numbers-$(date +%Y%m%d-%H%M%S)"
```
Expected: a new `.bak-question-numbers-*` file appears (matches the repo's backup convention).

- [ ] **Step 2: Add the column migration**

In `src/db.js`, find the `lsat_sessions` migration line:
```js
  try { await run('ALTER TABLE lsat_sessions ADD COLUMN mode TEXT'); } catch (e) { /* exists */ }
```
Add directly below it:
```js
  try { await run('ALTER TABLE lsat_sessions ADD COLUMN question_numbers TEXT'); } catch (e) { /* exists */ }
```

- [ ] **Step 3: Add a row-parsing helper and use it in both read functions**

In `src/db.js`, immediately above `async function listLsatSessions`, add:
```js
// lsat_sessions.question_numbers is stored as a JSON array string (or NULL for
// full-section sessions). Parse it back to an array (or null) for callers.
function parseLsatSessionRow(row) {
  if (!row) return row;
  let questionNumbers = null;
  if (row.question_numbers) {
    try { questionNumbers = JSON.parse(row.question_numbers); } catch (e) { questionNumbers = null; }
  }
  return { ...row, question_numbers: questionNumbers };
}
```
Change `listLsatSessions`'s return line from:
```js
  return await all(`SELECT * FROM lsat_sessions ${whereSql} ORDER BY started_at DESC`, params);
```
to:
```js
  const rows = await all(`SELECT * FROM lsat_sessions ${whereSql} ORDER BY started_at DESC`, params);
  return rows.map(parseLsatSessionRow);
```
Change `getLsatSession` from:
```js
  return await get('SELECT * FROM lsat_sessions WHERE id = ?', [id]);
```
to:
```js
  return parseLsatSessionRow(await get('SELECT * FROM lsat_sessions WHERE id = ?', [id]));
```

- [ ] **Step 4: Restart the API and verify the column exists and parses**

Restart the API (e.g. re-run `npm run dev:api`, or let nodemon restart), then run:
```bash
curl -s 'http://127.0.0.1:4310/api/lsat/sessions' | python3 -m json.tool | head -30
```
Expected: each session object includes a `"question_numbers": null` field (existing rows are null), and no 500 error.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/db.js
git commit -m "feat(lsat): add question_numbers column + parse on read"
```
Expected: lint reports 0 errors.

---

## Task 2: Freeze answered question numbers on complete

**Files:**
- Modify: `src/db.js` (`completeLsatSession` ~line 472)

- [ ] **Step 1: Rewrite `completeLsatSession` to freeze answered numbers**

Replace:
```js
async function completeLsatSession(id) {
  await run(`UPDATE lsat_sessions SET completed_at = datetime('now') WHERE id = ?`, [id]);
}
```
with:
```js
async function completeLsatSession(id) {
  // A session's answered questions are its attempts. Freeze them as the session's
  // subset so History can replay exactly what was answered. This overwrites any
  // creation-time question_numbers with the actually-answered set.
  const rows = await all(
    'SELECT DISTINCT question_number FROM lsat_attempts WHERE session_id = ? ORDER BY question_number',
    [id]
  );
  const numbers = rows.map((r) => r.question_number);
  await run(
    `UPDATE lsat_sessions SET completed_at = datetime('now'), question_numbers = ? WHERE id = ?`,
    [JSON.stringify(numbers), id]
  );
  return { answeredCount: numbers.length };
}
```

- [ ] **Step 2: Verify against a real session via the API**

Pick an existing session id that has attempts:
```bash
curl -s 'http://127.0.0.1:4310/api/lsat/sessions' | python3 -c "import sys,json; s=json.load(sys.stdin)['sessions']; print([(x['id']) for x in s][:5])"
```
Call complete on one of those ids (replace `<ID>`), then re-read it:
```bash
curl -s -X POST 'http://127.0.0.1:4310/api/lsat/sessions/<ID>/complete'
curl -s 'http://127.0.0.1:4310/api/lsat/sessions/<ID>' | python3 -m json.tool
```
Expected: the complete call returns `{"ok": true, "answeredCount": N}` (after Task 3 wires the response; for now it returns `{"ok": true}`), and the session now has `"question_numbers": [ ... ]` matching its answered questions, with `completed_at` set.

- [ ] **Step 3: Commit**

```bash
git add src/db.js
git commit -m "feat(lsat): freeze answered question numbers on session complete"
```

---

## Task 3: `createLsatSession` accepts `questionNumbers`; routes wired

**Files:**
- Modify: `src/db.js` (`createLsatSession` ~line 463)
- Modify: `src/server.js` (`POST /api/lsat/sessions` ~1404; `POST /api/lsat/sessions/:id/complete` ~1431)

- [ ] **Step 1: Extend `createLsatSession` to store an optional subset**

Replace:
```js
async function createLsatSession({ testNum, sectionRoman, sectionKind, setKey, setLabel, firstQuestion, lastQuestion, mode }) {
  const result = await run(
    `INSERT INTO lsat_sessions (test_num, section_roman, section_kind, set_key, set_label, first_question, last_question, mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [testNum, sectionRoman, sectionKind, setKey, setLabel || null, firstQuestion, lastQuestion, mode || null]
  );
  return { id: result.lastID };
}
```
with:
```js
async function createLsatSession({ testNum, sectionRoman, sectionKind, setKey, setLabel, firstQuestion, lastQuestion, mode, questionNumbers }) {
  const qn = Array.isArray(questionNumbers) && questionNumbers.length
    ? JSON.stringify([...questionNumbers].sort((a, b) => a - b))
    : null;
  const result = await run(
    `INSERT INTO lsat_sessions (test_num, section_roman, section_kind, set_key, set_label, first_question, last_question, mode, question_numbers)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [testNum, sectionRoman, sectionKind, setKey, setLabel || null, firstQuestion, lastQuestion, mode || null, qn]
  );
  return { id: result.lastID };
}
```

- [ ] **Step 2: Pass `questionNumbers` through the create route**

In `src/server.js`, in `app.post('/api/lsat/sessions', ...)`, change the destructure:
```js
    const { testNum, sectionRoman, setKey, setLabel, firstQuestion, lastQuestion, mode } = req.body || {};
```
to:
```js
    const { testNum, sectionRoman, setKey, setLabel, firstQuestion, lastQuestion, mode, questionNumbers } = req.body || {};
```
And in the same handler, change the `createLsatSession({ ... })` call to add the field — find:
```js
      mode: mode || 'exam',
    });
```
and change to:
```js
      mode: mode || 'exam',
      questionNumbers: Array.isArray(questionNumbers)
        ? questionNumbers.map(Number).filter((n) => Number.isInteger(n))
        : null,
    });
```

- [ ] **Step 3: Return `answeredCount` from the complete route**

In `src/server.js`, replace:
```js
app.post('/api/lsat/sessions/:id/complete', async (req, res) => {
  try {
    await completeLsatSession(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```
with:
```js
app.post('/api/lsat/sessions/:id/complete', async (req, res) => {
  try {
    const result = await completeLsatSession(Number(req.params.id));
    res.json({ ok: true, answeredCount: result?.answeredCount ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Verify create-with-subset round-trips**

Create a subset session (use a real test/section, e.g. testNum 1, section I):
```bash
curl -s -X POST 'http://127.0.0.1:4310/api/lsat/sessions' \
  -H 'Content-Type: application/json' \
  -d '{"testNum":1,"sectionRoman":"I","setKey":"I:sub","setLabel":"probe","firstQuestion":2,"lastQuestion":5,"mode":"exam","questionNumbers":[5,2]}' | python3 -m json.tool
```
Note the returned `id`, then:
```bash
curl -s 'http://127.0.0.1:4310/api/lsat/sessions/<ID>' | python3 -c "import sys,json; print(json.load(sys.stdin)['session']['question_numbers'])"
```
Expected: prints `[2, 5]` (sorted). Clean up the probe row if desired (optional).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/db.js src/server.js
git commit -m "feat(lsat): create sessions with an explicit question subset; return answeredCount"
```

---

## Task 4: Finish button + confirm dialog in `SessionView`

**Files:**
- Modify: `client/src/LsatPractice.jsx` (`SessionView` — state ~595; header ~796; end of shell return)

- [ ] **Step 1: Add confirm-dialog state**

In `SessionView`, alongside the other `useState` calls (near line 597), add:
```js
  const [showFinishConfirm, setShowFinishConfirm] = useState(false);
```

- [ ] **Step 2: Add the Finish button to the top bar**

In `SessionView`'s header, find the `topbar-right` block:
```jsx
        <div className="lsat-st-topbar-right">
          <span className="lsat-st-set-meta">
            PrepTest {selectedTestNum} · {section.kind} · Section {section.roman}
          </span>
        </div>
```
Replace it with:
```jsx
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
```

- [ ] **Step 3: Add the confirm overlay**

In `SessionView`'s returned JSX, find the closing of the shell. The component returns `<div className="lsat-st-shell"> … </div>`. Immediately before that final closing `</div>` (after the `<main>` block ends), add:
```jsx
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
```
(`sessionScore`, `submitted`, `pickedLetter`, and `onComplete` are all already in scope in `SessionView`.)

- [ ] **Step 4: Verify in the browser**

In the running app (`localhost:5173/#lsat`): start a section, answer 1–2 questions (Submit each), then click **Finish** in the top bar.
Expected: dialog shows "You've answered N of M…"; "Keep going" closes it; "Finish & review" goes to the Summary. Starting a fresh session and clicking Finish with 0 answered shows the "Answer at least one question" message and a disabled confirm button.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add client/src/LsatPractice.jsx
git commit -m "feat(lsat): add top-bar Finish button + confirm dialog to session view"
```

---

## Task 5: Subset-aware `buildSetForSection` + `ConfirmationScreen`

**Files:**
- Modify: `client/src/LsatPractice.jsx` (`buildSetForSection` ~line 48; `ConfirmationScreen` ~450)

- [ ] **Step 1: Extend `buildSetForSection` to optionally filter to a subset**

Replace:
```js
function buildSetForSection(section) {
  if (!section || !section.questions?.length) return null;
  return {
    key: `${section.roman}:all`,
    label: `${section.kind} · Section ${section.roman}`,
    firstQuestion: section.questions[0].number,
    lastQuestion: section.questions[section.questions.length - 1].number,
    questions: section.questions,
  };
}
```
with:
```js
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
```

- [ ] **Step 2: Make `ConfirmationScreen` accept and display a subset**

Change the signature:
```js
function ConfirmationScreen({ testNum, sectionRoman, onStart, onCancel }) {
```
to:
```js
function ConfirmationScreen({ testNum, sectionRoman, subset, onStart, onCancel }) {
```
After the existing `const totalQ = section?.questions.length || 0;` line, add:
```js
  const isSubset = Array.isArray(subset) && subset.length > 0;
  const displayCount = isSubset ? subset.length : totalQ;
```

- [ ] **Step 3: Use `displayCount` in the meta line, budget, and Questions row**

In `ConfirmationScreen`'s JSX, change the meta line:
```jsx
                  PrepTest {testNum} · Section {section.roman} · {totalQ} questions
                  {passages ? ` · ${passages} passages` : ''}
```
to:
```jsx
                  PrepTest {testNum} · Section {section.roman} · {displayCount} questions
                  {passages && !isSubset ? ` · ${passages} passages` : ''}
                  {isSubset ? ' · review subset' : ''}
```
Change the time-budget value:
```jsx
                <strong>{formatBudgetMs(sectionBudgetMs(totalQ))}</strong>
```
to:
```jsx
                <strong>{formatBudgetMs(sectionBudgetMs(displayCount))}</strong>
```
Change the Questions row value:
```jsx
                <span>Questions</span>
                <strong>{totalQ}</strong>
```
to:
```jsx
                <span>Questions</span>
                <strong>{displayCount}</strong>
```

- [ ] **Step 4: Lint (UI wiring verified in Task 6)**

```bash
npm run lint
git add client/src/LsatPractice.jsx
git commit -m "feat(lsat): subset-aware set builder and confirmation screen"
```
Expected: 0 lint errors. (`subset` is not yet passed in — wired in Task 6.)

---

## Task 6: Parent routing — start subset sessions + History/Summary retake

**Files:**
- Modify: `client/src/LsatPractice.jsx` (`LsatPractice` root ~1056; `LsatSessionsView` retake button ~314)

- [ ] **Step 1: Carry an optional subset through `handlePickSection`**

In `LsatPractice`, replace:
```js
  function handlePickSection(testNum, sectionRoman) {
    setPendingPick({ testNum, sectionRoman });
    setView('confirm');
  }
```
with:
```js
  function handlePickSection(testNum, sectionRoman, questionNumbers = null) {
    setPendingPick({ testNum, sectionRoman, questionNumbers: questionNumbers || null });
    setView('confirm');
  }
```

- [ ] **Step 2: Build the subset set and pass `questionNumbers` on create**

In `handleStartSession`, replace:
```js
    const { testNum, sectionRoman } = pendingPick;
    try {
      const secResp = await fetchJson(`/api/lsat/tests/${testNum}/sections/${sectionRoman}`);
      const set = buildSetForSection(secResp.section);
      if (!set) { alert('No questions in this section'); return; }
```
with:
```js
    const { testNum, sectionRoman, questionNumbers } = pendingPick;
    try {
      const secResp = await fetchJson(`/api/lsat/tests/${testNum}/sections/${sectionRoman}`);
      const set = buildSetForSection(secResp.section, questionNumbers);
      if (!set) { alert('No questions in this section'); return; }
```
And in the same function's POST body, find:
```js
          firstQuestion: set.firstQuestion,
          lastQuestion: set.lastQuestion,
          mode,
        }),
```
and change to:
```js
          firstQuestion: set.firstQuestion,
          lastQuestion: set.lastQuestion,
          mode,
          questionNumbers: set.questionNumbers,
        }),
```

- [ ] **Step 3: Pass `subset` into the `ConfirmationScreen` render**

Replace:
```jsx
      <ConfirmationScreen
        testNum={pendingPick.testNum}
        sectionRoman={pendingPick.sectionRoman}
        onStart={handleStartSession}
        onCancel={handleBackToLibrary}
      />
```
with:
```jsx
      <ConfirmationScreen
        testNum={pendingPick.testNum}
        sectionRoman={pendingPick.sectionRoman}
        subset={pendingPick.questionNumbers}
        onStart={handleStartSession}
        onCancel={handleBackToLibrary}
      />
```

- [ ] **Step 4: Make Summary "Retake" replay the frozen subset**

Replace:
```js
  async function handleRetake() {
    if (!activeSession) return;
    const { testNum, section } = activeSession;
    handlePickSection(testNum, section.roman);
  }
```
with:
```js
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
```

- [ ] **Step 5: Make History "Retake" replay that session's frozen subset**

In `LsatSessionsView`, find the row button (it currently calls `onPickSection(s.test_num, s.section_roman)`):
```jsx
                  <button type="button" className="lsat-sess-btn" onClick={() => onPickSection(s.test_num, s.section_roman)}>
```
Change to:
```jsx
                  <button type="button" className="lsat-sess-btn" onClick={() => onPickSection(s.test_num, s.section_roman, s.question_numbers || null)}>
```

- [ ] **Step 6: Verify the full subset round-trip in the browser**

In the running app:
1. Start a section, answer 3 questions (e.g. Q2, Q5, Q9 via the navigator), click **Finish → Finish & review**. Summary shows those 3.
2. Go to **Sessions**. The new row reads "3 questions" (verified fully in Task 7) and is "Completed".
3. Click **Retake** on it → ConfirmationScreen shows "3 questions · review subset" → Start → the session shows only those 3 questions in the navigator and the score `/3`.

Expected: replay contains exactly the answered subset; RC questions show their correct passages.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add client/src/LsatPractice.jsx
git commit -m "feat(lsat): start subset sessions and replay them from history/summary"
```

---

## Task 7: Session History denominator reflects the subset

**Files:**
- Modify: `client/src/LsatPractice.jsx` (`LsatSessionsView` map body ~line 311)

- [ ] **Step 1: Compute `total` from the frozen subset when present**

Replace:
```js
              const total = s.last_question - s.first_question + 1;
```
with:
```js
              const total = Array.isArray(s.question_numbers) && s.question_numbers.length
                ? s.question_numbers.length
                : (s.last_question - s.first_question + 1);
```

- [ ] **Step 2: Verify in the browser**

Reload **Sessions**. A force-finished partial session now reads e.g. "3/3 answered · 67%" (or "2/3" if one was wrong) instead of "3/28". Full sessions are unchanged.

- [ ] **Step 3: Lint and commit**

```bash
npm run lint
git add client/src/LsatPractice.jsx
git commit -m "feat(lsat): session history shows answered-subset denominator"
```

---

## Task 8: Summary shows only answered questions

**Files:**
- Modify: `client/src/LsatPractice.jsx` (`SessionSummary` ~line 987)

- [ ] **Step 1: Filter summary rows to answered questions and guard accuracy**

Replace:
```js
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
```
with:
```js
  const stats = useMemo(() => {
    let correct = 0, totalTime = 0;
    // Only questions actually answered count toward this session.
    const rows = set.questions
      .map((q) => ({ q, attempt: attempts[`${sectionRoman}:${q.number}`] }))
      .filter((r) => r.attempt);
    for (const { attempt } of rows) {
      if (attempt.is_correct) correct++;
      if (attempt.time_ms) totalTime += attempt.time_ms;
    }
    return { rows, correct, total: rows.length, totalTime };
  }, [set, attempts, sectionRoman]);
  const accuracy = stats.total ? Math.round((stats.correct / stats.total) * 100) : 0;
  const avgTime = stats.totalTime ? stats.totalTime / Math.max(1, stats.total) : 0;
```

- [ ] **Step 2: Make the retake button label reflect the answered count**

Replace:
```jsx
          <button type="button" className="lsat-st-submit" onClick={onRetake}>
            Retake this set
```
with:
```jsx
          <button type="button" className="lsat-st-submit" onClick={onRetake}>
            {stats.total === set.questions.length ? 'Retake this set' : `Retake these ${stats.total}`}
```

- [ ] **Step 3: Verify in the browser**

Finish a session having answered only some questions. The Summary table lists only the answered questions, the headline reads `correct/answered` (e.g. "2/3"), and the button reads "Retake these 3".

- [ ] **Step 4: Lint and commit**

```bash
npm run lint
git add client/src/LsatPractice.jsx
git commit -m "feat(lsat): summary counts only answered questions"
```

---

## Task 9: Styles for the Finish button and confirm dialog

**Files:**
- Modify: `client/src/styles.css` (append near the other `.lsat-st-*` rules, e.g. after the `.lsat-st-choice` block)

- [ ] **Step 1: Add the styles**

Append to `client/src/styles.css`:
```css
/* ===== LSAT: force-finish button + confirm dialog ===== */
.lsat-st-finish-btn {
  min-height: 0;
  margin-left: 12px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--st-teal);
  background: transparent;
  border: 1px solid var(--st-teal);
  border-radius: 4px;
  cursor: pointer;
  transition: background var(--t) var(--ease), color var(--t) var(--ease);
}
.lsat-st-finish-btn:hover { background: var(--st-teal); color: #fff; }

.lsat-finish-overlay {
  position: fixed;
  inset: 0;
  background: rgba(20, 30, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.lsat-finish-card {
  background: #fff;
  border-radius: 10px;
  padding: 24px 26px;
  max-width: 440px;
  width: calc(100% - 48px);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
}
.lsat-finish-title { margin: 0 0 10px; font-size: 18px; color: var(--st-text); }
.lsat-finish-body { margin: 0 0 20px; font-size: 14px; line-height: 1.55; color: var(--st-text); }
.lsat-finish-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
}
```

- [ ] **Step 2: Verify the dialog styling**

Reload the app, open the Finish dialog. Expected: a centered modal card over a dimmed backdrop; the top-bar Finish button is an outlined teal pill that fills on hover; the disabled confirm button (0 answered) is visibly inactive.

- [ ] **Step 3: Lint and commit**

```bash
npm run lint
git add client/src/styles.css
git commit -m "style(lsat): finish button and confirm dialog"
```

---

## Final Verification

- [ ] **End-to-end pass** in the browser (`localhost:5173/#lsat`):
  1. Library → start a full RC section → answer 3 non-contiguous questions → **Finish** → confirm. Summary shows 3 answered.
  2. Sessions → row reads "3/3 answered" + "Completed". **Retake** → ConfirmationScreen says "3 questions · review subset" → Start → only those 3 appear; finish again; a new 3-question session is recorded.
  3. Start another full section, answer all, finish via the last-question **Finish** button → Summary and history both show the full count (no regression).
  4. Library "Start/Continue/Retake" still loads the full section (no regression).
- [ ] `npm run lint` → 0 errors.
- [ ] Confirm a DB backup exists from Task 1.
