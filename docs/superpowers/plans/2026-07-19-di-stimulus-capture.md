# DI Stimulus Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture DI question stimulus (svg charts, itdmedia chart images, data tables, MSR source passages) during StartTest Phase 2 so it can be viewed in the review modal and read by the AI coach.

**Architecture:** One unified capture pass in `readReviewFrame` collects the rendered stimulus region (review mode already flattens GI/TA/TPA/MSR — no tab-walking). SVG is serialized inline; `itdmedia` `<img>`s are element-screenshotted to `data:` PNGs in the Node side of the same function; tables and MSR reference sections are kept as sanitized HTML. The result is stored as a JSON `stimulus` column on `question_attempts`, preserved across Phase-1 rescrapes, rendered in the review modal through a dedicated sanitizer, and fed to the coach as `dataText`.

**Tech Stack:** Node (CommonJS backend), Playwright (CDP), PostgreSQL (raw SQL + numbered migrations), React (ESM frontend), `node:test`.

## Global Constraints

- **Scope: StartTest only.** Do not touch GMAT Club / CAT / TTP / OPE / LSAT paths.
- **JSON stored as text** (repo convention — no jsonb). `toPg` rewrites `?`→`$n`, so **no literal `?`** in any SQL string.
- **Never call `browser.close()`** in any StartTest path.
- **Schema changes go in a new numbered migration** — never `CREATE`/`ALTER` in `initDb()`.
- **Clobber rule:** any Phase-2-only column MUST be added to `buildAttemptSnapshotIndex` + the insert fallback in `saveScrapeResult`, or a Phase-1 rescrape wipes it.
- **Two sanitizers:** Node-side (`src/scrapers/ope-stem.js`, CJS) sanitizes before storage; client-side (`client/src/App.jsx`, ESM) sanitizes before `dangerouslySetInnerHTML`. Both must be updated for stimulus.
- **Tests:** `node:test` files under `test/unit/`, run with `node --test "test/unit/*.test.js"`. New test-file globals need a file-local `/* global require */`.
- Lint: `npx eslint <files>` — new code adds 0 errors.

---

## File Structure

- `migrations/0003_question_stimulus.sql` — **create** — adds `stimulus` text column.
- `src/scrapers/ope-stem.js` — **modify** — add `sanitizeStimulusHtml` (svg/table-aware) + export.
- `src/scrapers/starttest_scraper.js` — **modify** — `readReviewFrame`: extract stimulus region, screenshot itdmedia imgs, build `stimulus` object; return it on the item.
- `src/db.js` — **modify** — `normalizeStimulusForStorage`, snapshot + insert preservation, `enrichSessionAttempts` writes `stimulus`, `getSessionAnalysis` SELECT includes `stimulus`.
- `client/src/App.jsx` — **modify** — add client `sanitizeStimulusHtml` + a Stimulus block in the question-review modal.
- `client/src/styles.css` — **modify** — `.question-stimulus` styles.
- `src/llm-coach-agent.js` — **modify** — add `stimulusData` to `get_session_detail` question map.
- Tests: `test/unit/stimulus-preserve.test.js`, `test/unit/stimulus-sanitize.test.js`.

---

## Task 1: Migration — `stimulus` column

**Files:**
- Create: `migrations/0003_question_stimulus.sql`

**Interfaces:**
- Produces: `question_attempts.stimulus` (text, nullable).

- [ ] **Step 1: Write the migration**

Create `migrations/0003_question_stimulus.sql`:

```sql
-- Phase-2 DI stimulus (svg charts, screenshot chart images, tables, MSR sources)
-- stored as a JSON string. Nullable; only DI Phase-2 rows populate it.
ALTER TABLE question_attempts ADD COLUMN IF NOT EXISTS stimulus text;
```

- [ ] **Step 2: Apply and verify**

Run: `npm run db:migrate && docker exec gmat-pg psql -U postgres -d gmat -c "\d question_attempts" | grep stimulus`
Expected: a `stimulus | text` row printed.

- [ ] **Step 3: Commit**

```bash
git add migrations/0003_question_stimulus.sql
git commit -m "feat(db): add question_attempts.stimulus column (migration 0003)"
```

---

## Task 2: DB preservation — snapshot + insert fallback

Prevents a Phase-1 rescrape from wiping `stimulus` (the exact clobber bug fixed earlier for `my_answer`).

**Files:**
- Modify: `src/db.js` (`buildAttemptSnapshotIndex` ~line 715; `scoreAttemptSnapshot` ~line 682; the attempt insert ~line 1050; `QUESTION_ATTEMPT_INSERT_COLUMNS`)
- Test: `test/unit/stimulus-preserve.test.js`

**Interfaces:**
- Consumes: exported `buildAttemptSnapshotIndex`, `pickAttemptSnapshot` (already exported).
- Produces: snapshots carry `stimulus`; inserts fall back to `preservedSnapshot?.stimulus`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/stimulus-preserve.test.js`:

```javascript
'use strict';
/* global require */
const test = require('node:test');
const assert = require('node:assert');
const { buildAttemptSnapshotIndex, pickAttemptSnapshot } = require('../../src/db.js');

test('snapshot preserves stimulus across a Phase-1 rescrape', () => {
  const existing = [{ q_id: '161326-seq-1', stimulus: '{"kind":"msr","html":"<svg></svg>","dataText":"x"}' }];
  const index = buildAttemptSnapshotIndex(existing);
  const fresh = { q_id: '161326-seq-1', stimulus: null };
  const snap = pickAttemptSnapshot(index, fresh);
  assert.ok(snap, 'snapshot found by q_id');
  assert.strictEqual(snap.stimulus, '{"kind":"msr","html":"<svg></svg>","dataText":"x"}');
  assert.strictEqual(fresh.stimulus || snap.stimulus || null, existing[0].stimulus);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "test/unit/stimulus-preserve.test.js"`
Expected: FAIL — `snap.stimulus` is `undefined` (snapshot doesn't capture it yet).

- [ ] **Step 3: Add `stimulus` to the snapshot object**

In `src/db.js`, `buildAttemptSnapshotIndex` — inside the `const snapshot = { ... }` literal (after the `difficulty_theta:` line, alongside the `my_answer`/`confidence` block added earlier), add:

```javascript
      // Phase-2 DI stimulus (charts/tables/MSR sources) — Phase 1 never supplies
      // it, so preserve across rescrapes exactly like question_stem_html.
      stimulus: normalizedTextOrNull(row?.stimulus),
```

- [ ] **Step 4: Score the snapshot field (tie-break richness)**

In `scoreAttemptSnapshot`, add after the `answer_choices` line:

```javascript
  if (snapshot.stimulus) score += 2;
```

- [ ] **Step 5: Add the insert fallback**

In `saveScrapeResult`, find where the attempt values array is built (the `attemptValues` list, ~line 1017-1054). Locate the `passageText` value line and add a `stimulus` value using the same fallback pattern. The insert column list `QUESTION_ATTEMPT_INSERT_COLUMNS` must also gain `'stimulus'` **in the same position**. Add, right after the `taxonomy_path` entry in both the column list and the values array:

Column list (`QUESTION_ATTEMPT_INSERT_COLUMNS`, add `'stimulus'` as the last element):
```javascript
  'stimulus',
```

Values array (append as the last element, matching order):
```javascript
          normalizeStimulusForStorage(q.stimulus) || preservedSnapshot?.stimulus || null,
```

(`normalizeStimulusForStorage` is added in Task 5 Step 3; for this task, temporarily use `normalizedTextOrNull(q.stimulus)` so the file stays runnable, then swap to `normalizeStimulusForStorage` in Task 5.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test "test/unit/stimulus-preserve.test.js"`
Expected: PASS.

- [ ] **Step 7: Full suite + lint**

Run: `npm test && npx eslint src/db.js test/unit/stimulus-preserve.test.js`
Expected: all pass, 0 eslint errors.

- [ ] **Step 8: Commit**

```bash
git add src/db.js test/unit/stimulus-preserve.test.js
git commit -m "feat(db): preserve stimulus across Phase 1 rescrapes"
```

---

## Task 3: Node-side stimulus sanitizer

A dedicated sanitizer (separate from the tiny math `sanitizeStemHtml`) that keeps `svg` (and its shape children), `table` structure, and `data:` images, while stripping scripts, event handlers, and external `src`/`href`.

**Files:**
- Modify: `src/scrapers/ope-stem.js` (add function + export at the `module.exports` on line ~102)
- Test: `test/unit/stimulus-sanitize.test.js`

**Interfaces:**
- Produces: `sanitizeStimulusHtml(rawHtml: string): string` — exported from `ope-stem.js`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/stimulus-sanitize.test.js`:

```javascript
'use strict';
/* global require */
const test = require('node:test');
const assert = require('node:assert');
const { sanitizeStimulusHtml } = require('../../src/scrapers/ope-stem.js');

test('keeps svg, table, and data: images', () => {
  const out = sanitizeStimulusHtml('<div><svg><rect x="1"/></svg><table><tr><td>2.0</td></tr></table><img src="data:image/png;base64,AAA"></div>');
  assert.ok(out.includes('<svg'), 'svg kept');
  assert.ok(out.includes('<table'), 'table kept');
  assert.ok(out.includes('data:image/png'), 'data image kept');
});

test('strips scripts, event handlers, and external src', () => {
  const out = sanitizeStimulusHtml('<svg onload="alert(1)"><script>x()</script></svg><img src="https://evil/x.png">');
  assert.ok(!/onload/i.test(out), 'onload stripped');
  assert.ok(!/<script/i.test(out), 'script stripped');
  assert.ok(!/https:\/\/evil/.test(out), 'external src stripped');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "test/unit/stimulus-sanitize.test.js"`
Expected: FAIL — `sanitizeStimulusHtml is not a function`.

- [ ] **Step 3: Implement the sanitizer**

In `src/scrapers/ope-stem.js`, add before `module.exports`:

```javascript
// Allowlist for DI stimulus: prose + tables + inline SVG shapes + data: images.
const STIMULUS_ALLOWED_TAGS = new Set([
  'p', 'br', 'b', 'strong', 'i', 'em', 'sup', 'sub', 'span', 'div', 'h1', 'h2', 'h3', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'title', 'desc',
  'img',
]);
// SVG geometry/label attributes worth keeping; anything else is dropped.
const STIMULUS_ALLOWED_ATTRS = new Set([
  'class', 'colspan', 'rowspan', 'scope', 'aria-rowcount', 'border', 'style',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height',
  'd', 'points', 'transform', 'viewBox', 'fill', 'stroke', 'stroke-width', 'text-anchor', 'font-size', 'dominant-baseline',
]);

function sanitizeStimulusHtml(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let html = raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  // Drop <img> whose src is not a data: image entirely.
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = (tag.match(/\bsrc\s*=\s*"([^"]*)"/i) || [])[1] || '';
    return /^data:image\//i.test(src) ? `<img src="${escapeAttr(src)}">` : '';
  });
  // Walk every remaining tag: drop disallowed tags; on allowed tags, keep only
  // allowed attributes and never keep on*-handlers or javascript: urls.
  html = html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^">]|"[^"]*")*)>/g, (m, slash, tagRaw, attrs) => {
    const tag = tagRaw.toLowerCase();
    if (!STIMULUS_ALLOWED_TAGS.has(tag)) return '';
    if (slash) return `</${tag}>`;
    if (tag === 'img') return m; // already normalized above
    const kept = [];
    const re = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = re.exec(attrs)) !== null) {
      const name = a[1].toLowerCase();
      const val = a[2];
      if (name.startsWith('on')) continue;
      if (!STIMULUS_ALLOWED_ATTRS.has(name)) continue;
      if (/javascript:/i.test(val)) continue;
      kept.push(`${name}="${escapeAttr(val)}"`);
    }
    return kept.length ? `<${tag} ${kept.join(' ')}>` : `<${tag}>`;
  });
  return html.trim();
}
```

Update the export line:

```javascript
module.exports = { sanitizeStemHtml, stemHtmlToText, ALLOWED_TAGS, sanitizeStimulusHtml };
```

(`escapeAttr` already exists in this file — reuse it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test "test/unit/stimulus-sanitize.test.js"`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add src/scrapers/ope-stem.js test/unit/stimulus-sanitize.test.js
git commit -m "feat(scraper): add sanitizeStimulusHtml (svg/table/data-img allowlist)"
```

---

## Task 4: Scraper capture in `readReviewFrame`

Extract the stimulus region, screenshot `itdmedia` images to `data:` PNGs, build the `stimulus` object, and return it on the item.

**Files:**
- Modify: `src/scrapers/starttest_scraper.js` (`readReviewFrame`, ~line 1079-1370; requires `sanitizeStimulusHtml` from `ope-stem.js` — line 14 already imports from `./ope-stem`)

**Interfaces:**
- Consumes: `sanitizeStimulusHtml` (Task 3); the Playwright `frame` handle passed to `readReviewFrame`.
- Produces: `data.stimulus` — an object `{ kind, html, dataText, sources }` or `null`, on the return of `readReviewFrame`.

- [ ] **Step 1: Extend the import**

At `src/scrapers/starttest_scraper.js:14`, change:

```javascript
const { sanitizeStemHtml, stemHtmlToText } = require('./ope-stem');
```
to:
```javascript
const { sanitizeStemHtml, stemHtmlToText, sanitizeStimulusHtml } = require('./ope-stem');
```

- [ ] **Step 2: Collect stimulus HTML + itdmedia targets inside the frame `evaluate`**

Inside `readReviewFrame`'s `frame.evaluate(() => { ... })` (the block returning the big object at ~line 1326), before the `return { ... }`, add collection of the stimulus region. Add this code just above the `return`:

```javascript
    // --- DI stimulus (charts/tables/MSR sources) ---
    // Review mode flattens all sources into the DOM. Collect the item stimulus:
    // the stem region + illustration + any titled reference sources, but NOT the
    // solution rationale (which shares the passage-block/ItemRationaleText class).
    const stimulusRoots = [
      document.querySelector('.its-item-table.ITSStem'),
      document.querySelector('.illustration-container'),
    ].filter(Boolean);
    // MSR reference sources: titled blocks under ItemReferenceTitleText. Keep the
    // titled section HTML/text; the plain rationale (no ItemReferenceTitleText
    // sibling title) is excluded.
    const referenceSources = Array.from(document.querySelectorAll('h2.ItemReferenceTitleText')).map((h) => {
      const container = h.closest('.rationale, .passage-block, .ItemRationaleText') || h.parentElement;
      return { title: (h.innerText || '').trim(), html: container ? container.innerHTML : '', text: container ? (container.innerText || '').trim() : '' };
    });
    const hasSvg = stimulusRoots.some((el) => el.querySelector('svg'));
    const hasTable = stimulusRoots.some((el) => el.querySelector('table.table, table[border]'));
    const stimulusHtmlRaw = stimulusRoots.map((el) => el.innerHTML).join('\n');
    // Mark itdmedia <img>s for the Node side to screenshot: give each a data-shot
    // index so we can find and replace it after screenshotting.
    let shotIdx = 0;
    const itdmediaSelectors = [];
    stimulusRoots.forEach((root) => {
      root.querySelectorAll('img').forEach((im) => {
        const src = im.getAttribute('src') || '';
        if (/itdmedia\.aspx/i.test(src)) {
          im.setAttribute('data-shot', String(shotIdx));
          itdmediaSelectors.push(`[data-shot="${shotIdx}"]`);
          shotIdx += 1;
        }
      });
    });
    const stimulusHtmlMarked = stimulusRoots.map((el) => el.innerHTML).join('\n');
    const stimulusKind = referenceSources.length ? 'msr' : hasTable && !hasSvg ? 'table' : hasSvg ? 'graph' : (hasTable ? 'mixed' : null);
```

Then add these fields to the returned object literal:

```javascript
      stimulusHtmlMarked,
      stimulusKind,
      referenceSources,
      itdmediaSelectors,
      itemStimulusPresent: !!(hasSvg || hasTable || referenceSources.length),
```

- [ ] **Step 3: Node-side — screenshot itdmedia imgs and assemble the stimulus object**

After the `frame.evaluate` returns `data` (in the Node section of `readReviewFrame`, after the existing `if (data.stemImgHtml ...)` blocks, before the function's final `return data;`), add:

```javascript
  // Build the DI stimulus object: screenshot each itdmedia chart image into a
  // self-contained data: PNG, then sanitize the whole stimulus region.
  if (data.itemStimulusPresent) {
    let html = data.stimulusHtmlMarked || '';
    for (const sel of data.itdmediaSelectors || []) {
      try {
        const handle = await frame.$(sel);
        if (!handle) continue;
        const buf = await handle.screenshot({ type: 'png' });
        const dataUri = `data:image/png;base64,${buf.toString('base64')}`;
        // Replace the marked <img ... data-shot="N" ...> with a data: img.
        const shot = (sel.match(/data-shot="(\d+)"/) || [])[1];
        const imgRe = new RegExp(`<img\\b[^>]*data-shot="${shot}"[^>]*>`, 'i');
        html = html.replace(imgRe, `<img src="${dataUri}">`);
      } catch (_e) { /* leave the (dead) itdmedia img; sanitizer will drop it */ }
    }
    const safeHtml = sanitizeStimulusHtml(html);
    const sources = (data.referenceSources || []).map((s) => ({
      title: s.title, html: sanitizeStimulusHtml(s.html), text: s.text,
    }));
    // dataText for the coach: stem-region text + each source's text.
    const dataText = [
      ...(data.stem ? [data.stem] : []),
      ...sources.map((s) => `${s.title}\n${s.text}`),
    ].join('\n\n').trim();
    data.stimulus = safeHtml || sources.length
      ? { kind: data.stimulusKind || 'mixed', html: safeHtml, dataText, sources }
      : null;
  } else {
    data.stimulus = null;
  }
  // Drop the transient capture fields so they don't leak downstream.
  delete data.stimulusHtmlMarked; delete data.itdmediaSelectors;
  delete data.referenceSources; delete data.itemStimulusPresent; delete data.stimulusKind;
```

- [ ] **Step 4: Thread `stimulus` onto the enriched item**

Find where `readReviewFrame`'s `data` is turned into the enriched item object that the runner returns (the item-build site in `runPhase2`, where `stem`, `choices`, `correctKey` become the item). Add `stimulus: data.stimulus` to that item object so it reaches the DB writer. (Grep `readReviewFrame(` to find the call site and the object it feeds.)

- [ ] **Step 5: Manual smoke (no unit test — needs live CDP)**

This task has no pure unit test (it needs the live ITDReview DOM). Verify in Task 8 (integration). For now:

Run: `node -e "require('./src/scrapers/starttest_scraper.js'); console.log('module loads')"`
Expected: `module loads` (syntax check), and `npx eslint src/scrapers/starttest_scraper.js` → 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/scrapers/starttest_scraper.js
git commit -m "feat(scraper): capture DI stimulus (svg/table/itdmedia/MSR sources) in Phase 2"
```

---

## Task 5: Writer — persist `stimulus` in `enrichSessionAttempts`

**Files:**
- Modify: `src/db.js` (`enrichSessionAttempts` UPDATE; add `normalizeStimulusForStorage`)

**Interfaces:**
- Consumes: item `stimulus` object from Task 4.
- Produces: `normalizeStimulusForStorage(v): string|null`; the enrich UPDATE writes `stimulus`.

- [ ] **Step 1: Add the normalizer**

In `src/db.js`, near `normalizeAnswerChoicesForStorage`, add:

```javascript
// Stimulus is stored as a JSON string. Accept an object or a string; return a
// compact JSON string, or null when empty.
function normalizeStimulusForStorage(value) {
  if (value == null) return null;
  if (typeof value === 'string') { const t = value.trim(); return t || null; }
  try {
    const hasContent = value.html || (Array.isArray(value.sources) && value.sources.length) || value.dataText;
    return hasContent ? JSON.stringify(value) : null;
  } catch (_e) { return null; }
}
```

- [ ] **Step 2: Swap the Task 2 placeholder**

In `saveScrapeResult`, change the `stimulus` value line from the temporary `normalizedTextOrNull(q.stimulus)` to:

```javascript
          normalizeStimulusForStorage(q.stimulus) || preservedSnapshot?.stimulus || null,
```

- [ ] **Step 3: Write `stimulus` in the enrich UPDATE**

In `enrichSessionAttempts`, find the `UPDATE question_attempts SET ...` statement that writes Phase-2 fields (`question_stem`, `answer_choices`, `response_details`, etc.). Add a `stimulus = ?` assignment and pass `normalizeStimulusForStorage(item.stimulus)` in the matching parameter position. Preserve-on-null semantics: use `stimulus = COALESCE(?, stimulus)` so a re-enrich that captured nothing does not blank a prior good value. (Mirror how the existing enrich UPDATE guards other enrichment columns.)

- [ ] **Step 4: Run suite + lint**

Run: `npm test && npx eslint src/db.js`
Expected: pass, 0 errors (the Task 2 preserve test still passes).

- [ ] **Step 5: Commit**

```bash
git add src/db.js
git commit -m "feat(db): write DI stimulus in enrichSessionAttempts"
```

---

## Task 6: Render — Stimulus block in the review modal

**Files:**
- Modify: `client/src/App.jsx` (client sanitizer near line 329-368; the question-review modal render near line 5024)
- Modify: `client/src/styles.css`

**Interfaces:**
- Consumes: `row.stimulus` (JSON string from the API — parse it).
- Produces: a `<div className="question-stimulus">` rendered above the answer choices.

- [ ] **Step 1: Add a client-side stimulus sanitizer**

In `client/src/App.jsx`, near the existing client `sanitizeStemHtml` (~line 329-368), add a mirror `sanitizeStimulusHtml` with the same allowlist logic as Task 3 (svg/table/data-img; strip scripts, `on*`, external src). Keep it a plain function in this file (ESM), not an import from the Node module.

- [ ] **Step 2: Parse + render the stimulus**

In the question-review modal (where `question_stem_html` renders via `dangerouslySetInnerHTML` at ~line 366 and choices at ~line 5024), add, above the choices list:

```jsx
{(() => {
  let s = null;
  try { s = questionReview.row?.stimulus ? JSON.parse(questionReview.row.stimulus) : null; } catch { s = null; }
  if (!s) return null;
  const html = sanitizeStimulusHtml(s.html || '');
  return (
    <div className="question-stimulus">
      {html && <div className="question-stimulus-main" dangerouslySetInnerHTML={{ __html: html }} />}
      {Array.isArray(s.sources) && s.sources.map((src, i) => (
        <section className="question-stimulus-source" key={i}>
          {src.title && <h4>{src.title}</h4>}
          <div dangerouslySetInnerHTML={{ __html: sanitizeStimulusHtml(src.html || '') }} />
        </section>
      ))}
    </div>
  );
})()}
```

(Use the actual row variable in scope at that render site — grep the block for the existing `question_stem_html` render to confirm the row identifier.)

- [ ] **Step 3: Add styles**

In `client/src/styles.css`, add:

```css
.question-stimulus { margin: 0 0 16px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2, var(--card)); overflow-x: auto; }
.question-stimulus table { border-collapse: collapse; margin: 8px 0; }
.question-stimulus th, .question-stimulus td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
.question-stimulus svg { max-width: 100%; height: auto; }
.question-stimulus img { max-width: 100%; height: auto; }
.question-stimulus-source { margin-top: 12px; }
.question-stimulus-source h4 { margin: 0 0 4px; font-weight: 600; }
```

(Use design tokens already present in `styles.css`; confirm `--border`/`--card` names by grepping. Do not introduce literal colors.)

- [ ] **Step 4: Build to verify compile**

Run: `npm run build:web`
Expected: `✓ built` with no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/App.jsx client/src/styles.css
git commit -m "feat(ui): render DI stimulus (charts/tables/sources) in review modal"
```

---

## Task 7: Coach — include stimulus dataText

**Files:**
- Modify: `src/db.js` (`getSessionAnalysis` question SELECT — add `stimulus`)
- Modify: `src/llm-coach-agent.js` (`get_session_detail` question map, ~line 357-368)

**Interfaces:**
- Consumes: `q.stimulus` (JSON string) on the session-analysis question rows.
- Produces: `stimulusData` string on each coach question object.

- [ ] **Step 1: Include `stimulus` in the analysis SELECT**

In `src/db.js`, find `getSessionAnalysis` and add `q.stimulus` to the per-question SELECT column list (alongside `q.response_details` / `q.answer_choices`).

- [ ] **Step 2: Map `stimulusData` for the coach**

In `src/llm-coach-agent.js`, in the `get_session_detail` `questions.map((q) => ({ ... }))` (~line 357), add:

```javascript
        stimulusData: (() => {
          try { const s = q.stimulus ? JSON.parse(q.stimulus) : null; return s ? clipText(s.dataText || '', 600) : ''; }
          catch { return ''; }
        })(),
```

- [ ] **Step 3: Suite + lint**

Run: `npm test && npx eslint src/db.js src/llm-coach-agent.js`
Expected: pass, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/db.js src/llm-coach-agent.js
git commit -m "feat(coach): feed DI stimulus dataText into session detail"
```

---

## Task 8: Integration — live re-enrich + verify

**Files:** none (verification only).

- [ ] **Step 1: Restart the API** so the new code + column are live.

Run: `npm run dev:api` (user-managed; confirm it's serving).

- [ ] **Step 2: Re-enrich a DI session with MSR/GI/TA items**

Session 316 (id `316`, external `161326`) has MSR items; session 314 (`314`) has GI + matrix. With a logged-in starttest tab on the OG Main home:

Run: `curl -s -X POST http://localhost:4310/api/sessions/316/enrich -H 'Content-Type: application/json' -d '{}'`
Expected: JSON with `dbUpdated` > 0.

- [ ] **Step 3: Verify stimulus stored**

Run:
```bash
docker exec gmat-pg psql -U postgres -d gmat -c "SELECT q_id, LEFT(stimulus,80) FROM question_attempts WHERE session_id=316 AND stimulus IS NOT NULL LIMIT 5;"
```
Expected: rows with JSON containing `kind`/`html`/`dataText`.

- [ ] **Step 4: Verify rescrape preservation**

Run a Phase-1 scrape of OG Main (the UI Sync, or `POST /api/scrape`), then re-run Step 3.
Expected: `stimulus` still populated (not wiped) — confirms the clobber-proofing.

- [ ] **Step 5: Visual check**

Open the dashboard → session 316 → question review modal. Confirm the chart/table/sources render above the choices.

- [ ] **Step 6: Commit any fixups discovered**, then done.

---

## Self-Review Notes

- **Spec coverage:** capture (T4), storage (T1/T5), preservation (T2), sanitizer (T3/T6), rendering (T6), coach (T7), testing (T2/T3/T8) — all covered.
- **Known heuristic:** MSR source-vs-rationale split via `ItemReferenceTitleText` (T4 Step 2) — validate on 2-3 MSR items in T8; adjust the `referenceSources` selector if the solution leaks in.
- **itdmedia screenshot** requires the `<img>` be laid out/visible at capture time (review mode renders it) — if a shot returns empty, the sanitizer drops the dead itdmedia img so the stem text still stands.
