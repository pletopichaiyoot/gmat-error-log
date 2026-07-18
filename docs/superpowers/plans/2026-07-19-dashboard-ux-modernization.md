# Dashboard UX Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modernize five dashboard surfaces (overview top-zone, Category Breakdown, Error Log + review modal, Pattern Analysis, Study Plan) toward "clarity + professional feel" while staying strictly inside the "Patient Coach" brand.

**Architecture:** Frontend-only. Add small pure helpers (`client/src/lib/trend.mjs`) and presentational components (`client/src/components/{Sparkline,MiniBar,ProgressRing,HeroBand}.jsx`), then wire them into the existing React surfaces in `App.jsx`, `TodayPlan.jsx`, and `StudyPlan.jsx`. All new signal (trend series, deltas, weakest-category) is derived client-side from data already fetched (`/api/sessions`, category rows). No backend, schema, API, or scraper change.

**Tech Stack:** React 18 (hooks, ESM), Vite, plain CSS with custom properties (`client/src/styles.css`), shadcn-style primitives in `client/src/components/ui/`, `node:test` for pure-helper units. Dev server runs on `localhost:5170` (API on `4310`, Postgres in Docker) — all already up.

## Global Constraints

Copied verbatim from the spec (`docs/superpowers/specs/2026-07-19-dashboard-ux-modernization-design.md` §4). Every task's requirements implicitly include these:

- **Two-Voice Rule:** green (`--primary #3d7a5e`) = user success + system voice; brass (`--accent #c4a843`, text `--accent-ink #8f7c35`) = attention / the missed thing. Trend/score **rising = green**, **declining = brass-ink**, NEVER red. Red (`--danger #b54a44`) is reserved for the wrong-pick answer semantic.
- **Answer semantic untouched:** gold=correct-missed, red=wrong-pick, green=right-pick via 3px left-border + tint. Review modal keeps this exactly (including the `anyMine`/`anyCorrectFlagged` independent-flag logic).
- **Flat-by-default:** depth from 1px `--border` + tonal cream steps (`--surface #fdfcf8` / `--surface-2 #f2f0ea` / page `#f5f4ef`). Shadow only for things that truly float. Never nest a card in a card.
- **Micro-label idiom:** captions/eyebrows/table-headers/chips = uppercase ~0.7rem, weight 600–700, tracked. Every number = `font-variant-numeric: tabular-nums`.
- **Two families:** Manrope titles, Space Grotesk everything else. No third family.
- **WCAG 2.2 AA:** never `--muted #7a807c` on cream for read text — use `--ink-2 #4a524e`. Preserve visible focus + keyboard operability.
- **No new color tokens** beyond adding `--accent-ink: #8f7c35` (already a documented brand color, just not yet tokenized). No glassmorphism, gradient text, big-number metric-tile template, or identical icon+heading+text card grids.
- **Lint floor:** `npm run lint` stays at **0 errors** (warnings baseline ~127; new code adds no errors).
- **Motion:** all new motion guarded by `prefers-reduced-motion: reduce`.

---

## File Structure

**New files:**
- `client/src/lib/trend.mjs` — pure trend/weakness helpers (ESM `.mjs` so a CJS `node:test` can `require()` it under Node 24 require-esm; mirrors existing `client/src/studyPlanReorder.mjs`).
- `client/src/components/Sparkline.jsx` — inline SVG trend line.
- `client/src/components/MiniBar.jsx` — thin horizontal accuracy bar for table cells.
- `client/src/components/ProgressRing.jsx` — small circular progress indicator.
- `client/src/components/HeroBand.jsx` — the at-a-glance overview header (composes the above).
- `test/unit/trend.test.js` — CJS unit tests for `trend.mjs`.

**Modified files:**
- `client/src/App.jsx` — overview top-zone (nav ~2944, TodayPlan mount 3149, subject cards 3177-3191), Category accuracy cell (3257), Error Log sticky filters (~3374), review modal (~4755-4797), Pattern Analysis (~3895/4007), nav scroll-spy (2944).
- `client/src/TodayPlan.jsx` — accept a ProgressRing-based "done today" summary; align to unified top zone.
- `client/src/StudyPlan.jsx` — MockResultsPanel date + delta color + token migration (769-901), day-board scannability.
- `client/src/styles.css` — `--accent-ink` token, sparkline/minibar/ring/hero styles, sticky filter bar, scroll-spy active state, motion guards.

**Phasing:** Tasks map to the 5 spec phases. Each phase is browser-reviewed before the next. Verification for visual tasks = `npm run lint` (0 errors) + Playwright screenshot at 1440px vs the baselines captured 2026-07-19 in `.playwright-mcp/` (`current-overview.png`, `detail-overview-top.png`, `current-studyplan.png`, `detail-studyplan-*.png`).

---

## Phase 1 — Foundations + Overview top zone

### Task 1: Pure trend helpers (`trend.mjs`)

**Files:**
- Create: `client/src/lib/trend.mjs`
- Test: `test/unit/trend.test.js`

**Interfaces:**
- Produces:
  - `buildAccuracyTrend(sessions, { limit = 12, accuracyKey = 'answered_accuracy_pct' }) → { series: number[], delta: number | null }` — `series` is oldest→newest per-session accuracy (max `limit` most-recent), `delta = last - first` rounded to 0.1, or `null` if <2 points.
  - `pickWeakestCategory(rows, { minTotal = 5 }) → row | null` — the category row with lowest `accuracy_pct` among rows with `total_questions >= minTotal`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/trend.test.js`:

```js
/* global require */
const test = require('node:test');
const assert = require('node:assert');
const { buildAccuracyTrend, pickWeakestCategory } = require('../../client/src/lib/trend.mjs');

test('buildAccuracyTrend orders oldest→newest and computes delta', () => {
  const sessions = [
    { session_date: '2026-07-03', answered_accuracy_pct: 70 },
    { session_date: '2026-07-01', answered_accuracy_pct: 60 },
    { session_date: '2026-07-02', answered_accuracy_pct: 65 },
  ];
  const { series, delta } = buildAccuracyTrend(sessions);
  assert.deepStrictEqual(series, [60, 65, 70]);
  assert.strictEqual(delta, 10);
});

test('buildAccuracyTrend caps to the most recent `limit` points', () => {
  const sessions = Array.from({ length: 20 }, (_, i) => ({
    session_date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    answered_accuracy_pct: i,
  }));
  const { series } = buildAccuracyTrend(sessions, { limit: 5 });
  assert.deepStrictEqual(series, [15, 16, 17, 18, 19]);
});

test('buildAccuracyTrend returns null delta for <2 valid points', () => {
  assert.strictEqual(buildAccuracyTrend([]).delta, null);
  assert.strictEqual(buildAccuracyTrend([{ session_date: '2026-07-01', answered_accuracy_pct: 50 }]).delta, null);
});

test('buildAccuracyTrend ignores rows with bad dates or NaN accuracy', () => {
  const { series } = buildAccuracyTrend([
    { session_date: 'nope', answered_accuracy_pct: 99 },
    { session_date: '2026-07-01', answered_accuracy_pct: 'x' },
    { session_date: '2026-07-02', answered_accuracy_pct: 55 },
    { session_date: '2026-07-03T12:00:00Z', answered_accuracy_pct: 66 },
  ]);
  assert.deepStrictEqual(series, [55, 66]);
});

test('pickWeakestCategory returns lowest accuracy above the volume floor', () => {
  const rows = [
    { category: 'PS', accuracy_pct: 80, total_questions: 40 },
    { category: 'MSR', accuracy_pct: 49, total_questions: 10 },
    { category: 'GI', accuracy_pct: 20, total_questions: 3 }, // below floor
  ];
  assert.strictEqual(pickWeakestCategory(rows).category, 'MSR');
});

test('pickWeakestCategory returns null when nothing clears the floor', () => {
  assert.strictEqual(pickWeakestCategory([{ category: 'GI', accuracy_pct: 20, total_questions: 2 }]), null);
  assert.strictEqual(pickWeakestCategory([]), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "test/unit/trend.test.js"`
Expected: FAIL — `Cannot find module '.../client/src/lib/trend.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/lib/trend.mjs`:

```js
// Pure helpers for dashboard trend signal. No React, no DOM — unit-testable.
// ESM .mjs so a CJS node:test can require() it under Node 24 require-esm
// (mirrors client/src/studyPlanReorder.mjs).

// Bucket sessions into a chronological accuracy series (oldest→newest).
// sessions: [{ session_date: 'YYYY-MM-DD'|ISO, [accuracyKey]: number }]
export function buildAccuracyTrend(sessions, { limit = 12, accuracyKey = 'answered_accuracy_pct' } = {}) {
  const rows = (Array.isArray(sessions) ? sessions : [])
    .map((s) => ({ date: String(s?.session_date || '').slice(0, 10), acc: Number(s?.[accuracyKey]) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.acc))
    .sort((a, b) => a.date.localeCompare(b.date));
  const series = rows.slice(-limit).map((r) => r.acc);
  const delta = series.length >= 2
    ? Number((series[series.length - 1] - series[0]).toFixed(1))
    : null;
  return { series, delta };
}

// Weakest category = lowest accuracy_pct among rows meeting a min-volume floor.
export function pickWeakestCategory(rows, { minTotal = 5 } = {}) {
  const eligible = (Array.isArray(rows) ? rows : []).filter(
    (r) => Number(r?.total_questions) >= minTotal && Number.isFinite(Number(r?.accuracy_pct)),
  );
  if (!eligible.length) return null;
  return eligible.reduce((worst, r) => (Number(r.accuracy_pct) < Number(worst.accuracy_pct) ? r : worst));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "test/unit/trend.test.js"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/trend.mjs test/unit/trend.test.js
git commit -m "feat(dashboard): add pure trend + weakest-category helpers"
```

---

### Task 2: Presentational components (Sparkline, MiniBar, ProgressRing)

**Files:**
- Create: `client/src/components/Sparkline.jsx`, `client/src/components/MiniBar.jsx`, `client/src/components/ProgressRing.jsx`
- Modify: `client/src/styles.css` (append component styles + motion guard)

**Interfaces:**
- Produces:
  - `<Sparkline points={number[]} width={96} height={28} stroke="var(--primary)" strokeWidth={1.5} ariaLabel="trend" className="" />` — renders an em-dash span when `<2` finite points.
  - `<MiniBar value={0..100} color="var(--primary)" className="" />`
  - `<ProgressRing value={0} total={0} size={44} stroke={5} className="" />`

- [ ] **Step 1: Create Sparkline**

Create `client/src/components/Sparkline.jsx`:

```jsx
// Tiny inline SVG trend line. Pure/presentational. points: oldest→newest.
export default function Sparkline({
  points = [], width = 96, height = 28,
  stroke = 'var(--primary)', strokeWidth = 1.5,
  ariaLabel = 'trend', className = '',
}) {
  const clean = (points || []).filter((n) => Number.isFinite(n));
  if (clean.length < 2) {
    return <span className={`sparkline sparkline--empty ${className}`} aria-label={`${ariaLabel}: not enough data`}>—</span>;
  }
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;
  const pad = strokeWidth + 1;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const step = innerW / (clean.length - 1);
  const coords = clean.map((v, i) => [pad + i * step, pad + innerH - ((v - min) / range) * innerH]);
  const d = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = coords[coords.length - 1];
  return (
    <svg className={`sparkline ${className}`} width={width} height={height}
         viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} preserveAspectRatio="none">
      <path className="sparkline-path" d={d} fill="none" stroke={stroke}
            strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={strokeWidth + 0.5} fill={stroke} />
    </svg>
  );
}
```

- [ ] **Step 2: Create MiniBar**

Create `client/src/components/MiniBar.jsx`:

```jsx
// Thin horizontal accuracy bar for dense table cells. Pure/presentational.
export default function MiniBar({ value = 0, color = 'var(--primary)', className = '' }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <span className={`minibar ${className}`} role="img" aria-label={`${pct.toFixed(0)} percent`}>
      <span className="minibar-fill" style={{ width: `${pct}%`, background: color }} />
    </span>
  );
}
```

- [ ] **Step 3: Create ProgressRing**

Create `client/src/components/ProgressRing.jsx`:

```jsx
// Small circular progress indicator. Pure/presentational.
export default function ProgressRing({ value = 0, total = 0, size = 44, stroke = 5, className = '' }) {
  const pct = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct);
  const mid = size / 2;
  return (
    <svg className={`progress-ring ${className}`} width={size} height={size}
         viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${value} of ${total} done`}>
      <circle cx={mid} cy={mid} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
      <circle className="progress-ring-arc" cx={mid} cy={mid} r={r} fill="none"
              stroke="var(--primary)" strokeWidth={stroke} strokeLinecap="round"
              strokeDasharray={c} strokeDashoffset={offset}
              transform={`rotate(-90 ${mid} ${mid})`} />
    </svg>
  );
}
```

- [ ] **Step 4: Append styles + motion guard to `client/src/styles.css`**

Add at the end of the file:

```css
/* ── Dashboard signal components ─────────────────────────────── */
.sparkline { display: inline-block; vertical-align: middle; overflow: visible; }
.sparkline--empty { color: var(--muted); font-variant-numeric: tabular-nums; }
.sparkline-path { stroke-dasharray: 240; stroke-dashoffset: 0; }
@media (prefers-reduced-motion: no-preference) {
  .sparkline-path { animation: sparkline-draw 0.7s ease-out both; }
}
@keyframes sparkline-draw { from { stroke-dashoffset: 240; } to { stroke-dashoffset: 0; } }

.minibar {
  display: inline-block; width: 64px; height: 6px; border-radius: 999px;
  background: var(--surface-2); overflow: hidden; vertical-align: middle;
}
.minibar-fill { display: block; height: 100%; border-radius: 999px; }

.progress-ring-arc { transition: stroke-dashoffset 0.5s ease; }
@media (prefers-reduced-motion: reduce) { .progress-ring-arc { transition: none; } }
```

- [ ] **Step 5: Verify build + lint**

Run: `npm run lint`
Expected: 0 errors (unused-component warnings are acceptable until wired in Task 3).
Run: `npm run build:web`
Expected: build succeeds (proves the new JSX/CSS compile).

- [ ] **Step 6: Commit**

```bash
git add client/src/components/Sparkline.jsx client/src/components/MiniBar.jsx client/src/components/ProgressRing.jsx client/src/styles.css
git commit -m "feat(dashboard): add Sparkline, MiniBar, ProgressRing presentational components"
```

---

### Task 3: HeroBand + overview top-zone wiring

**Files:**
- Create: `client/src/components/HeroBand.jsx`
- Modify: `client/src/App.jsx` (import block near top; overview render 3168-3193), `client/src/styles.css`

**Interfaces:**
- Consumes: `buildAccuracyTrend`, `pickWeakestCategory` (Task 1); `Sparkline`, `MiniBar` (Task 2).
- Produces: `<HeroBand overall={number} delta={number|null} series={number[]} weakest={{subject,category,accuracy}|null} onDrill={() => void} />`

- [ ] **Step 1: Create HeroBand**

Create `client/src/components/HeroBand.jsx`:

```jsx
import Sparkline from './Sparkline';

// At-a-glance overview header. Sanctioned scoreboard moment (Display type).
// delta: rising = green, declining = brass-ink (Two-Voice Rule) — never red.
export default function HeroBand({ overall = 0, delta = null, series = [], weakest = null, onDrill }) {
  const pct = Math.max(0, Math.min(100, Number(overall) || 0));
  const rising = delta != null && delta > 0;
  const deltaClass = delta == null ? '' : rising ? 'hero-delta--up' : delta < 0 ? 'hero-delta--down' : 'hero-delta--flat';
  const deltaText = delta == null ? '' : `${rising ? '▲' : delta < 0 ? '▼' : '='} ${Math.abs(delta).toFixed(1)}`;
  return (
    <div className="hero-band">
      <div className="hero-metric">
        <span className="hero-eyebrow">Overall accuracy</span>
        <div className="hero-metric-row">
          <strong className="hero-value">{pct.toFixed(1)}%</strong>
          {delta != null && <span className={`hero-delta ${deltaClass}`}>{deltaText}</span>}
        </div>
      </div>
      <div className="hero-trend">
        <span className="hero-eyebrow">Recent trend</span>
        <Sparkline points={series} width={140} height={34} ariaLabel="recent accuracy trend" />
      </div>
      {weakest && (
        <div className="hero-weakness">
          <span className="hero-eyebrow">Weakest area</span>
          <div className="hero-weakness-body">
            <span className="hero-weakness-label">{weakest.subject} · {weakest.category}</span>
            <span className="hero-weakness-pct">{Number(weakest.accuracy).toFixed(1)}%</span>
          </div>
          <button type="button" className="hero-drill" onClick={onDrill}>Drill this →</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Import in App.jsx**

Near the other component imports at the top of `client/src/App.jsx` (after the `const StudyPlan = lazy(...)` line ~14), add:

```jsx
import HeroBand from './components/HeroBand';
import Sparkline from './components/Sparkline';
import MiniBar from './components/MiniBar';
import { buildAccuracyTrend, pickWeakestCategory } from './lib/trend.mjs';
```

- [ ] **Step 3: Compute hero data in the component body**

Find the `overallMastery` memo (App.jsx:2061-2066). Immediately after it, add:

```jsx
  const heroTrend = useMemo(
    () => buildAccuracyTrend(sessionRows, { limit: 12 }),
    [sessionRows],
  );
  const heroWeakest = useMemo(() => {
    const row = pickWeakestCategory(categoryRows, { minTotal: 5 });
    if (!row) return null;
    return {
      subject: normalizeSubjectFamilyDisplay(row.subject_family),
      category: normalizedCategoryCode(row),
      accuracy: row.accuracy_pct,
    };
  }, [categoryRows]);
```

> Note: `sessionRows` is the computed session list carrying `session_date` + `answered_accuracy_pct` (the array rendered by "Performance by Session", memo at ~2343). If it is named differently in scope, use that exact identifier. `categoryRows`, `normalizeSubjectFamilyDisplay`, `normalizedCategoryCode` already exist.

- [ ] **Step 4: Render HeroBand + subject sparklines**

In `client/src/App.jsx`, replace the `dashboard-overall` block (3171-3176) so the hero band leads the strip. Replace:

```jsx
            {subjectCards.length > 0 && (
              <div className="dashboard-overall">
                <span className="dashboard-overall-label">Overall</span>
                <strong className="dashboard-overall-value">{formatPercent(overallMastery)}</strong>
              </div>
            )}
```

with:

```jsx
            {subjectCards.length > 0 && (
              <HeroBand
                overall={overallMastery}
                delta={heroTrend.delta}
                series={heroTrend.series}
                weakest={heroWeakest}
                onDrill={() => {
                  if (!heroWeakest) return;
                  setErrorSubjectFilter(heroWeakest.subject);
                  document.getElementById('errors')?.scrollIntoView({ behavior: 'smooth' });
                }}
              />
            )}
```

> Note: use the actual error-log subject-filter setter. Grep `setError*Filter` / `subjectFilter` in App.jsx and use the exact setter that drives the Error Log Subject `<Select>`. If the filter is keyed by subject family string, pass `heroWeakest.subject`; if by code, map accordingly. If no such setter exists, fall back to only the `scrollIntoView` call and drop the setter line.

Then add a per-subject sparkline inside each subject card. In the `subjectCards.map` block, after the `dashboard-subject-bar` div (3187), add:

```jsx
                  <Sparkline
                    points={buildAccuracyTrend(
                      sessionRows.filter((s) => normalizeSubjectFamilyDisplay(s.subject) === normalizeSubjectFamilyDisplay(card.family)),
                      { limit: 8 },
                    ).series}
                    width={120}
                    height={22}
                    ariaLabel={`${normalizeSubjectFamilyDisplay(card.family)} trend`}
                    className="dashboard-subject-spark"
                  />
```

> Note: confirm session rows carry a `subject` (or `subject_family`) field for the filter; if the field name differs, use it. If per-session subject is unavailable, omit the subject sparkline (keep the bar) and note it in the phase review.

- [ ] **Step 5: Add hero styles to `client/src/styles.css`**

```css
/* ── Overview hero band ──────────────────────────────────────── */
.hero-band {
  display: grid; grid-template-columns: auto 1fr auto; gap: 24px; align-items: center;
  padding: 20px 24px; background: var(--surface-2);
  border: 1px solid var(--border); border-radius: 14px;
}
.hero-eyebrow {
  display: block; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.07em;
  text-transform: uppercase; color: var(--ink-2); margin-bottom: 6px;
}
.hero-metric-row { display: flex; align-items: baseline; gap: 10px; }
.hero-value {
  font-family: 'Space Grotesk', system-ui, sans-serif; font-weight: 700;
  font-size: clamp(2.2rem, 4vw, 3rem); line-height: 1; letter-spacing: -0.03em;
  color: var(--ink); font-variant-numeric: tabular-nums;
}
.hero-delta { font-size: 0.85rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.hero-delta--up { color: var(--primary); }
.hero-delta--down { color: var(--accent-ink); }   /* Two-Voice: decline = attention, not red */
.hero-delta--flat { color: var(--muted); }
.hero-weakness { text-align: left; min-width: 160px; }
.hero-weakness-body { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.hero-weakness-label { font-weight: 600; color: var(--ink); }
.hero-weakness-pct { font-weight: 700; color: var(--accent-ink); font-variant-numeric: tabular-nums; }
.hero-drill {
  margin-top: 8px; background: transparent; border: none; padding: 0; cursor: pointer;
  color: var(--primary); font-weight: 600; font-size: 0.8rem;
}
.hero-drill:hover { text-decoration: underline; }
.dashboard-subject-spark { margin-top: 8px; opacity: 0.9; }
@media (max-width: 720px) { .hero-band { grid-template-columns: 1fr; gap: 16px; } }
```

Add `--accent-ink: #8f7c35;` to the `:root` block (near line 33, after `--accent-lt`). (Also needed by Task 9.)

- [ ] **Step 6: Verify (lint + browser)**

Run: `npm run lint` → 0 errors.
Then screenshot the running app and compare to baseline:
- Navigate `http://localhost:5170/` at 1440×900, screenshot the overview top zone.
- Confirm: hero band shows big overall %, a delta (green if up / brass if down), a sparkline; each subject card shows a small sparkline under its bar; nothing overlaps; colors match tokens (no red delta).

- [ ] **Step 7: Commit**

```bash
git add client/src/components/HeroBand.jsx client/src/App.jsx client/src/styles.css
git commit -m "feat(dashboard): hero at-a-glance band + subject trend sparklines"
```

---

### Task 4: Nav scroll-spy active state + TodayPlan progress + motion audit

**Files:**
- Modify: `client/src/App.jsx` (nav 2944-2950; add scroll-spy effect), `client/src/TodayPlan.jsx`, `client/src/styles.css`

**Interfaces:**
- Consumes: `ProgressRing` (Task 2).

- [ ] **Step 1: Add scroll-spy state + effect in App.jsx**

In the App component body (near other `useState` declarations, e.g. after `sessions` state ~1164), add:

```jsx
  const [activeSection, setActiveSection] = useState('today');
```

After the effects block (any existing `useEffect` near the top of the component), add:

```jsx
  useEffect(() => {
    const ids = ['today', 'dashboard', 'categories', 'sessions', 'errors'];
    const targets = ids.map((id) => document.getElementById(id)).filter(Boolean);
    if (!targets.length) return undefined;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target?.id) setActiveSection(visible.target.id);
      },
      { rootMargin: '-45% 0px -45% 0px', threshold: [0, 0.25, 0.5] },
    );
    targets.forEach((t) => obs.observe(t));
    return () => obs.disconnect();
  }, [isFirstRun]);
```

> Note: the TodayPlan `<section>` must carry `id="today"`. If it does not (grep `id="today"` in `TodayPlan.jsx`), add `id="today"` to its top-level `<section>` in Step 3.

- [ ] **Step 2: Apply active class to nav links**

Replace the nav block (App.jsx:2944-2950):

```jsx
        <nav className="section-nav" aria-label="Jump to section">
          <a href="#today" className="section-nav-link">Today</a>
          <a href="#dashboard" className="section-nav-link">Dashboard</a>
          <a href="#categories" className="section-nav-link">Categories</a>
          <a href="#sessions" className="section-nav-link">Sessions</a>
          <a href="#errors" className="section-nav-link">Error Log</a>
        </nav>
```

with:

```jsx
        <nav className="section-nav" aria-label="Jump to section">
          {[
            ['today', 'Today'], ['dashboard', 'Dashboard'], ['categories', 'Categories'],
            ['sessions', 'Sessions'], ['errors', 'Error Log'],
          ].map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className={`section-nav-link${activeSection === id ? ' section-nav-link--active' : ''}`}
              aria-current={activeSection === id ? 'true' : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
```

- [ ] **Step 3: Add "done today" ProgressRing to TodayPlan**

In `client/src/TodayPlan.jsx`, import the ring at the top:

```jsx
import ProgressRing from './components/ProgressRing';
```

Locate the "N/N done" summary render (search `done` in the file). Replace the plain text count with the ring beside it, e.g.:

```jsx
        <div className="today-progress">
          <ProgressRing value={doneCount} total={totalCount} size={40} />
          <span className="today-progress-text">{doneCount}/{totalCount} done</span>
        </div>
```

> Note: use the file's existing done/total variables (grep `done`, `tasks.length`, `completed`). Ensure the top-level `<section>` has `id="today"`; add it if missing.

- [ ] **Step 4: Nav active + today-progress styles**

Append to `client/src/styles.css`:

```css
.section-nav-link--active {
  color: var(--primary); background: var(--primary-lt); font-weight: 700;
}
.today-progress { display: inline-flex; align-items: center; gap: 8px; }
.today-progress-text {
  font-size: 0.7rem; font-weight: 700; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--ink-2); font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 5: Motion-guard audit**

Confirm a global reduced-motion guard exists. Search `prefers-reduced-motion` in `styles.css`. If the dashboard `rise`/`pulse` keyframe animations are not covered, append:

```css
@media (prefers-reduced-motion: reduce) {
  .sparkline-path { animation: none; }
  * { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; }
}
```

> Only add the universal fallback if no equivalent global guard is already present; do not duplicate.

- [ ] **Step 6: Verify (lint + browser)**

Run: `npm run lint` → 0 errors.
Browser: scroll the dashboard; confirm the nav highlights the section in view; TodayPlan shows the progress ring; toggle OS reduce-motion and confirm the sparkline no longer animates.

- [ ] **Step 7: Commit**

```bash
git add client/src/App.jsx client/src/TodayPlan.jsx client/src/styles.css
git commit -m "feat(dashboard): nav scroll-spy, today progress ring, reduced-motion guard"
```

---

## Phase 2 — Category Breakdown

### Task 5: Inline accuracy MiniBar

**Files:**
- Modify: `client/src/App.jsx` (accuracy cell 3257; subcategory accuracy cell 3341)

> Sortable headers already exist (`handleCategoryBreakdownSort` + `sortIndicator`) — do NOT rebuild them. This task only adds the inline bar.

**Interfaces:**
- Consumes: `MiniBar` (imported in Task 3).

- [ ] **Step 1: Add MiniBar to the category accuracy cell**

Replace App.jsx:3257:

```jsx
                        <td>{formatPercent(row.accuracy_pct)}</td>
```

with:

```jsx
                        <td>
                          <div className="acc-cell">
                            <span className="acc-cell-pct">{formatPercent(row.accuracy_pct)}</span>
                            <MiniBar value={row.accuracy_pct} />
                          </div>
                        </td>
```

- [ ] **Step 2: Add MiniBar to the subcategory accuracy cell**

Replace App.jsx:3341:

```jsx
                                          <td>{formatPercent(subRow.accuracy_pct)}</td>
```

with:

```jsx
                                          <td>
                                            <div className="acc-cell">
                                              <span className="acc-cell-pct">{formatPercent(subRow.accuracy_pct)}</span>
                                              <MiniBar value={subRow.accuracy_pct} />
                                            </div>
                                          </td>
```

- [ ] **Step 3: Add cell styles to `client/src/styles.css`**

```css
.acc-cell { display: flex; align-items: center; gap: 8px; }
.acc-cell-pct { font-variant-numeric: tabular-nums; min-width: 3.2em; }
```

- [ ] **Step 4: Verify (lint + browser)**

Run: `npm run lint` → 0 errors.
Browser: open Category Breakdown; confirm each accuracy cell shows the % plus a thin sage bar; the bar width tracks the number; sorting by Accuracy still works; the drilldown subtable also shows bars.

- [ ] **Step 5: Commit**

```bash
git add client/src/App.jsx client/src/styles.css
git commit -m "feat(dashboard): inline accuracy bars in Category Breakdown"
```

---

## Phase 3 — Error Log + Review modal

### Task 6: Sticky Error Log filter bar

**Files:**
- Modify: `client/src/App.jsx` (Error Log section ~3561 and its filter row), `client/src/styles.css`

- [ ] **Step 1: Locate the Error Log filter row**

In `client/src/App.jsx`, find the Error Log `<section id="errors">` (3561) and its filter controls (the source/subject/search `<Select>`/`<input>` row, class likely `filter-row` or `section-header-filters`, mirroring the Sessions filters at 3374-3376). Wrap the header+filters in a sticky container by giving the filter row the class `error-filter-sticky` (add to its existing `className`).

Example (adapt to the exact current markup):

```jsx
          <div className="filter-row error-filters error-filter-sticky">
            {/* existing source / subject / search / more-filters controls unchanged */}
          </div>
```

- [ ] **Step 2: Add sticky styles to `client/src/styles.css`**

```css
.error-filter-sticky {
  position: sticky;
  top: 48px;              /* clears the sticky section-nav; adjust to nav height */
  z-index: 20;
  background: var(--surface);
  padding-top: 8px; padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
```

> Note: measure the section-nav height in the browser (it is `position: sticky; top: 0`). Set `top` to that height so the filter bar pins directly beneath it without a gap or overlap.

- [ ] **Step 3: Verify (lint + browser)**

Run: `npm run lint` → 0 errors.
Browser: scroll the long Error Log; confirm the filter bar stays pinned under the section nav and the table scrolls beneath it; filters still function; no z-index overlap with row content or the coach FAB.

- [ ] **Step 4: Commit**

```bash
git add client/src/App.jsx client/src/styles.css
git commit -m "feat(dashboard): sticky Error Log filter bar"
```

---

### Task 7: Review modal polish (semantic untouched)

**Files:**
- Modify: `client/src/App.jsx` (question-review layout ~4755-4797), `client/src/styles.css`

> HARD CONSTRAINT: do not touch the gold/red/green answer-choice classes, the `anyMine`/`anyCorrectFlagged` logic, or the choice-card markup. This task changes reading measure, the result header, and the annotation block spacing ONLY.

- [ ] **Step 1: Cap reading measure on stem/passage**

Find the stem/passage container in the review layout (`question-review-layout`, `.has-passage`, and the stem text element). Add a `question-review-measure` class to the stem + passage text wrappers.

- [ ] **Step 2: Add polish styles to `client/src/styles.css`**

```css
.question-review-measure { max-width: 72ch; }
.question-review-section { padding-top: 4px; }
/* Tighten the result header row above the choices (correct vs your pick + time). */
.question-review-resulthead {
  display: flex; gap: 16px; flex-wrap: wrap; align-items: baseline;
  margin-bottom: 12px; font-variant-numeric: tabular-nums;
}
```

> If a result-header element already exists, give it `question-review-resulthead`. If not, this task is limited to the measure + spacing classes — do NOT invent new result data; only restyle existing rendered fields.

- [ ] **Step 3: Verify (lint + browser)**

Run: `npm run lint` → 0 errors.
Browser: open a wrong question via Error Log → Review. Confirm: stem/passage line length is comfortable (≤72ch), the gold/red/green choice coloring is IDENTICAL to before, annotation section is tidy, modal scrolls and closes normally.

- [ ] **Step 4: Commit**

```bash
git add client/src/App.jsx client/src/styles.css
git commit -m "feat(dashboard): review modal typographic polish (answer semantic unchanged)"
```

---

## Phase 4 — Pattern Analysis

### Task 8: Ranked insight + inline bars + drilldown polish

**Files:**
- Modify: `client/src/App.jsx` (analysis blocks ~3895 and ~4007; pattern drilldown modal ~4051-4062), `client/src/styles.css`

**Interfaces:**
- Consumes: `MiniBar`.

- [ ] **Step 1: Read the analysis blocks**

Read App.jsx:3880-4070 to see how `patterns` renders (the two `analysis-block` sections + the drilldown modal). Identify the list(s) that rank topics/mistakes by frequency or weakness.

- [ ] **Step 2: Add a headline insight line**

At the top of the first `analysis-block`, render a single insight sentence derived from existing `patterns` data (e.g. the highest-frequency mistake or lowest-accuracy topic already in state). Example:

```jsx
              {patternHeadline && (
                <p className="analysis-headline">
                  <span className="analysis-headline-eyebrow">Biggest leak</span>
                  {patternHeadline}
                </p>
              )}
```

Compute `patternHeadline` from data already in the `patterns` state (do not fetch). If the ranked list is `patterns.topics` / `patterns.mistakes`, take the top entry and format a sentence like `` `${top.label} — ${top.count} misses this window` ``. Use the exact field names present in `patterns`.

- [ ] **Step 3: Add inline MiniBars to the ranked rows**

For each ranked pattern row that shows a count or accuracy, add a `<MiniBar value={...} />` next to the number (normalize counts to a 0–100 scale by dividing by the max count in the list × 100). Keep the existing labels and drilldown triggers.

- [ ] **Step 4: Polish the drilldown modal + keep "Apply to Error Log"**

In the pattern drilldown modal (4051-4062), leave the `Apply to Error Log` and `Close` buttons wired exactly as-is; only adjust spacing/typography via a `pattern-drilldown-body` class. Do not change `handleApplyPatternToErrorLog` / `handleClosePatternDrilldown`.

- [ ] **Step 5: Add styles to `client/src/styles.css`**

```css
.analysis-headline {
  display: flex; align-items: baseline; gap: 10px; margin: 0 0 16px;
  font-size: 1rem; color: var(--ink);
}
.analysis-headline-eyebrow {
  font-size: 0.7rem; font-weight: 700; letter-spacing: 0.07em;
  text-transform: uppercase; color: var(--accent-ink);
}
.pattern-rank-row { display: flex; align-items: center; gap: 10px; }
```

- [ ] **Step 6: Verify (lint + browser)**

Run: `npm run lint` → 0 errors.
Browser: open Pattern Analysis; confirm a one-line headline insight, ranked rows with inline bars, drilldown opens and "Apply to Error Log" still filters the log.

- [ ] **Step 7: Commit**

```bash
git add client/src/App.jsx client/src/styles.css
git commit -m "feat(dashboard): pattern analysis ranked insight + inline bars"
```

---

## Phase 5 — Study Plan

### Task 9: Mock Results — humanized date, brass delta, token migration

**Files:**
- Modify: `client/src/StudyPlan.jsx` (MockResultsPanel 769-901), `client/src/styles.css`
- Test: `test/unit/trend.test.js` is separate; add `test/unit/mock-format.test.js` for the date formatter.

**Interfaces:**
- Produces: `formatMockDate(value) → 'MMM D, YYYY'` string (date-only).

- [ ] **Step 1: Write the failing test for `formatMockDate`**

Create `test/unit/mock-format.test.js`:

```js
/* global require */
const test = require('node:test');
const assert = require('node:assert');
const { formatMockDate } = require('../../client/src/lib/mockFormat.mjs');

test('formatMockDate renders a scraped ISO timestamp as date-only', () => {
  assert.strictEqual(formatMockDate('2026-08-02T17:00:00.000Z'), 'Aug 2, 2026');
});
test('formatMockDate renders a plain YYYY-MM-DD', () => {
  assert.strictEqual(formatMockDate('2026-08-02'), 'Aug 2, 2026');
});
test('formatMockDate passes through empty/invalid safely', () => {
  assert.strictEqual(formatMockDate(''), '');
  assert.strictEqual(formatMockDate(null), '');
  assert.strictEqual(formatMockDate('garbage'), 'garbage');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "test/unit/mock-format.test.js"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `formatMockDate`**

Create `client/src/lib/mockFormat.mjs`:

```js
// Format a mock's date (scraped = full ISO, manual = YYYY-MM-DD) as date-only.
export function formatMockDate(value) {
  const s = String(value ?? '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  const [, y, mo, d] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(dt.getTime())) return s;
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "test/unit/mock-format.test.js"`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire formatter + brass delta into MockResultsPanel**

In `client/src/StudyPlan.jsx`, import at top:

```jsx
import { formatMockDate } from './lib/mockFormat.mjs';
```

Change the down-delta color (line 786). Replace:

```jsx
    return { label: `▼ ${Math.abs(delta)}`, color: 'var(--danger)' };
```

with:

```jsx
    return { label: `▼ ${Math.abs(delta)}`, color: 'var(--accent-ink)' };
```

Humanize the two `mock_date` renders. Line 825, replace `{m.mock_date}` with `{formatMockDate(m.mock_date)}`. Line 861, replace `({latest.mock_date})` with `({formatMockDate(latest.mock_date)})`.

> `--accent-ink` was added to `:root` in Task 3 Step 5. If Task 3 has not run, add `--accent-ink: #8f7c35;` to `:root` in `styles.css` now.

- [ ] **Step 6: Migrate MockResultsPanel inline styles to tokens/classes**

Replace the inline-styled `<header>`, `<table>`, `<thead>`, and cell paddings (790-850) with class-based styles so this panel stops being an inline-styled island. Add a `sp-mock` block to `styles.css`:

```css
/* ── Study Plan mock results (token migration) ───────────────── */
.sp-mock { padding: 0; overflow: hidden; }
.sp-mock-head {
  padding: 16px 24px; display: flex; justify-content: space-between; align-items: center;
  background: var(--primary-lt);
}
.sp-mock-title { margin: 4px 0 0; font-size: 1.05rem; font-weight: 700; letter-spacing: -0.02em; color: var(--ink); }
.sp-mock-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
.sp-mock-table th {
  padding: 10px 12px; text-align: left; background: var(--surface-2);
  font-size: 0.7rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-2);
}
.sp-mock-table th:first-child, .sp-mock-table td:first-child { padding-left: 24px; }
.sp-mock-table td { padding: 10px 12px; border-top: 1px solid var(--border); }
.sp-mock-foot { padding: 12px 24px; border-top: 1px solid var(--border); font-size: 0.75rem; color: var(--ink-2); }
```

Replace the corresponding inline `style={{...}}` props on the `<section className="card">`, `<header>`, `<table>`, `<th>`, footer `<div>` with these classes (`sp-mock`, `sp-mock-head`, `sp-mock-title`, `sp-mock-table`, `sp-mock-foot`). Keep row/editor logic and `ScoreCell`/`SourceTypeChip` behavior unchanged (their internal inline styles may stay for this task).

- [ ] **Step 7: Verify (lint + tests + browser)**

Run: `npm run lint` → 0 errors.
Run: `node --test "test/unit/*.test.js"` → all pass.
Browser: open `#study-plan`; confirm Mock Results dates read `Aug 2, 2026` (not ISO), score drops show a brass-ink `▼` (not red), rises stay green, and the panel still matches the warm-paper card style.

- [ ] **Step 8: Commit**

```bash
git add client/src/StudyPlan.jsx client/src/lib/mockFormat.mjs test/unit/mock-format.test.js client/src/styles.css
git commit -m "feat(study-plan): humanize mock dates, brass-ink drop delta, token migration"
```

---

### Task 10: Study Plan day-board scannability

**Files:**
- Modify: `client/src/StudyPlan.jsx` (day-board render), `client/src/styles.css`

**Interfaces:**
- Consumes: `ProgressRing`, `todayLocalISODate()` (already in StudyPlan.jsx:71).

- [ ] **Step 1: Read the day-board render**

Read the day-list render in `client/src/StudyPlan.jsx` (the `dayRows`/`days` map that produces each day card with its header `TUE · 2026-06-30 Cap reflex — CR 2:00` and its `1/3 · 1h 20m` summary). Identify: the per-day container, the day date, the `done/total` counts, and the drag handle.

- [ ] **Step 2: Add today-highlight + per-day progress + completed dimming**

For each day card, compute:

```jsx
              const isToday = day.date === todayLocalISODate();
              const dayDone = tasksForDay.filter((t) => t.status === 'done').length;
              const dayTotal = tasksForDay.length;
              const allDone = dayTotal > 0 && dayDone === dayTotal;
```

Add classes to the day container: `` className={`sp-day${isToday ? ' sp-day--today' : ''}${allDone ? ' sp-day--done' : ''}`} ``. In the day header, place a `<ProgressRing value={dayDone} total={dayTotal} size={28} stroke={4} />` next to the existing `dayDone/dayTotal` count.

> Use the file's actual per-day task list variable and status field. Do not change drag-and-drop (`studyPlanReorder.mjs`) or task CRUD.

- [ ] **Step 3: Add a "Jump to today" control**

Above the day list, add:

```jsx
          <button
            type="button"
            className="sp-jump-today"
            onClick={() => document.querySelector('.sp-day--today')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            Jump to today ↓
          </button>
```

- [ ] **Step 4: Add day-board styles to `client/src/styles.css`**

```css
.sp-day--today { box-shadow: inset 3px 0 0 var(--primary); background: var(--primary-lt); }
.sp-day--done { opacity: 0.62; }
.sp-day--done:hover { opacity: 1; }
.sp-jump-today {
  align-self: flex-end; margin-bottom: 8px; background: transparent; border: 1px solid var(--border);
  border-radius: 999px; padding: 4px 12px; cursor: pointer;
  font-size: 0.72rem; font-weight: 600; color: var(--primary);
}
.sp-jump-today:hover { background: var(--primary-lt); }
```

> The `inset 3px 0 0` left-edge marks the current day — this is the sanctioned status semantic (like the info callout), not a decorative stripe.

- [ ] **Step 5: Verify (lint + browser)**

Run: `npm run lint` → 0 errors.
Browser: open `#study-plan`; confirm today's day card is highlighted with a sage left-edge + tint, each day header shows a small progress ring, fully-completed days are dimmed (and un-dim on hover), "Jump to today" scrolls to the highlighted day, and drag-to-reorder + task check/edit/delete all still work.

- [ ] **Step 6: Commit**

```bash
git add client/src/StudyPlan.jsx client/src/styles.css
git commit -m "feat(study-plan): scannable day-board — today highlight, per-day progress, completed dimming"
```

---

## Self-Review

**Spec coverage:**
- Overview hero band + trend + weakness + drill → Tasks 1, 3. ✓
- Subject sparklines → Task 3. ✓
- Category inline bars → Task 5; sortable headers already existed (noted, not rebuilt). ✓
- Error Log sticky filters → Task 6. ✓
- Review modal polish, semantic untouched → Task 7. ✓
- Pattern analysis ranked insight + drilldown polish → Task 8. ✓
- Today's Plan unified/progress → Task 4. ✓
- Study Plan drift paydown (tokens), mock date humanize, brass delta → Task 9. ✓
- Study Plan day-board scannability → Task 10. ✓
- Nav scroll-spy → Task 4. ✓
- Motion `prefers-reduced-motion` guard → Tasks 2, 4. ✓
- Client-side data only, no backend → all tasks. ✓
- Unit tests for pure helpers → Tasks 1, 9. ✓

**Type/name consistency:** `buildAccuracyTrend`/`pickWeakestCategory` signatures match between Task 1 (definition) and Task 3 (use). `formatMockDate` matches between Task 9 test, impl, and use. `MiniBar`/`Sparkline`/`ProgressRing`/`HeroBand` prop names consistent across tasks. `--accent-ink` defined once (Task 3), reused (Task 9).

**Assumptions to verify at execution time (flagged inline, not placeholders):** the exact identifiers `sessionRows`, the error-log subject-filter setter, and per-session `subject` field — each task notes the grep to confirm and a graceful fallback if absent. These are integration points into an existing 5197-line file, resolvable only against live scope; every one has a stated default.

---

## Execution Handoff

Implement phase-by-phase with a browser review after each phase (the user chose phased delivery). Within a phase, follow each task's steps in order.
