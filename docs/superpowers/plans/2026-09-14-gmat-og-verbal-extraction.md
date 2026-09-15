# GMAT OG Verbal Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn three GMAT Official Guide PDFs into `data/gmat-og-questions.json` — a validated pool of Critical Reasoning and Reading Comprehension questions with official answer keys, question-type labels, full answer explanations, RC passages with line numbers, and LLM-assigned difficulty.

**Architecture:** Five offline stages, each a plain CommonJS module under `scripts/og/` with a thin CLI on top. Text comes from `pdftotext -raw`; RC passage geometry and CR boldface spans come from pdfplumber. Every answer key is derived twice — once from the book's printed key list, once from the answer-explanations prose — and the two must agree before a question enters the pool.

**Tech Stack:** Node 20 (CommonJS, `node:test`), `pdftotext` (poppler, already installed), `ocrmypdf` + Tesseract 5 (to install), Python 3 + pdfplumber (already installed), the repo's existing LangChain/OpenAI plumbing for the difficulty pass.

**Spec:** [docs/superpowers/specs/2026-09-14-gmat-og-verbal-extraction-design.md](../specs/2026-09-14-gmat-og-verbal-extraction-design.md)

**Scope note:** This plan covers extraction only — stages 0 through 4 of the spec, ending at a validated JSON pool and a parse report. The practice track (migration `0010`, `src/og-dashboard.js`, `/api/og/*`, `GmatOgPractice.jsx`) is a separate plan, written after this pool exists so the set builder is designed against the real type-label distribution rather than estimates.

## Global Constraints

- **This repository is public.** The three source PDFs are copyrighted and must never be committed. Task 1 handles this and must land before anything else.
- All generated data is gitignored: `/data/gmat-og-questions.json*`, `/docs/ocr/`, `/docs/*.pdf`.
- Scratch artifacts go in `tmp/` at the repo root, never the repo root itself, never `data/`. Clean up at task end. (CLAUDE.md, "Temp file convention")
- Backend code is CommonJS. `scripts/**/*.js` is linted with Node globals as CJS; new modules go there as `.js`, not `.mjs`, so `npm test` (`node --test "test/unit/*.test.js"`) picks up their tests.
- Test files need a file-local `/* global require */` directive — `eslint.config.mjs` is edit-protected by the ECC `config-protection` hook.
- Lint baseline is 0 errors. New code must not add errors.
- Book codes are exactly `OG12`, `OG13`, `VR2`. Subject kinds are exactly `CR`, `RC`.
- Question ids are `<book>-<kind>-<number>`, e.g. `OG13-CR-56`.

## Source facts established during design

These were verified against the actual PDFs. Trust them over assumptions.

**Chapter numbering** — RC then CR, with three sub-sections each:

| Book | RC ch. | CR ch. | Practice suffix | Key suffix | Explanations suffix |
|---|---|---|---|---|---|
| OG12 | 7 | 8 | `.4 Sample Questions` | `.5 Answer Key` | `.6 Answer Explanations` |
| OG13 | 7 | 8 | `.4 Practice Questions` | `.5 Answer Key` | `.6 Answer Explanations` |
| VR2 | 3 | 4 | `.4 Sample Questions` | `.5 Answer Key` | `.6 Answer Explanations` |

**Section headers recur as running heads inside the body text.** `8.4 Critical Reasoning Practice Questions` appears mid-question on nearly every page of that section. The first occurrence is the region boundary; every later one is junk to strip.

**VR2's OCR mangles its own running heads differently on nearly every page:** `3.4 Reading Comprehension Sample Que sti ons`, `3.0 Reading Comprehensio n`, `4.4 Critica l Reasoning Sam ple Questions`. Header matching must collapse all whitespace before comparing.

**Answer keys come in two layouts.**

- OG12 and OG13 print one entry per line:
  ```
  7.5 Answer Key
  1. C
  2. D
  3. B
  ```
- VR2 prints a four-column grid, and its OCR corrupts both numerals and letters:
  ```
  I. C 27. B 53. 0 79. E
  2. 0 28. 0 54. E 80. C
  II. C 37. C 63. E 89. B
  2I. E 47. C 73. A 99. A
  25. B 5I. C 77. B 103. E
  ```
  `I.` is `1.`, `II.` is `11.`, `2I.` is `21.`, `lOI.` is `101.`, and a bare `0` in the letter position is `D`.

**OG13's CR answer key (section 8.5) is unrecoverable from the current text layer.** It is a rotated table that OCR rendered as line noise:
```
CO CO O UJ GO O O U J O O O O C 0 < O O < O O C 0 O l U L U U J O O L l J C 0 O C 0
^ i o d N o 6 " c ^ O r t ' ^ ^ ^ ^ ^ ^ w o i d i H ( \ i ( r ) ^ ' i x ) ^ i N o d c f t d r H c y j r o ^
```
OG13's RC key (7.5) is fine. This is why the explanation-derived key must be able to stand alone — for OG13 CR it is the *only* key source unless re-OCR rescues the table.

**Choice labels are systematically misread in the scanned books.** OG13 has 418 lines beginning `(0 ` where `(C)` was printed; VR2 has 394 beginning `(8)` where `(B)` was printed.

**OG13 carries a watermark line** `QQ:1014347461制作`, sometimes glued to the start of real text.

**Explanation sections carry, per question:** a type label on its own line (`Argument Construction`, `Argument Evaluation`, `Evaluation of a Plan`, `Evaluation`, `Inference`, `Main idea`, `Supporting ideas`, `Supporting idea`, `Logical structure`, `Application`, `Style and tone`), then `Situation` and `Reasoning` blocks, then one rationale per choice where exactly one opens with `Correct.`, then a `The correct answer is X.` line. In OG12 that last line sometimes loses its spaces: `ThecorrectanswerisB.`

**RC explanations do not repeat the passage.** They say `Questions 1-3 refer to the passage on page 358.` and cite `Lines 26-28`. RC passages come from the practice section via pdfplumber geometry.

---

## File Structure

| File | Responsibility |
|---|---|
| `.gitignore` | keep the copyrighted PDFs and generated pool out of a public repo |
| `scripts/og/books.js` | the per-book constants table: code, title, file path, chapter numbers, section suffixes |
| `scripts/og/text.js` | text normalization shared by every parser — whitespace collapse, OCR label repair, watermark and running-head stripping |
| `scripts/og/regions.js` | slice a book's raw text into `{practice, key, explanations}` per subject |
| `scripts/og/answer-key.js` | parse both key layouts into `{number: letter}`, repairing OCR digits |
| `scripts/og/questions.js` | parse a practice region into `{number, stem, choices}` records |
| `scripts/og/explanations.js` | parse an explanations region into `{number, typeLabel, situation, reasoning, choiceNotes, key}` records |
| `scripts/og/assemble.js` | join the three parses, cross-check the two keys, build the book object, produce the report data |
| `scripts/parse-og-pdf.js` | CLI: read PDFs, drive `assemble`, write JSON + `tmp/og-parse-report.md` |
| `scripts/extract-og-passages.py` | pdfplumber pass: RC passages with line numbers, CR boldface spans |
| `scripts/dedup-og-questions.js` | cross-edition dedup — CR per question, RC per passage group |
| `scripts/classify-og-difficulty.js` | one-shot LLM difficulty pass |
| `test/unit/og-text.test.js` | normalization and OCR-repair behaviour |
| `test/unit/og-regions.test.js` | region boundaries and running-head handling |
| `test/unit/og-answer-key.test.js` | both key layouts, OCR digit repair, count self-check |
| `test/unit/og-questions.test.js` | question starts, choice parsing, junk rejection |
| `test/unit/og-explanations.test.js` | type labels, `Correct.` key, `The correct answer is` key |
| `test/unit/og-assemble.test.js` | key cross-check, dispute flagging, stem fallback |
| `test/unit/og-dedup.test.js` | CR question dedup, RC whole-group dedup |

Parsers are separate modules because each has a different failure mode and a different test corpus, and because a 800-line single file (the shape `parse-lsat-pdf.js` grew into) is hard to change safely. `assemble.js` is the only module that knows about all three.

---

### Task 1: Keep the PDFs out of the public repo

The repository is public and `.gitignore`'s `/*.pdf` rule only covers the root. The three books sit in `docs/`, untracked but unignored — one `git add -A` publishes 217MB of copyrighted material. Nothing else in this plan may start until this lands.

**Files:**
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: nothing importable; a repository-safety precondition every later task depends on

- [ ] **Step 1: Confirm the hazard is real**

```bash
cd /Users/pletopichaiyoot/Desktop/codespace/gmat-error-log
git check-ignore -v docs/OG13.pdf ; echo "exit=$?"
```

Expected: no output, `exit=1` — meaning the file is **not** ignored. If it prints a rule, the hazard is already handled; note that and skip to Step 4.

- [ ] **Step 2: Widen the rule**

In `.gitignore`, find the block:

```
# Copyrighted study materials & personal docs — never publish (public repo)
/data/lsat-questions.json
/data/ai-practice-sets/*.json
/*.pdf
```

Add three lines directly under `/*.pdf`:

```
/docs/*.pdf
/docs/ocr/
/data/gmat-og-questions.json*
```

- [ ] **Step 3: Verify all three books and the future outputs are now ignored**

```bash
git check-ignore -v docs/OG13.pdf \
  "docs/The official guide for gmat review, 12th edition.pdf" \
  "docs/The Official Guide for GMAT Verbal Review, 2nd edition.pdf" \
  docs/ocr/OG13.ocr.pdf data/gmat-og-questions.json
```

Expected: five lines, each naming the rule that matched.

- [ ] **Step 4: Confirm no PDF ever entered history**

```bash
git log --all --diff-filter=A --name-only --pretty=format: -- '*.pdf' | sort -u
```

Expected: empty. If it lists anything, **stop and report** — a copyrighted file is in the public history and removing it needs a decision from the repo owner, not a rewrite done silently.

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore OG source PDFs and generated question pool

The repo is public and the /*.pdf rule only covered the root, leaving the
three copyrighted Official Guide PDFs in docs/ untracked but unignored."
```

---

### Task 2: Re-OCR the two scanned books

OG12's text layer is native and clean. OG13 and Verbal Review 2e are OCR from 2009-2012 scanners: spaces dropped, `(C)` read as `(0`, `(B)` read as `(8)`, and OG13's CR answer key rendered as line noise. `--redo-ocr` replaces that layer with Tesseract 5's.

This task ends in a measurement, not an assumption: a probe script reports whether the corruption actually dropped, and that number decides how much repair logic the later parsers must carry.

**Files:**
- Create: `scripts/og/ocr-quality.js`
- Create: `test/unit/og-ocr-quality.test.js`
- Create (generated, gitignored): `docs/ocr/OG13.ocr.pdf`, `docs/ocr/VerbalReview2e.ocr.pdf`

**Interfaces:**
- Consumes: nothing
- Produces: `module.exports = { scoreText }` where `scoreText(text) -> {lines, badChoiceC, badChoiceB, badKeyNumerals, glued, watermark, noise}`; all counts are integers. Later tasks do not import this — it exists to make the OCR decision evidence-based and repeatable.

- [ ] **Step 1: Write the failing test**

Create `test/unit/og-ocr-quality.test.js`:

```js
// test/unit/og-ocr-quality.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { scoreText } = require('../../scripts/og/ocr-quality');

test('scoreText counts misread choice labels', () => {
  const s = scoreText([
    '(A) first choice',
    '(8) second choice',
    '(0 third choice',
    '(D) fourth choice',
  ].join('\n'));
  assert.equal(s.badChoiceB, 1);
  assert.equal(s.badChoiceC, 1);
});

test('scoreText counts corrupted answer-key numerals', () => {
  // VR2 reads 1. as I., 11. as II., 21. as 2I., 101. as lOI.
  const s = scoreText('I. C 27. B\nII. C 37. C\n2I. E 47. C\nlOI. B 102. C');
  assert.equal(s.badKeyNumerals, 4);
});

test('scoreText counts glued words and the OG13 watermark', () => {
  const s = scoreText('Theargumentisconcerned with whathappens\nQQ:1014347461制作8.6 Answer Explanations');
  assert.ok(s.glued >= 1, 'expected a glued-word line');
  assert.equal(s.watermark, 1);
});

test('scoreText flags OCR line noise like the rotated OG13 CR key', () => {
  const s = scoreText('CO CO O UJ GO O O U J O O O O C 0 < O O < O O C 0 O l U L U U J\nnormal readable sentence here');
  assert.equal(s.noise, 1);
});

test('scoreText reports zero on clean text', () => {
  const s = scoreText('(A) first choice\n(B) second choice\n1. C\n2. D');
  assert.equal(s.badChoiceB + s.badChoiceC + s.badKeyNumerals + s.noise + s.watermark, 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- --test-name-pattern='scoreText'
```

Expected: FAIL — `Cannot find module '../../scripts/og/ocr-quality'`.

- [ ] **Step 3: Implement**

Create `scripts/og/ocr-quality.js`:

```js
// scripts/og/ocr-quality.js
// Measures how badly a book's text layer is corrupted, so the re-OCR decision
// and the amount of repair logic downstream are based on counts, not vibes.

// A line is "noise" when it is mostly single characters separated by spaces —
// the shape OCR produces from a rotated table (see OG13 section 8.5).
function isNoiseLine(line) {
  const toks = line.trim().split(/\s+/);
  if (toks.length < 12) return false;
  const singles = toks.filter(t => t.length === 1).length;
  return singles / toks.length > 0.6;
}

// A line is "glued" when it contains a long run of letters with an internal
// capital or a known joined function word — "Theargumentisconcerned".
function isGluedLine(line) {
  return /[a-z]{4,}(?:the|and|that|with|of|is|in|to|for)[a-z]{3,}/i.test(line)
    || /\b[a-z]{12,}\b/.test(line);
}

function scoreText(text) {
  const lines = String(text).split('\n');
  let badChoiceC = 0, badChoiceB = 0, badKeyNumerals = 0;
  let glued = 0, watermark = 0, noise = 0;

  for (const line of lines) {
    if (/^\(0\s/.test(line)) badChoiceC++;
    if (/^\(8\)/.test(line)) badChoiceB++;
    // Key-grid numerals: a token in "<number>." position built from I/l/O
    // instead of digits, e.g. "I.", "II.", "2I.", "lOI."
    const m = line.match(/(?:^|\s)((?=[0-9IlO]*[IlO])[0-9IlO]{1,4})\.\s/g);
    if (m) badKeyNumerals += m.length;
    if (line.includes('QQ:1014347461')) watermark++;
    if (isNoiseLine(line)) noise++;
    else if (isGluedLine(line)) glued++;
  }

  return { lines: lines.length, badChoiceC, badChoiceB, badKeyNumerals, glued, watermark, noise };
}

module.exports = { scoreText, isNoiseLine, isGluedLine };
```

- [ ] **Step 4: Run the tests and make them pass**

```bash
npm test -- --test-name-pattern='scoreText'
```

Expected: 5 passing.

- [ ] **Step 5: Record the before-scores**

```bash
mkdir -p tmp/og
cd /Users/pletopichaiyoot/Desktop/codespace/gmat-error-log
for f in docs/OG13.pdf "docs/The Official Guide for GMAT Verbal Review, 2nd edition.pdf"; do
  pdftotext -raw "$f" - 2>/dev/null > "tmp/og/before-$(basename "$f" .pdf).txt"
done
node -e '
const fs=require("fs"),{scoreText}=require("./scripts/og/ocr-quality");
for (const f of fs.readdirSync("tmp/og").filter(n=>n.startsWith("before-")))
  console.log(f, JSON.stringify(scoreText(fs.readFileSync("tmp/og/"+f,"utf-8"))));
'
```

Expected, roughly: OG13 `badChoiceC ≈ 418`, `watermark` in the hundreds, `noise` > 0; VR2 `badChoiceB ≈ 394`, `badKeyNumerals` in the hundreds. Save this output — Step 8 compares against it.

- [ ] **Step 6: Install ocrmypdf**

```bash
brew install ocrmypdf
ocrmypdf --version && tesseract --version | head -1
```

Expected: a version for each. This pulls tesseract, ghostscript and qpdf (~1GB).

- [ ] **Step 7: Re-OCR both books**

```bash
mkdir -p docs/ocr
ocrmypdf --redo-ocr --rotate-pages --language eng \
  docs/OG13.pdf docs/ocr/OG13.ocr.pdf
ocrmypdf --redo-ocr --rotate-pages --language eng \
  "docs/The Official Guide for GMAT Verbal Review, 2nd edition.pdf" \
  docs/ocr/VerbalReview2e.ocr.pdf
```

**Do not add `--deskew`** — ocrmypdf refuses it alongside `--redo-ocr` ("not
currently compatible with --deskew, --clean-final, and --remove-background")
and exits immediately. **Do not pipe the command into `tail`** either: the pipe
reports `tail`'s exit status, so a refusal like that looks like success.

`--rotate-pages` may help OG13's rotated CR answer key, though it rotates whole
pages by detected text orientation and the key is a rotated table inside an
otherwise upright page — treat outcome (b) below as the likely one. Each run
takes 20-40 minutes; run them one at a time so a failure is attributable.

- [ ] **Step 8: Measure the after-scores and decide**

```bash
for f in docs/ocr/*.ocr.pdf; do
  pdftotext -raw "$f" - 2>/dev/null > "tmp/og/after-$(basename "$f" .ocr.pdf).txt"
done
node -e '
const fs=require("fs"),{scoreText}=require("./scripts/og/ocr-quality");
for (const f of fs.readdirSync("tmp/og").sort())
  console.log(f.padEnd(34), JSON.stringify(scoreText(fs.readFileSync("tmp/og/"+f,"utf-8"))));
'
```

Then check specifically whether OG13's CR answer key became readable:

```bash
grep -n -A6 "8.5 Answer Key" tmp/og/after-OG13.txt | head -20
```

Record which of these three outcomes holds — later tasks branch on it:

- **(a) Corruption largely gone and OG13's CR key is readable.** Use the re-OCR'd text everywhere; the OCR-repair paths in Tasks 4 and 5 stay as defensive fallbacks.
- **(b) Corruption reduced but OG13's CR key is still noise.** Use the re-OCR'd text; OG13 CR takes its key from the explanations alone (Task 7 already supports this).
- **(c) No meaningful improvement.** Keep the original text layer, delete `docs/ocr/`, and rely fully on the repair logic in Tasks 4 and 5. Report this — it raises the chance Verbal Review 2e fails acceptance later.

- [ ] **Step 9: Commit**

```bash
git add scripts/og/ocr-quality.js test/unit/og-ocr-quality.test.js
git commit -m "feat(og): add OCR quality probe for the scanned OG books

Counts misread choice labels, corrupted key numerals, glued words, the OG13
watermark and rotated-table line noise, so the re-OCR decision is measured."
```

Note the chosen outcome (a/b/c) in the commit body.

---

### Task 3: Book constants and shared text normalization

Every later parser needs the same two things: a table saying where each book keeps its chapters, and a normalizer that undoes the OCR damage. Putting them first means the parsers never re-derive them.

**Files:**
- Create: `scripts/og/books.js`
- Create: `scripts/og/text.js`
- Create: `test/unit/og-text.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `books.js` — `module.exports = { BOOKS, bookByCode }`; `BOOKS` is an array of `{code, title, pdf, ocrPdf, chapters: {RC: number, CR: number}, practiceSuffix, keySuffix, explanationsSuffix}`; `bookByCode(code) -> book | undefined`
  - `text.js` — `module.exports = { squash, repairChoiceLabels, repairKeyNumeral, stripWatermark, isRunningHead, normalizeLine }`
    - `squash(s) -> string` — lowercase, every whitespace run removed
    - `repairChoiceLabels(line) -> string`
    - `repairKeyNumeral(token) -> string`
    - `stripWatermark(line) -> string`
    - `isRunningHead(line, headings) -> boolean` where `headings` is an array of strings
    - `normalizeLine(line) -> string` — watermark strip then choice repair

- [ ] **Step 1: Write the failing test**

Create `test/unit/og-text.test.js`:

```js
// test/unit/og-text.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  squash, repairChoiceLabels, repairKeyNumeral, stripWatermark,
  isRunningHead, normalizeLine,
} = require('../../scripts/og/text');

test('squash makes VR2 mangled headings comparable', () => {
  // VR2 OCR breaks its own running heads in a different place on every page.
  assert.equal(squash('3.4 Reading Comprehension Sample Que sti ons'),
               squash('3.4 Reading Comprehension Sample Questions'));
  assert.equal(squash('4.4 Critica l Reasoning Sam ple Questions'),
               squash('4.4 Critical Reasoning Sample Questions'));
});

test('repairChoiceLabels fixes the two systematic misreads', () => {
  assert.equal(repairChoiceLabels('(0 The flute was made from a cave-bear bone'),
               '(C) The flute was made from a cave-bear bone');
  assert.equal(repairChoiceLabels('(8) The flesh of SPK004 differs'),
               '(B) The flesh of SPK004 differs');
});

test('repairChoiceLabels leaves correct labels and mid-line parens alone', () => {
  assert.equal(repairChoiceLabels('(C) already correct'), '(C) already correct');
  assert.equal(repairChoiceLabels('a drop of (0.5) percent'), 'a drop of (0.5) percent');
});

test('repairKeyNumeral rebuilds VR2 key numbers', () => {
  assert.equal(repairKeyNumeral('I'), '1');
  assert.equal(repairKeyNumeral('II'), '11');
  assert.equal(repairKeyNumeral('2I'), '21');
  assert.equal(repairKeyNumeral('5I'), '51');
  assert.equal(repairKeyNumeral('lOI'), '101');
  assert.equal(repairKeyNumeral('104'), '104');
});

test('stripWatermark removes the OG13 mark even when glued to real text', () => {
  assert.equal(stripWatermark('QQ:1014347461制作8.6 Answer Explanations'),
               '8.6 Answer Explanations');
  assert.equal(stripWatermark('ordinary line'), 'ordinary line');
});

test('isRunningHead matches whitespace-insensitively', () => {
  const heads = ['8.4 Critical Reasoning Practice Questions'];
  assert.equal(isRunningHead('8.4 Critical Reasoning PracticeQuestions', heads), true);
  assert.equal(isRunningHead('8.4 Critical Reasoning Practice Questions', heads), true);
  assert.equal(isRunningHead('(A) a real answer choice', heads), false);
});

test('normalizeLine strips the watermark before repairing labels', () => {
  assert.equal(normalizeLine('QQ:1014347461制作(0 a choice'), '(C) a choice');
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- --test-name-pattern='squash|repair|Watermark|RunningHead|normalizeLine'
```

Expected: FAIL — `Cannot find module '../../scripts/og/text'`.

- [ ] **Step 3: Implement `scripts/og/text.js`**

```js
// scripts/og/text.js
// Normalization shared by every OG parser. The OCR damage in OG13 and Verbal
// Review 2e is systematic, so it is repaired in one place rather than in each
// parser's own regexes.

const WATERMARK = /QQ:\d{6,}制作/g;

// Collapse to a comparable key: OCR splits words inside running heads at a
// different point on nearly every VR2 page, so only the letters matter.
function squash(s) {
  return String(s).toLowerCase().replace(/\s+/g, '');
}

function stripWatermark(line) {
  return String(line).replace(WATERMARK, '');
}

// "(0 text"  -> "(C) text"   (OG13: C read as 0, closing paren lost)
// "(8) text" -> "(B) text"   (VR2: B read as 8)
// Anchored at line start so "(0.5)" mid-sentence is untouched.
function repairChoiceLabels(line) {
  return String(line)
    .replace(/^\(0(?=\s)/, '(C)')
    .replace(/^\(8\)/, '(B)');
}

// VR2's key grid reads 1 as I, 11 as II, 21 as 2I, 101 as lOI.
// Only I, l and O are ambiguous; everything else is already a digit.
function repairKeyNumeral(token) {
  const t = String(token);
  if (/^\d+$/.test(t)) return t;
  if (!/^[0-9IlO]+$/.test(t)) return t;
  return t.replace(/[Il]/g, '1').replace(/O/g, '0');
}

function isRunningHead(line, headings) {
  const k = squash(stripWatermark(line));
  if (!k) return false;
  return headings.some(h => k === squash(h) || k.startsWith(squash(h)));
}

function normalizeLine(line) {
  return repairChoiceLabels(stripWatermark(line));
}

module.exports = {
  squash, stripWatermark, repairChoiceLabels, repairKeyNumeral,
  isRunningHead, normalizeLine,
};
```

- [ ] **Step 4: Run the tests and make them pass**

```bash
npm test -- --test-name-pattern='squash|repair|Watermark|RunningHead|normalizeLine'
```

Expected: 7 passing. `repairKeyNumeral('lOI')` is the one to watch — `l`→`1`, `O`→`0`, `I`→`1` gives `101`.

- [ ] **Step 5: Implement `scripts/og/books.js`**

```js
// scripts/og/books.js
// Where each book keeps its CR and RC material. Chapter numbers and section
// suffixes were read off the actual PDFs; see the plan's "Source facts".

const path = require('path');
const DOCS = path.join(__dirname, '..', '..', 'docs');

const BOOKS = [
  {
    code: 'OG12',
    title: 'The Official Guide for GMAT Review, 12th Edition',
    pdf: path.join(DOCS, 'The official guide for gmat review, 12th edition.pdf'),
    ocrPdf: null,                       // native text layer; never re-OCR'd
    chapters: { RC: 7, CR: 8 },
    practiceSuffix: 'Sample Questions',
    keySuffix: 'Answer Key',
    explanationsSuffix: 'Answer Explanations',
  },
  {
    code: 'OG13',
    title: 'The Official Guide for GMAT Review, 13th Edition',
    pdf: path.join(DOCS, 'OG13.pdf'),
    ocrPdf: path.join(DOCS, 'ocr', 'OG13.ocr.pdf'),
    chapters: { RC: 7, CR: 8 },
    practiceSuffix: 'Practice Questions',
    keySuffix: 'Answer Key',
    explanationsSuffix: 'Answer Explanations',
  },
  {
    code: 'VR2',
    title: 'The Official Guide for GMAT Verbal Review, 2nd Edition',
    pdf: path.join(DOCS, 'The Official Guide for GMAT Verbal Review, 2nd edition.pdf'),
    ocrPdf: path.join(DOCS, 'ocr', 'VerbalReview2e.ocr.pdf'),
    chapters: { RC: 3, CR: 4 },
    practiceSuffix: 'Sample Questions',
    keySuffix: 'Answer Key',
    explanationsSuffix: 'Answer Explanations',
  },
];

function bookByCode(code) {
  return BOOKS.find(b => b.code === code);
}

module.exports = { BOOKS, bookByCode };
```

- [ ] **Step 6: Sanity-check the constants against the real files**

```bash
node -e '
const {BOOKS}=require("./scripts/og/books"),fs=require("fs");
for (const b of BOOKS) console.log(b.code, fs.existsSync(b.pdf) ? "pdf ok" : "PDF MISSING");
'
```

Expected: three `pdf ok` lines.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint 2>&1 | tail -3
git add scripts/og/books.js scripts/og/text.js test/unit/og-text.test.js
git commit -m "feat(og): add book constants and shared OCR text normalization"
```

Expected from lint: no new errors (warnings in legacy files are the existing baseline).

---

### Task 4: Region locator

Slice one book's raw text into the practice, key and explanations regions for one subject. The trap is that section headers recur as running heads on nearly every page of their own section, so a naive "find the header" returns a match from the middle of the body.

**Files:**
- Create: `scripts/og/regions.js`
- Create: `test/unit/og-regions.test.js`

**Interfaces:**
- Consumes: `scripts/og/text.js` (`squash`, `isRunningHead`, `stripWatermark`), `scripts/og/books.js`
- Produces: `module.exports = { findRegions, headingsFor }`
  - `headingsFor(book, kind) -> {practice: string, key: string, explanations: string}` — the three full heading strings, e.g. `'8.4 Practice Questions'`
  - `findRegions(lines, book, kind) -> {practice: string[], key: string[], explanations: string[]}` — arrays of lines with running heads and watermarks already removed. Throws `Error` naming the missing heading if a region cannot be located.

- [ ] **Step 1: Write the failing test**

Create `test/unit/og-regions.test.js`:

```js
// test/unit/og-regions.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { findRegions, headingsFor } = require('../../scripts/og/regions');
const { bookByCode } = require('../../scripts/og/books');

const OG13 = bookByCode('OG13');
const VR2 = bookByCode('VR2');

test('headingsFor composes chapter number and suffix per book', () => {
  assert.deepEqual(headingsFor(OG13, 'CR'), {
    practice: '8.4 Practice Questions',
    key: '8.5 Answer Key',
    explanations: '8.6 Answer Explanations',
  });
  assert.deepEqual(headingsFor(VR2, 'RC'), {
    practice: '3.4 Sample Questions',
    key: '3.5 Answer Key',
    explanations: '3.6 Answer Explanations',
  });
});

test('findRegions splits on the first heading, not a running head', () => {
  const lines = [
    '8.4 Practice Questions',
    '1. A question stem.',
    '(A) one',
    '8.4 Critical Reasoning Practice Questions',   // running head, mid-body
    '(B) two',
    '8.5 Answer Key',
    '1. B',
    '8.6 Answer Explanations',
    '1. A question stem.',
  ];
  const r = findRegions(lines, OG13, 'CR');
  assert.deepEqual(r.practice, ['1. A question stem.', '(A) one', '(B) two']);
  assert.deepEqual(r.key, ['1. B']);
  assert.deepEqual(r.explanations, ['1. A question stem.']);
});

test('findRegions strips VR2 running heads broken at random points', () => {
  const lines = [
    '3.4 Sample Questions',
    'The primary purpose of the passage is to',
    '3.4 Reading Comprehension Sample Que sti ons',
    '(A) one',
    '3.5 Answer Key',
    'I. C',
    '3.6 Answer Explanations',
    'done',
  ];
  const r = findRegions(lines, VR2, 'RC');
  assert.deepEqual(r.practice, ['The primary purpose of the passage is to', '(A) one']);
});

test('findRegions strips the OG13 watermark from region content', () => {
  const lines = [
    '8.4 Practice Questions',
    'QQ:1014347461制作(0 a choice',
    '8.5 Answer Key',
    '1. C',
    '8.6 Answer Explanations',
    'x',
  ];
  const r = findRegions(lines, OG13, 'CR');
  assert.deepEqual(r.practice, ['(C) a choice']);
});

test('findRegions throws naming the heading it could not find', () => {
  const lines = ['8.4 Practice Questions', '1. stem', '8.6 Answer Explanations', 'x'];
  assert.throws(() => findRegions(lines, OG13, 'CR'), /8\.5 Answer Key/);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- --test-name-pattern='findRegions|headingsFor'
```

Expected: FAIL — `Cannot find module '../../scripts/og/regions'`.

- [ ] **Step 3: Implement `scripts/og/regions.js`**

```js
// scripts/og/regions.js
// Slice a book's text into the practice / key / explanations regions for one
// subject. Section headings recur as running heads throughout their own
// section, so the FIRST occurrence is the boundary and every later one is junk.

const { squash, isRunningHead, normalizeLine } = require('./text');

function headingsFor(book, kind) {
  const ch = book.chapters[kind];
  return {
    practice: `${ch}.4 ${book.practiceSuffix}`,
    key: `${ch}.5 ${book.keySuffix}`,
    explanations: `${ch}.6 ${book.explanationsSuffix}`,
  };
}

// The heading is printed bare ("8.5 Answer Key") and also as a running head
// carrying the subject name ("8.4 Critical Reasoning Practice Questions") and
// sometimes with a trailing page number. Match on prefix after squashing.
function firstIndexOf(lines, heading, from) {
  const want = squash(heading);
  for (let i = from; i < lines.length; i++) {
    const k = squash(lines[i]);
    if (k.startsWith(want)) return i;
  }
  return -1;
}

function findRegions(lines, book, kind) {
  const h = headingsFor(book, kind);
  const ch = book.chapters[kind];

  // Every heading in this chapter doubles as a running head to strip.
  const runningHeads = [
    h.practice, h.key, h.explanations,
    `${ch}.4 `, `${ch}.5 `, `${ch}.6 `,
  ];

  const iPractice = firstIndexOf(lines, h.practice, 0);
  if (iPractice < 0) throw new Error(`Could not locate heading: ${h.practice}`);
  const iKey = firstIndexOf(lines, h.key, iPractice + 1);
  if (iKey < 0) throw new Error(`Could not locate heading: ${h.key}`);
  const iExpl = firstIndexOf(lines, h.explanations, iKey + 1);
  if (iExpl < 0) throw new Error(`Could not locate heading: ${h.explanations}`);

  const clean = (from, to) => lines
    .slice(from, to)
    .map(normalizeLine)
    .filter(l => l.trim() !== '' && !isRunningHead(l, runningHeads));

  return {
    practice: clean(iPractice + 1, iKey),
    key: clean(iKey + 1, iExpl),
    explanations: clean(iExpl + 1, lines.length),
  };
}

module.exports = { findRegions, headingsFor };
```

- [ ] **Step 4: Run the tests and make them pass**

```bash
npm test -- --test-name-pattern='findRegions|headingsFor'
```

Expected: 5 passing.

- [ ] **Step 5: Run it against all three real books**

```bash
node -e '
const fs=require("fs"),cp=require("child_process");
const {BOOKS}=require("./scripts/og/books"),{findRegions}=require("./scripts/og/regions");
for (const b of BOOKS) {
  const src = b.ocrPdf && fs.existsSync(b.ocrPdf) ? b.ocrPdf : b.pdf;
  const lines = cp.execFileSync("pdftotext",["-raw",src,"-"],{maxBuffer:1<<28}).toString().split("\n");
  for (const kind of ["RC","CR"]) {
    try { const r=findRegions(lines,b,kind);
      console.log(b.code,kind,"practice",r.practice.length,"key",r.key.length,"expl",r.explanations.length);
    } catch(e){ console.log(b.code,kind,"ERROR",e.message); }
  }
}'
```

Expected: six lines, every region non-empty. Key regions should be roughly 100-160 lines for OG12/OG13 (one entry per line) and ~26 lines for VR2 RC (a four-column grid). **If OG13 CR's key region is dozens of lines of noise, that confirms outcome (b) from Task 2** — expected, and Task 8 handles it.

The `explanations` region runs to end of file rather than to the next chapter. That is deliberate: the explanations are the last sub-section of their chapter, and Task 7's parser stops at the last numbered question it can key. Chapter 9's material after it contains no `N.`-numbered items with choice blocks, so it contributes nothing.

- [ ] **Step 6: Commit**

```bash
git add scripts/og/regions.js test/unit/og-regions.test.js
git commit -m "feat(og): locate practice/key/explanation regions per book and subject

First heading occurrence is the boundary; later ones are running heads, which
VR2's OCR breaks at a different point on nearly every page."
```

---

### Task 5: Answer-key parser

Two layouts, and the second is corrupted. OG12 and OG13 print one `N. X` per line. VR2 prints a four-column grid whose OCR reads `1.` as `I.` and the letter `D` as `0`.

**Files:**
- Create: `scripts/og/answer-key.js`
- Create: `test/unit/og-answer-key.test.js`

**Interfaces:**
- Consumes: `scripts/og/text.js` (`repairKeyNumeral`)
- Produces: `module.exports = { parseAnswerKey, detectKeyLayout }`
  - `detectKeyLayout(lines) -> 'single' | 'grid' | 'unreadable'`
  - `parseAnswerKey(lines) -> {layout, keys: Map<number,string>, skipped: string[]}` — `keys` maps question number to an `A`-`E` letter; `skipped` holds lines that yielded nothing, for the report. Never throws; an unreadable region returns an empty map with `layout: 'unreadable'` so the caller can fall back to the explanation-derived key.

- [ ] **Step 1: Write the failing test**

Create `test/unit/og-answer-key.test.js`:

```js
// test/unit/og-answer-key.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { parseAnswerKey, detectKeyLayout } = require('../../scripts/og/answer-key');

test('single-column layout, one entry per line (OG12, OG13)', () => {
  const r = parseAnswerKey(['1. C', '2. D', '3. B', '4. E']);
  assert.equal(r.layout, 'single');
  assert.equal(r.keys.get(1), 'C');
  assert.equal(r.keys.get(4), 'E');
  assert.equal(r.keys.size, 4);
});

test('grid layout reads four columns per line (VR2)', () => {
  const r = parseAnswerKey(['1. C 27. B 53. D 79. E', '2. D 28. D 54. E 80. C']);
  assert.equal(r.layout, 'grid');
  assert.equal(r.keys.get(1), 'C');
  assert.equal(r.keys.get(27), 'B');
  assert.equal(r.keys.get(53), 'D');
  assert.equal(r.keys.get(79), 'E');
  assert.equal(r.keys.get(80), 'C');
  assert.equal(r.keys.size, 8);
});

test('grid layout repairs VR2 OCR numerals and the 0-for-D letter', () => {
  // Verbatim lines from the Verbal Review 2e RC key.
  const r = parseAnswerKey([
    'I. C 27. B 53. 0 79. E',
    'II. C 37. C 63. E 89. B',
    '2I. E 47. C 73. A 99. A',
    '25. B 5I. C 77. B 103. E',
    '24. 0 50. B 76. B lOI. B',
  ]);
  assert.equal(r.keys.get(1), 'C');
  assert.equal(r.keys.get(53), 'D', '0 in the letter position is D');
  assert.equal(r.keys.get(11), 'C');
  assert.equal(r.keys.get(21), 'E');
  assert.equal(r.keys.get(51), 'C');
  assert.equal(r.keys.get(24), 'D');
  assert.equal(r.keys.get(101), 'B');
});

test('an unreadable region yields no keys instead of garbage', () => {
  // OG13 section 8.5 is a rotated table; OCR renders it as line noise.
  const noise = [
    'CO CO O UJ GO O O U J O O O O C 0 < O O < O O C 0 O l U L U U J O O L l J C 0 O C 0',
    'r o \' s j - i n i O N o o c j ^ O r - i c v j r o ^ t i n A D N o o o i O H C M o o',
    'O C Q < < L J Q < O Q Q Q O Q Q C Q Q C D Q Q L l J L i J O O Q O < < Q O Q',
  ];
  const r = parseAnswerKey(noise);
  assert.equal(r.layout, 'unreadable');
  assert.equal(r.keys.size, 0);
});

test('letters outside A-E are rejected, not coerced', () => {
  const r = parseAnswerKey(['1. C', '2. Z', '3. B']);
  assert.equal(r.keys.size, 2);
  assert.ok(r.skipped.some(s => s.includes('2. Z')));
});

test('detectKeyLayout distinguishes the three cases', () => {
  assert.equal(detectKeyLayout(['1. C', '2. D']), 'single');
  assert.equal(detectKeyLayout(['1. C 27. B 53. D 79. E']), 'grid');
  assert.equal(detectKeyLayout(['C O < Q L U O Q < Q Q C O L U < < C O U J < l J L j Q']), 'unreadable');
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- --test-name-pattern='layout|answer key|keys'
```

Expected: FAIL — `Cannot find module '../../scripts/og/answer-key'`.

- [ ] **Step 3: Implement `scripts/og/answer-key.js`**

```js
// scripts/og/answer-key.js
// The books print their keys two ways. OG12/OG13 use one "N. X" per line.
// VR2 uses a four-column grid whose OCR reads 1 as I, 11 as II, 101 as lOI,
// and the letter D as a bare 0.
//
// OG13's CR key (section 8.5) is a rotated table that OCR destroyed; that
// region returns layout 'unreadable' and an empty map, and the caller falls
// back to the key derived from the answer explanations.

const { repairKeyNumeral } = require('./text');

// "<number>. <letter>" with both halves possibly OCR-damaged.
const ENTRY = /(?:^|\s)([0-9IlO]{1,4})\.\s*([A-E0])(?=\s|$)/g;

function entriesIn(line) {
  const out = [];
  ENTRY.lastIndex = 0;
  let m;
  while ((m = ENTRY.exec(line)) !== null) {
    const num = Number(repairKeyNumeral(m[1]));
    // A bare 0 in the letter position is D — VR2's OCR reads them identically.
    const letter = m[2] === '0' ? 'D' : m[2];
    if (Number.isInteger(num) && num > 0 && /^[A-E]$/.test(letter)) {
      out.push({ number: num, letter });
    }
  }
  return out;
}

function detectKeyLayout(lines) {
  const counts = lines.map(l => entriesIn(l).length);
  const withEntries = counts.filter(c => c > 0).length;
  if (withEntries === 0) return 'unreadable';
  // A region where most lines carry nothing parseable is noise, not a layout.
  if (withEntries / lines.length < 0.5) return 'unreadable';
  const multi = counts.filter(c => c > 1).length;
  return multi / withEntries > 0.5 ? 'grid' : 'single';
}

function parseAnswerKey(lines) {
  const layout = detectKeyLayout(lines);
  const keys = new Map();
  const skipped = [];
  if (layout === 'unreadable') return { layout, keys, skipped: lines.slice() };

  for (const line of lines) {
    const found = entriesIn(line);
    if (found.length === 0) { skipped.push(line); continue; }
    for (const { number, letter } of found) keys.set(number, letter);
  }
  return { layout, keys, skipped };
}

module.exports = { parseAnswerKey, detectKeyLayout };
```

- [ ] **Step 4: Run the tests and make them pass**

```bash
npm test -- --test-name-pattern='layout|answer key|keys'
```

Expected: 6 passing. The "letters outside A-E" case is the subtle one — `2. Z` must not match `ENTRY` at all, so the line yields nothing and lands in `skipped`.

- [ ] **Step 5: Run against the real key regions and check continuity**

```bash
node -e '
const fs=require("fs"),cp=require("child_process");
const {BOOKS}=require("./scripts/og/books"),{findRegions}=require("./scripts/og/regions");
const {parseAnswerKey}=require("./scripts/og/answer-key");
for (const b of BOOKS) {
  const src = b.ocrPdf && fs.existsSync(b.ocrPdf) ? b.ocrPdf : b.pdf;
  const lines = cp.execFileSync("pdftotext",["-raw",src,"-"],{maxBuffer:1<<28}).toString().split("\n");
  for (const kind of ["RC","CR"]) {
    const r = parseAnswerKey(findRegions(lines,b,kind).key);
    const nums=[...r.keys.keys()].sort((a,c)=>a-c);
    const max=nums[nums.length-1]||0;
    const gaps=[]; for(let i=1;i<=max;i++) if(!r.keys.has(i)) gaps.push(i);
    console.log(b.code,kind,r.layout,"n="+r.keys.size,"max="+max,"gaps="+(gaps.length?gaps.slice(0,10).join(","):"none"));
  }
}'
```

Expected: `n` equals `max` with no gaps for every book and subject **except** OG13 CR, which reports `unreadable n=0` unless Task 2 outcome (a) held. A key set with gaps anywhere else means the layout detector picked wrong — investigate before continuing, because a shifted key silently mis-answers every question after the gap.

- [ ] **Step 6: Commit**

```bash
git add scripts/og/answer-key.js test/unit/og-answer-key.test.js
git commit -m "feat(og): parse both answer-key layouts with VR2 OCR repair

Single-column (OG12/OG13) and four-column grid (VR2), repairing I/l/O numerals
and the 0-for-D letter. OG13's rotated CR key reports 'unreadable' rather than
emitting garbage, so the caller can fall back to the explanation-derived key."
```

---

### Task 6: Practice-section question parser

Turn a practice region into `{number, stem, choices}` records. This inherits the hardening the LSAT parser needed — see `scripts/parse-lsat-pdf.js:126` `parseSectionContent` and `:499` `restoreSpacing` for the originals.

**Files:**
- Create: `scripts/og/questions.js`
- Create: `test/unit/og-questions.test.js`

**Interfaces:**
- Consumes: nothing beyond Node built-ins (the region arrives already normalized from Task 4)
- Produces: `module.exports = { parseQuestions, CHOICE_LABELS }`
  - `CHOICE_LABELS = ['A','B','C','D','E']`
  - `parseQuestions(lines) -> {questions: Array<{number, stem, choices: Array<{label,text}>}>, warnings: string[]}` — questions in printed order; `warnings` carries anything dropped, for the report

- [ ] **Step 1: Write the failing test**

Create `test/unit/og-questions.test.js`:

```js
// test/unit/og-questions.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { parseQuestions } = require('../../scripts/og/questions');

test('parses a question into stem and five choices', () => {
  const { questions } = parseQuestions([
    '36. The growing popularity of computer-based activities',
    'was widely expected to result in a decline in television',
    'viewing.',
    'Which of the following would it be most useful to',
    'determine in order to evaluate the argument?',
    '(A) Whether a large majority watched television',
    '(B) Whether the amount of time spent is declining',
    '(C) Whether the type of programme changes',
    '(D) Whether a large majority of owners reported',
    '(E) Whether the reports included time at work',
  ]);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].number, 36);
  assert.match(questions[0].stem, /^The growing popularity/);
  assert.match(questions[0].stem, /evaluate the argument\?$/);
  assert.equal(questions[0].choices.length, 5);
  assert.deepEqual(questions[0].choices[0], { label: 'A', text: 'Whether a large majority watched television' });
  assert.equal(questions[0].choices[4].text, 'Whether the reports included time at work');
});

test('a choice wrapping across lines is joined', () => {
  const { questions } = parseQuestions([
    '1. Stem line.',
    '(A) first part of a choice that wraps',
    'onto a second line',
    '(B) second choice',
    '(C) third', '(D) fourth', '(E) fifth',
  ]);
  assert.equal(questions[0].choices[0].text,
    'first part of a choice that wraps onto a second line');
});

test('a decimal is not read as a question number', () => {
  // "density 4.3 to 4.6." cost the LSAT parser a whole passage.
  const { questions } = parseQuestions([
    '5. A material with a density of',
    '4.3 to 4.6. It is also used widely.',
    '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
  ]);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].number, 5);
  assert.match(questions[0].stem, /4\.3 to 4\.6/);
});

test('question numbers must continue the run', () => {
  // A sentence starting "1. " mid-stem must not open a new question.
  const { questions } = parseQuestions([
    '7. Consider the following claim.',
    '1. It is not a question number here.',
    '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
    '8. The next real question.',
    '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
  ]);
  assert.deepEqual(questions.map(q => q.number), [7, 8]);
});

test('a question with the wrong number of choices is warned about, not silently kept', () => {
  const { questions, warnings } = parseQuestions([
    '1. Stem.', '(A) one', '(B) two', '(C) three',
  ]);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].choices.length, 3);
  assert.ok(warnings.some(w => /question 1/.test(w) && /3 choices/.test(w)));
});

test('a page footer run onto the end of a line is trimmed', () => {
  const { questions } = parseQuestions([
    '1. The stem ends here. 542',
    '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
  ]);
  assert.equal(questions[0].stem, 'The stem ends here.');
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- --test-name-pattern='question|choice|decimal|footer'
```

Expected: FAIL — `Cannot find module '../../scripts/og/questions'`.

- [ ] **Step 3: Implement `scripts/og/questions.js`**

```js
// scripts/og/questions.js
// Parse a practice region into questions. Three pdftotext artefacts cost the
// LSAT parser questions and are guarded against here too:
//   - a decimal read as a question number ("4.3 to 4.6.")
//   - a mid-stem sentence that happens to start "1. "
//   - a page footer run onto the end of the previous line

const CHOICE_LABELS = ['A', 'B', 'C', 'D', 'E'];

// A question opens a line, is not preceded by a digit (so 4.6 cannot match),
// and is followed by a space and real text.
const Q_START = /^(\d{1,3})\.\s+(?=\S)/;
const CHOICE_START = /^\(([A-E])\)\s*/;
// A bare 1-4 digit number at end of line is a page footer pdftotext ran on.
const TRAILING_FOOTER = /\s+\d{1,4}$/;

function joinLines(parts) {
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function finishStem(parts) {
  return joinLines(parts).replace(TRAILING_FOOTER, '').trim();
}

function parseQuestions(lines) {
  const questions = [];
  const warnings = [];

  let cur = null;                 // {number, stemParts, choices}
  let choiceParts = null;         // parts of the choice being accumulated
  let choiceLabel = null;

  const flushChoice = () => {
    if (choiceLabel === null) return;
    cur.choices.push({ label: choiceLabel, text: finishStem(choiceParts) });
    choiceLabel = null;
    choiceParts = null;
  };

  const flushQuestion = () => {
    if (!cur) return;
    flushChoice();
    const q = { number: cur.number, stem: finishStem(cur.stemParts), choices: cur.choices };
    if (q.choices.length !== 5) {
      warnings.push(`question ${q.number}: ${q.choices.length} choices (expected 5)`);
    }
    if (!q.stem) warnings.push(`question ${q.number}: empty stem`);
    questions.push(q);
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    const qm = line.match(Q_START);
    // Only open a new question if the number continues the printed run. A
    // sentence starting "1. " inside a stem does not.
    const expected = cur ? cur.number + 1 : null;
    const startsQuestion = qm && (cur === null || Number(qm[1]) === expected);

    if (startsQuestion) {
      flushQuestion();
      cur = { number: Number(qm[1]), stemParts: [line.slice(qm[0].length)], choices: [] };
      continue;
    }
    if (!cur) continue;           // preamble before the first question

    const cm = line.match(CHOICE_START);
    if (cm) {
      flushChoice();
      choiceLabel = cm[1];
      choiceParts = [line.slice(cm[0].length)];
      continue;
    }

    if (choiceLabel !== null) choiceParts.push(line);
    else cur.stemParts.push(line);
  }
  flushQuestion();

  return { questions, warnings };
}

module.exports = { parseQuestions, CHOICE_LABELS };
```

- [ ] **Step 4: Run the tests and make them pass**

```bash
npm test -- --test-name-pattern='question|choice|decimal|footer'
```

Expected: 6 passing.

- [ ] **Step 5: Run against the real practice regions**

```bash
node -e '
const fs=require("fs"),cp=require("child_process");
const {BOOKS}=require("./scripts/og/books"),{findRegions}=require("./scripts/og/regions");
const {parseQuestions}=require("./scripts/og/questions");
for (const b of BOOKS) {
  const src = b.ocrPdf && fs.existsSync(b.ocrPdf) ? b.ocrPdf : b.pdf;
  const lines = cp.execFileSync("pdftotext",["-raw",src,"-"],{maxBuffer:1<<28}).toString().split("\n");
  for (const kind of ["RC","CR"]) {
    const {questions,warnings}=parseQuestions(findRegions(lines,b,kind).practice);
    const five=questions.filter(q=>q.choices.length===5).length;
    console.log(b.code,kind,"n="+questions.length,
      "5-choice="+(questions.length?Math.round(100*five/questions.length):0)+"%",
      "warnings="+warnings.length, warnings.slice(0,3).join(" | "));
  }
}'
```

Expected: `n` matching the key counts from Task 5, and 5-choice at or above 98% for the OG editions. Verbal Review 2e will be lower; note the figure. RC questions legitimately have 5 choices too, so the same threshold applies.

- [ ] **Step 6: Commit**

```bash
git add scripts/og/questions.js test/unit/og-questions.test.js
git commit -m "feat(og): parse practice-section questions and choices

Carries over the LSAT parser's guards: decimals cannot open a question, a
question number must continue the printed run, and trailing page footers are
trimmed off stems and choices."
```

---

### Task 7: Explanation parser

The explanations region is the richest part of the books and the second, independent answer key. Per question it carries the question repeated, an official type label, a reasoning block, one rationale per choice with exactly one opening `Correct.`, and often a closing `The correct answer is X.`

It also carries the RC passage grouping. Lines like `Questions 1-3 refer to the passage on page 358.` are the only place the books state which questions share a passage and what page it is printed on — Task 10 needs both.

Observed shapes:

```
16. Which of the following best completes the passage below?
People buy prestige when they buy a premium product.
(A) affluent purchasers currently represent a shrinking portion
...
Argument Construction
Situation  Consumers seek prestige when they buy premium products...
Reasoning  The correct answer will be the option that best answers...
A  This information suggests that the percentage of the population...
B  Correct. This information, if true, provides a good reason...
C  Using mass-marketing techniques could sometimes suggest low quality...
D  This statement provides a reason why broader marketing should be employed...
E  Manufacturing costs are not discussed and so are irrelevant.
ThecorrectanswerisB.542
```

RC explanations omit `Situation`/`Reasoning` and run the reasoning as plain prose under the label, and often omit the closing line — `Correct.` is then the only key.

**Files:**
- Create: `scripts/og/explanations.js`
- Create: `test/unit/og-explanations.test.js`

**Interfaces:**
- Consumes: nothing beyond Node built-ins
- Produces: `module.exports = { parseExplanations, TYPE_LABELS, canonicalTypeLabel }`
  - `TYPE_LABELS` — array of canonical labels
  - `canonicalTypeLabel(raw) -> string | null` — folds singular/plural and OCR spacing, returns null for a non-label line
  - `parseExplanations(lines) -> {entries: Array<{number, typeLabel, situation, reasoning, choiceNotes: {A..E}, key, keySource}>, passageRefs: Array<{firstQuestion, lastQuestion, page}>, warnings: string[]}`
    - `key` is the `A`-`E` letter or null; `keySource` is `'correct-marker'`, `'closing-line'`, `'both'` or `null`
    - when both sources exist and disagree, `key` is null and a warning names the question

- [ ] **Step 1: Write the failing test**

Create `test/unit/og-explanations.test.js`:

```js
// test/unit/og-explanations.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseExplanations, canonicalTypeLabel,
} = require('../../scripts/og/explanations');

const CR = [
  '16. Which of the following best completes the passage below?',
  'People buy prestige when they buy a premium product.',
  '(A) affluent purchasers represent a shrinking portion',
  '(B) continued sales depend on an aura of exclusivity',
  '(C) purchasers are concerned with quality as well as price',
  '(D) expansion of the market niche will increase profits',
  '(E) manufacturing a premium brand is not more costly',
  'Argument Construction',
  'Situation Consumers seek prestige when they buy premium products.',
  'Reasoning The correct answer will be the option that best answers this.',
  'A This information suggests the percentage may be shrinking.',
  'B Correct. This information provides a good reason for the avoidance.',
  'C Using mass-marketing could sometimes suggest low quality.',
  'D This statement provides a reason why broader marketing should be used.',
  'E Manufacturing costs are not discussed and so are irrelevant.',
  'ThecorrectanswerisB.542',
];

test('parses a CR explanation entry end to end', () => {
  const { entries } = parseExplanations(CR);
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.number, 16);
  assert.equal(e.typeLabel, 'Argument Construction');
  assert.match(e.situation, /^Consumers seek prestige/);
  assert.match(e.reasoning, /^The correct answer will be/);
  assert.match(e.choiceNotes.B, /^Correct\./);
  assert.match(e.choiceNotes.E, /^Manufacturing costs/);
  assert.equal(e.key, 'B');
  assert.equal(e.keySource, 'both');
});

test('the closing line is read even with its spaces lost', () => {
  const { entries } = parseExplanations(CR);
  assert.equal(entries[0].key, 'B');
});

test('RC entries have no Situation/Reasoning and key off Correct. alone', () => {
  const { entries } = parseExplanations([
    '1. The primary purpose of the passage is to',
    '(A) explain why a strategy has been less successful',
    '(B) propose an alternative to a strategy',
    '(C) present a concern about the consequences',
    '(D) make a case for applying a strategy',
    '(E) suggest several possible outcomes',
    'Main idea',
    'This question requires understanding the passage as a whole.',
    'A The passage never discusses whether it is successful.',
    'B Lines 26-28 state that a new approach must be found.',
    'C Correct. After defining the term, the rest describes the concerns.',
    'D No case is made.',
    'E No outcomes are suggested.',
  ]);
  assert.equal(entries[0].typeLabel, 'Main idea');
  assert.equal(entries[0].situation, null);
  assert.match(entries[0].reasoning, /^This question requires/);
  assert.equal(entries[0].key, 'C');
  assert.equal(entries[0].keySource, 'correct-marker');
});

test('disagreeing key sources yield no key and a warning', () => {
  const lines = CR.slice(0, -1).concat(['The correct answer is D.']);
  const { entries, warnings } = parseExplanations(lines);
  assert.equal(entries[0].key, null);
  assert.ok(warnings.some(w => /16/.test(w) && /disagree/i.test(w)));
});

test('passage references are captured with their page', () => {
  const { passageRefs } = parseExplanations([
    'Questions 1-3 refer to the passage on page 358.',
    '1. The primary purpose of the passage is to',
    '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
    'Main idea',
    'Prose.',
    'A no', 'B no', 'C Correct. yes', 'D no', 'E no',
    'Questions 4-8 refer to the passage on page 360.',
    '4. Another question',
    '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
    'Inference',
    'Prose.',
    'A Correct. yes', 'B no', 'C no', 'D no', 'E no',
  ]);
  assert.deepEqual(passageRefs, [
    { firstQuestion: 1, lastQuestion: 3, page: 358 },
    { firstQuestion: 4, lastQuestion: 8, page: 360 },
  ]);
});

test('canonicalTypeLabel folds plurals and OCR spacing', () => {
  assert.equal(canonicalTypeLabel('Supporting idea'), 'Supporting ideas');
  assert.equal(canonicalTypeLabel('Supporting ideas'), 'Supporting ideas');
  assert.equal(canonicalTypeLabel('Argument Evaluat ion'), 'Argument Evaluation');
  assert.equal(canonicalTypeLabel('Main idea'), 'Main idea');
  assert.equal(canonicalTypeLabel('A This information suggests'), null);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- --test-name-pattern='explanation|typeLabel|passage references|key sources'
```

Expected: FAIL — `Cannot find module '../../scripts/og/explanations'`.

- [ ] **Step 3: Implement `scripts/og/explanations.js`**

```js
// scripts/og/explanations.js
// The answer-explanations region carries, per question: the question repeated,
// an official type label, a reasoning block, one rationale per choice with
// exactly one opening "Correct.", and usually a closing "The correct answer
// is X." Those last two are two independent readings of the same key and must
// agree. RC entries omit Situation/Reasoning and often the closing line.
//
// The region also carries the RC passage grouping, which appears nowhere else:
//   "Questions 1-3 refer to the passage on page 358."

const { squash } = require('./text');

const TYPE_LABELS = [
  'Argument Construction',
  'Argument Evaluation',
  'Evaluation of a Plan',
  'Evaluation',
  'Inference',
  'Main idea',
  'Supporting ideas',
  'Logical structure',
  'Application',
  'Style and tone',
];

// Singular variants the books use interchangeably with their plural.
const LABEL_ALIASES = new Map([
  ['supportingidea', 'Supporting ideas'],
  ['inferences', 'Inference'],
  ['mainideas', 'Main idea'],
]);

const LABEL_BY_KEY = new Map(TYPE_LABELS.map(l => [squash(l), l]));

function canonicalTypeLabel(raw) {
  const line = String(raw).trim();
  // A label is a short line on its own — never a rationale or a sentence.
  if (line.length > 40) return null;
  const k = squash(line);
  return LABEL_BY_KEY.get(k) || LABEL_ALIASES.get(k) || null;
}

const Q_START = /^(\d{1,3})\.\s+(?=\S)/;
const CHOICE_START = /^\(([A-E])\)\s*/;
const NOTE_START = /^([A-E])\s+(?=\S)/;
const SITUATION = /^Situation\s+/;
const REASONING = /^Reasoning\s+/;
// "The correct answer is B." — OG12 sometimes loses every space in this line,
// and a page footer may be glued to the end.
const CLOSING = /^the\s*correct\s*answer\s*is\s*([A-E])\b/i;
const CLOSING_SQUASHED = /^thecorrectansweris([A-E])/i;
const PASSAGE_REF = /^Questions\s+(\d{1,3})\s*[-–—]\s*(\d{1,3})\s+refer to the passage on page\s+(\d{1,4})/i;

function joinParts(parts) {
  const s = parts.join(' ').replace(/\s+/g, ' ').trim();
  return s || null;
}

function parseExplanations(lines) {
  const entries = [];
  const passageRefs = [];
  const warnings = [];

  let cur = null;
  let bucket = null;   // 'stem' | 'situation' | 'reasoning' | 'note'
  let noteLetter = null;
  let parts = [];

  const flushBucket = () => {
    if (!cur || !bucket) return;
    const text = joinParts(parts);
    if (bucket === 'situation') cur.situation = text;
    else if (bucket === 'reasoning') cur.reasoning = joinParts([cur.reasoning || '', text || '']);
    else if (bucket === 'note') cur.choiceNotes[noteLetter] = text;
    parts = [];
  };

  const flushEntry = () => {
    if (!cur) return;
    flushBucket();

    const marked = Object.keys(cur.choiceNotes)
      .filter(L => /^Correct\./i.test(cur.choiceNotes[L] || ''));
    const markerKey = marked.length === 1 ? marked[0] : null;
    if (marked.length > 1) {
      warnings.push(`question ${cur.number}: ${marked.length} choices marked Correct.`);
    }

    const closingKey = cur.closingKey || null;
    let key = null, keySource = null;
    if (markerKey && closingKey) {
      if (markerKey === closingKey) { key = markerKey; keySource = 'both'; }
      else warnings.push(`question ${cur.number}: key sources disagree (Correct. says ${markerKey}, closing line says ${closingKey})`);
    } else if (markerKey) { key = markerKey; keySource = 'correct-marker'; }
    else if (closingKey) { key = closingKey; keySource = 'closing-line'; }
    else warnings.push(`question ${cur.number}: no key found in explanation`);

    if (!cur.typeLabel) warnings.push(`question ${cur.number}: no type label`);

    entries.push({
      number: cur.number,
      typeLabel: cur.typeLabel,
      situation: cur.situation,
      reasoning: cur.reasoning,
      choiceNotes: cur.choiceNotes,
      key,
      keySource,
    });
    cur = null;
    bucket = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const pref = line.match(PASSAGE_REF);
    if (pref) {
      passageRefs.push({
        firstQuestion: Number(pref[1]),
        lastQuestion: Number(pref[2]),
        page: Number(pref[3]),
      });
      continue;
    }

    const qm = line.match(Q_START);
    const expected = cur ? cur.number + 1 : null;
    // Inside a rationale a sentence can start "1. "; only a number continuing
    // the run opens the next entry.
    if (qm && (cur === null || Number(qm[1]) === expected)) {
      flushEntry();
      cur = {
        number: Number(qm[1]), typeLabel: null, situation: null,
        reasoning: null, choiceNotes: {}, closingKey: null,
      };
      bucket = 'stem'; parts = [];
      continue;
    }
    if (!cur) continue;

    const cm = line.match(CLOSING) || line.match(CLOSING_SQUASHED);
    if (cm) { flushBucket(); bucket = null; cur.closingKey = cm[1].toUpperCase(); continue; }

    const label = canonicalTypeLabel(line);
    if (label && !cur.typeLabel) {
      flushBucket();
      cur.typeLabel = label;
      // RC runs its reasoning as plain prose straight after the label.
      bucket = 'reasoning'; parts = [];
      continue;
    }

    if (SITUATION.test(line)) {
      flushBucket(); bucket = 'situation';
      parts = [line.replace(SITUATION, '')]; continue;
    }
    if (REASONING.test(line)) {
      flushBucket(); bucket = 'reasoning'; cur.reasoning = null;
      parts = [line.replace(REASONING, '')]; continue;
    }

    // Rationales only start once the type label has been seen; before that an
    // "(A) ..." line is the question's own choice being repeated.
    const nm = cur.typeLabel ? line.match(NOTE_START) : null;
    if (nm) {
      flushBucket(); bucket = 'note'; noteLetter = nm[1];
      parts = [line.slice(nm[0].length)]; continue;
    }

    if (CHOICE_START.test(line) && !cur.typeLabel) { parts.push(line); continue; }
    parts.push(line);
  }
  flushEntry();

  return { entries, passageRefs, warnings };
}

module.exports = { parseExplanations, TYPE_LABELS, canonicalTypeLabel };
```

- [ ] **Step 4: Run the tests and make them pass**

```bash
npm test -- --test-name-pattern='explanation|typeLabel|passage references|key sources'
```

Expected: 6 passing.

- [ ] **Step 5: Run against the real explanation regions**

```bash
node -e '
const fs=require("fs"),cp=require("child_process");
const {BOOKS}=require("./scripts/og/books"),{findRegions}=require("./scripts/og/regions");
const {parseExplanations}=require("./scripts/og/explanations");
for (const b of BOOKS) {
  const src = b.ocrPdf && fs.existsSync(b.ocrPdf) ? b.ocrPdf : b.pdf;
  const lines = cp.execFileSync("pdftotext",["-raw",src,"-"],{maxBuffer:1<<28}).toString().split("\n");
  for (const kind of ["RC","CR"]) {
    const r = parseExplanations(findRegions(lines,b,kind).explanations);
    const keyed=r.entries.filter(e=>e.key).length, labelled=r.entries.filter(e=>e.typeLabel).length;
    console.log(b.code,kind,"entries="+r.entries.length,"keyed="+keyed,"labelled="+labelled,
      "passageRefs="+r.passageRefs.length,"warnings="+r.warnings.length);
  }
}'
```

Expected: entry counts matching Task 6's question counts; `keyed` and `labelled` close to the entry count; `passageRefs` non-zero for RC and zero for CR. **OG13 CR must come out well keyed here** — this is its only key source. Record the counts.

- [ ] **Step 6: Commit**

```bash
git add scripts/og/explanations.js test/unit/og-explanations.test.js
git commit -m "feat(og): parse answer explanations, type labels and the second key

Derives the key twice per question (the Correct. marker and the closing line)
and refuses to pick when they disagree. Also captures the RC passage grouping,
which the books state nowhere else."
```

---

### Task 8: Assemble one book-subject, cross-check the keys

Join the three parses into question objects, reconcile the printed key against the explanation-derived key, and fall back where one source is missing. This is the only module that knows about all three parsers.

**Files:**
- Create: `scripts/og/assemble.js`
- Create: `test/unit/og-assemble.test.js`

**Interfaces:**
- Consumes: `scripts/og/questions.js`, `scripts/og/explanations.js`, `scripts/og/answer-key.js`
- Produces: `module.exports = { assembleSection }`
  - `assembleSection({book, kind, practice, key, explanations}) -> {section, stats, warnings}` where the four inputs are the line arrays from `findRegions` plus the book object
  - `section` is `{kind, passageRefs, questions: [...]}`; each question is `{id, number, stem, choices, correct, typeLabel, explanation: {situation, reasoning, choices}, keyDisputed, keySource, stemSource, refs}`
  - `stats` is `{total, keyed, disputed, fiveChoice, stemFallback, labelled}`

- [ ] **Step 1: Write the failing test**

Create `test/unit/og-assemble.test.js`:

```js
// test/unit/og-assemble.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { assembleSection } = require('../../scripts/og/assemble');
const { bookByCode } = require('../../scripts/og/books');

const OG13 = bookByCode('OG13');

const practice = [
  '1. A stem about flutes.',
  '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
];
const explanations = [
  '1. A stem about flutes.',
  '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
  'Argument Construction',
  'Situation Some situation.',
  'Reasoning Some reasoning.',
  'A no', 'B Correct. yes', 'C no', 'D no', 'E no',
  'The correct answer is B.',
];

test('assembles a question with both key sources agreeing', () => {
  const { section, stats } = assembleSection({
    book: OG13, kind: 'CR', practice, key: ['1. B'], explanations,
  });
  const q = section.questions[0];
  assert.equal(q.id, 'OG13-CR-1');
  assert.equal(q.correct, 'B');
  assert.equal(q.keyDisputed, false);
  assert.equal(q.keySource, 'printed+explanation');
  assert.equal(q.typeLabel, 'Argument Construction');
  assert.equal(q.explanation.situation, 'Some situation.');
  assert.equal(q.explanation.choices.B, 'Correct. yes');
  assert.equal(q.stemSource, 'practice');
  assert.deepEqual(q.refs, [{ book: 'OG13', number: 1 }]);
  assert.equal(stats.keyed, 1);
  assert.equal(stats.disputed, 0);
});

test('an unreadable printed key falls back to the explanation key', () => {
  // This is OG13 CR: section 8.5 is a rotated table OCR destroyed.
  const { section, stats } = assembleSection({
    book: OG13, kind: 'CR', practice,
    key: ['C O < Q L U O Q < Q Q C O L U < < C O U J < l J L j Q L i J C Q O'],
    explanations,
  });
  assert.equal(section.questions[0].correct, 'B');
  assert.equal(section.questions[0].keySource, 'explanation');
  assert.equal(section.questions[0].keyDisputed, false);
  assert.equal(stats.keyed, 1);
});

test('disagreeing keys leave the question unkeyed and disputed', () => {
  const { section, stats, warnings } = assembleSection({
    book: OG13, kind: 'CR', practice, key: ['1. D'], explanations,
  });
  assert.equal(section.questions[0].correct, null);
  assert.equal(section.questions[0].keyDisputed, true);
  assert.equal(stats.disputed, 1);
  assert.equal(stats.keyed, 0);
  assert.ok(warnings.some(w => /OG13-CR-1/.test(w)));
});

test('a question missing from the practice section is taken from the explanation copy', () => {
  const { section, stats } = assembleSection({
    book: OG13, kind: 'CR', practice: [], key: ['1. B'], explanations,
  });
  assert.equal(section.questions.length, 1);
  assert.equal(section.questions[0].stem, 'A stem about flutes.');
  assert.equal(section.questions[0].stemSource, 'explanation');
  assert.equal(stats.stemFallback, 1);
});

test('passageRefs ride along on the section', () => {
  const { section } = assembleSection({
    book: OG13, kind: 'RC', practice, key: ['1. B'],
    explanations: ['Questions 1-3 refer to the passage on page 358.'].concat(explanations),
  });
  assert.deepEqual(section.passageRefs, [{ firstQuestion: 1, lastQuestion: 3, page: 358 }]);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- --test-name-pattern='assemble|key source|unkeyed|fallback|passageRefs ride'
```

Expected: FAIL — `Cannot find module '../../scripts/og/assemble'`.

- [ ] **Step 3: Implement `scripts/og/assemble.js`**

```js
// scripts/og/assemble.js
// Join the three parses for one book-subject and reconcile the two keys.
//
// The printed key and the explanation-derived key are independent readings.
// Where both exist they must agree; where they disagree the question is left
// unkeyed and flagged, never resolved by preferring one. Where only one
// exists it stands alone — which is how OG13's CR section survives its
// destroyed printed key.

const { parseQuestions } = require('./questions');
const { parseExplanations } = require('./explanations');
const { parseAnswerKey } = require('./answer-key');

function assembleSection({ book, kind, practice, key, explanations }) {
  const warnings = [];

  const pq = parseQuestions(practice);
  warnings.push(...pq.warnings.map(w => `${book.code}-${kind} practice: ${w}`));

  const pe = parseExplanations(explanations);
  warnings.push(...pe.warnings.map(w => `${book.code}-${kind} explanations: ${w}`));

  const pk = parseAnswerKey(key);
  if (pk.layout === 'unreadable') {
    warnings.push(`${book.code}-${kind}: printed answer key unreadable; relying on explanations`);
  }

  const byNumber = new Map();
  for (const q of pq.questions) byNumber.set(q.number, q);
  const explByNumber = new Map();
  for (const e of pe.entries) explByNumber.set(e.number, e);

  // Union of both sources, in printed order, so a question missing from one
  // side is still emitted.
  const numbers = [...new Set([...byNumber.keys(), ...explByNumber.keys()])]
    .sort((a, b) => a - b);

  const questions = [];
  const stats = { total: 0, keyed: 0, disputed: 0, fiveChoice: 0, stemFallback: 0, labelled: 0 };

  for (const number of numbers) {
    const q = byNumber.get(number);
    const e = explByNumber.get(number);
    const id = `${book.code}-${kind}-${number}`;

    let stem, choices, stemSource;
    if (q && q.stem) { stem = q.stem; choices = q.choices; stemSource = 'practice'; }
    else if (e) {
      // The explanation repeats the question; re-parse that copy to get its
      // stem and choices in the same shape.
      const reparsed = parseQuestions(explanations).questions.find(x => x.number === number);
      if (!reparsed) { warnings.push(`${id}: no stem in either section`); continue; }
      stem = reparsed.stem; choices = reparsed.choices; stemSource = 'explanation';
      stats.stemFallback++;
    } else { warnings.push(`${id}: no stem in either section`); continue; }

    const printedKey = pk.keys.get(number) || null;
    const explKey = e ? e.key : null;

    let correct = null, keyDisputed = false, keySource = null;
    if (printedKey && explKey) {
      if (printedKey === explKey) { correct = printedKey; keySource = 'printed+explanation'; }
      else {
        keyDisputed = true;
        warnings.push(`${id}: printed key ${printedKey} disagrees with explanation key ${explKey}`);
      }
    } else if (printedKey) { correct = printedKey; keySource = 'printed'; }
    else if (explKey) { correct = explKey; keySource = 'explanation'; }
    else warnings.push(`${id}: no key from either source`);

    stats.total++;
    if (correct) stats.keyed++;
    if (keyDisputed) stats.disputed++;
    if (choices.length === 5) stats.fiveChoice++;
    if (e && e.typeLabel) stats.labelled++;

    questions.push({
      id, number, stem, choices, correct,
      typeLabel: e ? e.typeLabel : null,
      explanation: e
        ? { situation: e.situation, reasoning: e.reasoning, choices: e.choiceNotes }
        : null,
      keyDisputed, keySource, stemSource,
      refs: [{ book: book.code, number }],
    });
  }

  return {
    section: { kind, passageRefs: pe.passageRefs, questions },
    stats,
    warnings,
  };
}

module.exports = { assembleSection };
```

- [ ] **Step 4: Run the tests and make them pass**

```bash
npm test -- --test-name-pattern='assemble|key source|unkeyed|fallback|passageRefs ride'
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
npm run lint 2>&1 | tail -3
git add scripts/og/assemble.js test/unit/og-assemble.test.js
git commit -m "feat(og): assemble a book-subject and reconcile its two answer keys

Agreeing keys pass; a disagreement leaves the question unkeyed and flagged;
a single surviving source stands alone, which is how OG13 CR works around its
destroyed printed key."
```

---

### Task 9: The CLI, the parse report, and the acceptance gate

Drive every book and subject, write the pool, and emit a report that says whether the extraction is good enough to keep. The report is the gate — nothing downstream runs until it clears.

**Files:**
- Create: `scripts/parse-og-pdf.js`
- Modify: `package.json` (add the `og:parse` script)
- Create (generated, gitignored): `data/gmat-og-questions.json`, `tmp/og-parse-report.md`

**Interfaces:**
- Consumes: `scripts/og/books.js`, `scripts/og/regions.js`, `scripts/og/assemble.js`
- Produces: the JSON pool described in the spec, plus a Markdown report. No module exports — this is a CLI.

- [ ] **Step 1: Implement the CLI**

Create `scripts/parse-og-pdf.js`:

```js
#!/usr/bin/env node
/* eslint-disable no-console */
// Parse the GMAT Official Guide PDFs into data/gmat-og-questions.json.
//
// Usage:
//   node scripts/parse-og-pdf.js                 # all books, both subjects
//   node scripts/parse-og-pdf.js --book OG12     # one book
//   node scripts/parse-og-pdf.js --kind CR       # one subject
//   node scripts/parse-og-pdf.js --dry-run       # report only, write nothing

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { BOOKS } = require('./og/books');
const { findRegions } = require('./og/regions');
const { assembleSection } = require('./og/assemble');

const OUT = path.join(__dirname, '..', 'data', 'gmat-og-questions.json');
const REPORT = path.join(__dirname, '..', 'tmp', 'og-parse-report.md');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const onlyBook = arg('--book');
const onlyKind = arg('--kind');
const dryRun = process.argv.includes('--dry-run');

function readBookText(book) {
  // Prefer the re-OCR'd copy when it exists; OG12 never has one.
  const src = book.ocrPdf && fs.existsSync(book.ocrPdf) ? book.ocrPdf : book.pdf;
  if (!fs.existsSync(src)) throw new Error(`Missing PDF: ${src}`);
  const txt = cp.execFileSync('pdftotext', ['-raw', src, '-'], { maxBuffer: 1 << 28 }).toString();
  return { src, lines: txt.split('\n') };
}

const books = [];
const rows = [];
const allWarnings = [];

for (const book of BOOKS) {
  if (onlyBook && book.code !== onlyBook) continue;
  const { src, lines } = readBookText(book);
  const sections = [];

  for (const kind of ['RC', 'CR']) {
    if (onlyKind && kind !== onlyKind) continue;
    let regions;
    try {
      regions = findRegions(lines, book, kind);
    } catch (err) {
      allWarnings.push(`${book.code}-${kind}: ${err.message}`);
      rows.push({ book: book.code, kind, error: err.message });
      continue;
    }
    const { section, stats, warnings } = assembleSection({ book, kind, ...regions });
    sections.push(section);
    rows.push({ book: book.code, kind, ...stats });
    allWarnings.push(...warnings);
  }

  books.push({ code: book.code, title: book.title, source: path.basename(src), sections });
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

const lines = ['# OG parse report', '', `Generated ${new Date().toISOString()}`, ''];
lines.push('| Book | Kind | Questions | Keyed | Disputed | 5-choice | Labelled | Stem fallback |');
lines.push('|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  if (r.error) { lines.push(`| ${r.book} | ${r.kind} | — | — | — | — | — | ${r.error} |`); continue; }
  lines.push(`| ${r.book} | ${r.kind} | ${r.total} | ${pct(r.keyed, r.total)}% | ${r.disputed} | ${pct(r.fiveChoice, r.total)}% | ${pct(r.labelled, r.total)}% | ${r.stemFallback} |`);
}
lines.push('', `## Warnings (${allWarnings.length})`, '');
for (const w of allWarnings) lines.push(`- ${w}`);

fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, lines.join('\n'));

if (!dryRun) {
  fs.writeFileSync(OUT, JSON.stringify({ books }, null, 1));
  console.log(`wrote ${OUT}`);
}
console.log(`wrote ${REPORT}`);
for (const r of rows) {
  if (r.error) { console.log(`${r.book} ${r.kind}  ERROR ${r.error}`); continue; }
  console.log(`${r.book} ${r.kind}  n=${r.total} keyed=${pct(r.keyed, r.total)}% disputed=${r.disputed} 5ch=${pct(r.fiveChoice, r.total)}% labelled=${pct(r.labelled, r.total)}%`);
}
```

- [ ] **Step 2: Add the npm script**

In `package.json`, in `"scripts"`, directly after the `"reenrich"` entry, add:

```json
    "og:parse": "node scripts/parse-og-pdf.js",
```

- [ ] **Step 3: Run it dry on the cleanest book first**

```bash
node scripts/parse-og-pdf.js --book OG12 --kind CR --dry-run
```

OG12 CR is the control: native text, readable printed key, complete explanations. Expected: `keyed=100%`, `disputed=0`, `5ch` at or above 98%. **If the control does not come out clean, the parsers are wrong — fix them before touching the scanned books,** because every OCR-repair path added on top of a broken base is unattributable.

- [ ] **Step 4: Run the full parse**

```bash
node scripts/parse-og-pdf.js --dry-run
cat tmp/og-parse-report.md | head -20
```

Expected: six rows. Judge each against the spec's acceptance criteria:

- every question keyed (`keyed` = 100%)
- `disputed` = 0
- `5-choice` at or above 98%
- `labelled` high — a few missing type labels are tolerable, a column of them means the label list is incomplete

- [ ] **Step 5: Work the warnings until the report clears**

Read `tmp/og-parse-report.md` warnings in order. Each names a book, subject and question number. The likely families and where they belong:

- *"N choices (expected 5)"* — a choice label the repair missed. Add the case to `repairChoiceLabels` in `scripts/og/text.js` **with a test in `test/unit/og-text.test.js`**, not a special case in the question parser.
- *"no type label"* — a label variant not in `TYPE_LABELS` or `LABEL_ALIASES` in `scripts/og/explanations.js`. Add it with a test.
- *"key sources disagree"* — read the actual page. One side misparsed; fix the parser that got it wrong. Never pick a winner in `assemble.js`.
- *"printed answer key unreadable"* — expected for OG13 CR under Task 2 outcome (b). Not a defect.

Re-run Step 4 after each fix. Repeat until the table clears.

- [ ] **Step 6: Write the pool for real**

```bash
node scripts/parse-og-pdf.js
node -e '
const d=require("./data/gmat-og-questions.json");
for (const b of d.books) for (const s of b.sections)
  console.log(b.code, s.kind, s.questions.length, "passageRefs="+s.passageRefs.length);
'
```

Expected: the same six counts, and non-zero `passageRefs` on the RC sections.

- [ ] **Step 7: Commit**

```bash
npm test && npm run lint 2>&1 | tail -3
git add scripts/parse-og-pdf.js package.json
git commit -m "feat(og): add the parse CLI, pool output and acceptance report

npm run og:parse drives every book and subject and writes a report whose
thresholds gate the rest of the pipeline."
```

---

### Task 10: RC passages and CR boldface via pdfplumber

Two things plain text cannot give: RC passages with real paragraphs and gutter line numbers, and the boldface spans in CR stems that ask "the portion in **boldface** plays which role" — around 25-30 questions per OG edition that are unanswerable without the emphasis.

`scripts/extract-lsat-passages.py` already solves the hard parts — `detect_split` finds the column gutter by sparsest vertical band, `reading_order` rebuilds lines and attaches `(5)(10)` gutter markers, and the body-font histogram identifies emphasis. Reuse them; what differs is how a passage's pages are located.

The OG books make that easier than the LSAT did: Task 7 captured `Questions 1-3 refer to the passage on page 358.` for every RC group, so the **printed** page is known. Only the printed-to-PDF page offset has to be discovered, and it is one integer per book.

**Files:**
- Create: `scripts/extract-og-passages.py`
- Create: `test/unit/og-passages.test.js`
- Modify: `package.json` (add `og:passages`)
- Modify (generated): `data/gmat-og-questions.json`

**Interfaces:**
- Consumes: `data/gmat-og-questions.json` (written by Task 9), the source PDFs
- Produces: the same file with `passages[]` added to every RC section, `passageId` on every RC question, and `stemHtml` on CR questions carrying bold spans. Questions, choices and keys are **byte-identical** before and after — the script must not touch them.
- The JS test covers the merge contract, not the Python: `module.exports` from `scripts/og/passage-link.js` — `{ linkQuestionsToPassages }`, `linkQuestionsToPassages(section) -> section` assigning `passageId` from `passageRefs` ranges.

- [ ] **Step 1: Write the failing test for the link step**

Create `test/unit/og-passages.test.js`:

```js
// test/unit/og-passages.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { linkQuestionsToPassages } = require('../../scripts/og/passage-link');

const section = () => ({
  kind: 'RC',
  passageRefs: [
    { firstQuestion: 1, lastQuestion: 3, page: 358 },
    { firstQuestion: 4, lastQuestion: 8, page: 360 },
  ],
  questions: [1, 2, 3, 4, 8, 9].map(n => ({ id: `OG13-RC-${n}`, number: n })),
});

test('every question in a printed range gets that passage id', () => {
  const s = linkQuestionsToPassages(section());
  assert.equal(s.questions.find(q => q.number === 1).passageId, 'OG13-RC-p358');
  assert.equal(s.questions.find(q => q.number === 3).passageId, 'OG13-RC-p358');
  assert.equal(s.questions.find(q => q.number === 4).passageId, 'OG13-RC-p360');
  assert.equal(s.questions.find(q => q.number === 8).passageId, 'OG13-RC-p360');
});

test('a question outside every range is left unlinked and reported', () => {
  const s = linkQuestionsToPassages(section());
  assert.equal(s.questions.find(q => q.number === 9).passageId, null);
  assert.ok(s.unlinked.includes('OG13-RC-9'));
});

test('overlapping ranges are refused rather than silently resolved', () => {
  const bad = section();
  bad.passageRefs.push({ firstQuestion: 3, lastQuestion: 5, page: 362 });
  assert.throws(() => linkQuestionsToPassages(bad), /overlap/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- --test-name-pattern='passage id|unlinked|overlap'
```

Expected: FAIL — `Cannot find module '../../scripts/og/passage-link'`.

- [ ] **Step 3: Implement `scripts/og/passage-link.js`**

```js
// scripts/og/passage-link.js
// Assign each RC question its passage, using the ranges the answer
// explanations printed ("Questions 1-3 refer to the passage on page 358.").

function linkQuestionsToPassages(section) {
  const refs = [...section.passageRefs].sort((a, b) => a.firstQuestion - b.firstQuestion);
  for (let i = 1; i < refs.length; i++) {
    if (refs[i].firstQuestion <= refs[i - 1].lastQuestion) {
      throw new Error(
        `passage ranges overlap: ${refs[i - 1].firstQuestion}-${refs[i - 1].lastQuestion} ` +
        `and ${refs[i].firstQuestion}-${refs[i].lastQuestion}`);
    }
  }

  const unlinked = [];
  for (const q of section.questions) {
    const ref = refs.find(r => q.number >= r.firstQuestion && q.number <= r.lastQuestion);
    if (ref) {
      const prefix = q.id.replace(/-\d+$/, '');
      q.passageId = `${prefix}-p${ref.page}`;
    } else {
      q.passageId = null;
      unlinked.push(q.id);
    }
  }
  section.unlinked = unlinked;
  return section;
}

module.exports = { linkQuestionsToPassages };
```

- [ ] **Step 4: Run the tests and make them pass**

```bash
npm test -- --test-name-pattern='passage id|unlinked|overlap'
```

Expected: 3 passing.

- [ ] **Step 5: Write the Python extractor**

Create `scripts/extract-og-passages.py`, adapted from `scripts/extract-lsat-passages.py`. Reuse `detect_split`, `col_mode`, `reading_order`, `is_noise` and `squish` from that file verbatim — copy them in rather than importing, matching how the LSAT script is self-contained. What is new:

```python
def find_page_offset(pdf, probes, window=(-40, 40)):
    """Printed page numbers are not PDF page indices. Find the single integer
    offset where every probe's text lands on its printed page.

    probes: list of (printed_page, snippet) built from the parsed pool — the
    first few words of the first question in each RC passage group.
    """
    best, best_hits = None, 0
    for off in range(window[0], window[1] + 1):
        hits = 0
        for printed, snippet in probes:
            idx = printed + off - 1
            if not (0 <= idx < len(pdf.pages)):
                continue
            text = (pdf.pages[idx].extract_text() or "")
            if squish(snippet)[:40] in squish(text):
                hits += 1
        if hits > best_hits:
            best, best_hits = off, hits
    if best is None or best_hits < max(2, len(probes) // 2):
        raise SystemExit(
            f"could not determine printed->PDF page offset "
            f"(best {best} matched {best_hits}/{len(probes)} probes)")
    return best


def passage_pages(pdf, printed_page, offset):
    """A passage starts on its printed page and runs until the page where its
    first question's choices begin. Two pages is the usual span."""
    start = printed_page + offset
    return start, min(start + 1, len(pdf.pages))


BOLD = re.compile(r"bold|black|heavy|semib", re.I)


def bold_spans(pdf, printed_page, offset, stem):
    """Return the stem with <b> around runs set in a bold face, or None when
    no bold run was found. Used only for CR stems mentioning boldface."""
    idx = printed_page + offset - 1
    if not (0 <= idx < len(pdf.pages)):
        return None
    words = pdf.pages[idx].extract_words(x_tolerance=1.2, extra_attrs=["fontname"])
    if not words:
        return None

    # Walk the page's words in reading order and keep only the run that matches
    # this stem, so a bold word elsewhere on the page cannot leak in.
    target = squish(stem)
    joined, runs = "", []
    for w in words:
        t = w["text"]
        start = len(joined)
        joined += squish(t)
        runs.append((start, len(joined), t, bool(BOLD.search(w.get("fontname", "")))))

    at = joined.find(target[:60])
    if at < 0:
        return None
    end = at + len(target)

    out, open_b = [], False
    for start, stop, text, is_bold in runs:
        if stop <= at or start >= end:
            continue
        if is_bold and not open_b:
            out.append("<b>")
            open_b = True
        elif not is_bold and open_b:
            out.append("</b>")
            open_b = False
        out.append(text)
    if open_b:
        out.append("</b>")

    html = " ".join(out).replace(" </b>", "</b>").replace("<b> ", "<b>")
    return html if "<b>" in html else None


def build_passage(pdf, printed_page, offset, passage_id):
    """Paragraphs, gutter line numbers and highlights for one RC passage."""
    start, end = passage_pages(pdf, printed_page, offset)
    lines = reading_order(pdf, start, end)

    body = [ln for ln in lines
            if ln["text"].strip()
            and not is_noise(ln["text"])
            and not Q_STEM.match(ln["text"].strip())
            and not CHOICE.match(ln["text"].strip())]
    if not body:
        return None

    # A paragraph starts where a line is indented past its column's margin.
    paras, cur, numbered = [], [], []
    for ln in body:
        indented = ln["margin"] is not None and ln["x0"] > ln["margin"] + 4
        if indented and cur:
            paras.append(" ".join(cur))
            cur = []
        cur.append(ln["text"].strip())
        numbered.append({"n": len(numbered) + 1, "marker": ln["marker"],
                         "para": len(paras), "text": ln["text"].strip()})
    if cur:
        paras.append(" ".join(cur))

    return {"id": passage_id, "page": printed_page,
            "text": "\n\n".join(paras), "lines": numbered, "highlights": []}
```

`passage_pages`, `reading_order`, `detect_split`, `col_mode`, `is_noise` and `squish` come across from the LSAT script; `Q_STEM` and `CHOICE` are its existing line-classifier regexes. `build_passage` is called once per `passageRefs` entry from the pool, and its result is written into the RC section's `passages[]`.

The CLI mirrors the LSAT one: a dry-run report by default, `--merge` to write.

```bash
python3 scripts/extract-og-passages.py            # report only
python3 scripts/extract-og-passages.py --merge    # rewrite the pool
```

- [ ] **Step 6: Dry-run and read the report**

```bash
python3 scripts/extract-og-passages.py
```

Expected per book: the discovered page offset, the number of passages found versus the number of `passageRefs` in the pool, and the number of CR stems mentioning boldface versus the number where bold spans were actually recovered. A page offset that fails to resolve stops the script — that is the intended behaviour, since a wrong offset would extract the wrong pages silently.

- [ ] **Step 7: Merge and verify questions were untouched**

```bash
cp data/gmat-og-questions.json "data/gmat-og-questions.json.bak-prepassages-$(date +%Y%m%d%H%M%S)"
python3 scripts/extract-og-passages.py --merge
node -e '
const fs=require("fs");
const bak=fs.readdirSync("data").filter(n=>n.includes("bak-prepassages")).sort().pop();
const a=JSON.parse(fs.readFileSync("data/"+bak)), b=require("./data/gmat-og-questions.json");
const strip=d=>d.books.map(k=>k.sections.map(s=>s.questions.map(q=>
  ({id:q.id,stem:q.stem,choices:q.choices,correct:q.correct}))));
console.log(JSON.stringify(strip(a))===JSON.stringify(strip(b))
  ? "questions byte-identical" : "QUESTIONS CHANGED — investigate");
'
```

Expected: `questions byte-identical`. The passage pass must only add fields.

- [ ] **Step 8: Add the npm script and commit**

In `package.json` `"scripts"`, after `"og:parse"`:

```json
    "og:passages": "python3 scripts/extract-og-passages.py --merge",
```

```bash
npm test && npm run lint 2>&1 | tail -3
git add scripts/extract-og-passages.py scripts/og/passage-link.js \
        test/unit/og-passages.test.js package.json
git commit -m "feat(og): extract RC passages and CR boldface spans from page geometry

Reuses the LSAT extractor's column-gutter and reading-order machinery. Passage
pages come from the printed references the answer explanations carry, resolved
through a single per-book printed-to-PDF page offset."
```

---

### Task 11: Dedup across editions

OG12 and OG13 share a large part of their pool. CR dedups per question. RC dedups per **passage group** — removing three of a passage's six questions because they matched leaves a group that cannot be practiced.

**Files:**
- Create: `scripts/og/dedup.js`
- Create: `scripts/dedup-og-questions.js`
- Create: `test/unit/og-dedup.test.js`
- Modify: `package.json` (add `og:dedup`)

**Interfaces:**
- Consumes: the pool from Task 10
- Produces: `scripts/og/dedup.js` exports `{ fingerprint, dedupPool }`
  - `fingerprint(text) -> string` — lowercased, punctuation and whitespace collapsed, first 200 characters
  - `dedupPool(pool, {prefer}) -> {pool, report}` where `prefer` is an ordered array of book codes, most-preferred first; `report` is `{crDropped, rcGroupsDropped, collisions: [{kept, dropped}]}`

- [ ] **Step 1: Write the failing test**

Create `test/unit/og-dedup.test.js`:

```js
// test/unit/og-dedup.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { fingerprint, dedupPool } = require('../../scripts/og/dedup');

test('fingerprint ignores punctuation, case and spacing', () => {
  assert.equal(
    fingerprint('Kale has more nutritional value than spinach.'),
    fingerprint('kale  has more, nutritional value than spinach'));
});

test('fingerprint separates genuinely different stems', () => {
  assert.notEqual(fingerprint('Kale has more nutritional value than spinach.'),
                  fingerprint('Collard greens have more nutritional value.'));
});

const cr = (book, n, stem) => ({ id: `${book}-CR-${n}`, number: n, stem, choices: [], correct: 'A', refs: [{ book, number: n }] });
const rc = (book, n, stem, pid) => ({ id: `${book}-RC-${n}`, number: n, stem, choices: [], correct: 'A', passageId: pid, refs: [{ book, number: n }] });

const pool = () => ({ books: [
  { code: 'OG13', title: 'thirteenth', sections: [
    { kind: 'CR', passageRefs: [], questions: [cr('OG13', 1, 'Shared stem about kale.'), cr('OG13', 2, 'Unique to thirteen.')] },
    { kind: 'RC', passageRefs: [], passages: [{ id: 'OG13-RC-p358', text: 'A passage about ecoefficiency.' }],
      questions: [rc('OG13', 1, 'Primary purpose?', 'OG13-RC-p358'), rc('OG13', 2, 'Author implies?', 'OG13-RC-p358')] },
  ] },
  { code: 'OG12', title: 'twelfth', sections: [
    { kind: 'CR', passageRefs: [], questions: [cr('OG12', 9, 'Shared stem about kale.'), cr('OG12', 10, 'Unique to twelve.')] },
    { kind: 'RC', passageRefs: [], passages: [{ id: 'OG12-RC-p120', text: 'A passage about ecoefficiency.' }],
      questions: [rc('OG12', 5, 'Primary purpose?', 'OG12-RC-p120'), rc('OG12', 6, 'Something else?', 'OG12-RC-p120')] },
  ] },
] });

test('a duplicated CR question survives once, in the preferred edition', () => {
  const { pool: out, report } = dedupPool(pool(), { prefer: ['OG13', 'OG12'] });
  const og13cr = out.books.find(b => b.code === 'OG13').sections.find(s => s.kind === 'CR');
  const og12cr = out.books.find(b => b.code === 'OG12').sections.find(s => s.kind === 'CR');
  assert.deepEqual(og13cr.questions.map(q => q.id), ['OG13-CR-1', 'OG13-CR-2']);
  assert.deepEqual(og12cr.questions.map(q => q.id), ['OG12-CR-10']);
  assert.equal(report.crDropped, 1);
});

test('the survivor records where else it was printed', () => {
  const { pool: out } = dedupPool(pool(), { prefer: ['OG13', 'OG12'] });
  const kept = out.books[0].sections[0].questions.find(q => q.id === 'OG13-CR-1');
  assert.deepEqual(kept.refs, [{ book: 'OG13', number: 1 }, { book: 'OG12', number: 9 }]);
});

test('a shared RC passage drops its whole group, never part of it', () => {
  const { pool: out, report } = dedupPool(pool(), { prefer: ['OG13', 'OG12'] });
  const og12rc = out.books.find(b => b.code === 'OG12').sections.find(s => s.kind === 'RC');
  assert.equal(og12rc.questions.length, 0, 'the whole OG12 group goes, including its non-matching question');
  assert.equal(og12rc.passages.length, 0);
  assert.equal(report.rcGroupsDropped, 1);
  const og13rc = out.books.find(b => b.code === 'OG13').sections.find(s => s.kind === 'RC');
  assert.equal(og13rc.questions.length, 2);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- --test-name-pattern='fingerprint|CR question survives|survivor records|RC passage drops'
```

Expected: FAIL — `Cannot find module '../../scripts/og/dedup'`.

- [ ] **Step 3: Implement `scripts/og/dedup.js`**

```js
// scripts/og/dedup.js
// OG12 and OG13 reprint a large share of the same questions.
//
// CR dedups per question. RC dedups per PASSAGE, because dropping the
// questions that happen to match would leave the other edition's passage with
// a partial group — and a partial RC group is not practiceable.

function fingerprint(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function sectionsOf(pool, kind) {
  const out = [];
  for (const book of pool.books) {
    for (const section of book.sections) {
      if (section.kind === kind) out.push({ book, section });
    }
  }
  return out;
}

function dedupPool(pool, { prefer }) {
  const rank = code => {
    const i = prefer.indexOf(code);
    return i < 0 ? prefer.length : i;
  };
  const report = { crDropped: 0, rcGroupsDropped: 0, collisions: [] };

  // --- CR: per question -------------------------------------------------
  const crSeen = new Map();           // fingerprint -> kept question
  for (const { book, section } of sectionsOf(pool, 'CR').sort((a, b) => rank(a.book.code) - rank(b.book.code))) {
    const keep = [];
    for (const q of section.questions) {
      const fp = fingerprint(q.stem);
      const prior = crSeen.get(fp);
      if (prior) {
        prior.refs.push({ book: book.code, number: q.number });
        report.crDropped++;
        report.collisions.push({ kept: prior.id, dropped: q.id });
      } else {
        crSeen.set(fp, q);
        keep.push(q);
      }
    }
    section.questions = keep;
  }

  // --- RC: per passage group -------------------------------------------
  const rcSeen = new Map();           // passage fingerprint -> kept passage
  for (const { book, section } of sectionsOf(pool, 'RC').sort((a, b) => rank(a.book.code) - rank(b.book.code))) {
    const keptPassages = [];
    const dropIds = new Set();
    for (const p of (section.passages || [])) {
      const fp = fingerprint(p.text);
      const prior = rcSeen.get(fp);
      if (prior) {
        (prior.refs = prior.refs || []).push({ book: book.code, passageId: p.id });
        dropIds.add(p.id);
        report.rcGroupsDropped++;
        report.collisions.push({ kept: prior.id, dropped: p.id });
      } else {
        rcSeen.set(fp, p);
        keptPassages.push(p);
      }
    }
    section.passages = keptPassages;
    section.questions = section.questions.filter(q => !dropIds.has(q.passageId));
  }

  return { pool, report };
}

module.exports = { fingerprint, dedupPool };
```

- [ ] **Step 4: Run the tests and make them pass**

```bash
npm test -- --test-name-pattern='fingerprint|CR question survives|survivor records|RC passage drops'
```

Expected: 5 passing.

- [ ] **Step 5: Write the CLI**

Create `scripts/dedup-og-questions.js`:

```js
#!/usr/bin/env node
/* eslint-disable no-console */
// Dedup the OG pool across editions, preferring the newer book.
// Usage: node scripts/dedup-og-questions.js [--dry-run]

const fs = require('fs');
const path = require('path');
const { dedupPool } = require('./og/dedup');

const FILE = path.join(__dirname, '..', 'data', 'gmat-og-questions.json');
const dryRun = process.argv.includes('--dry-run');

const pool = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
const before = pool.books.flatMap(b => b.sections.map(s => `${b.code} ${s.kind} ${s.questions.length}`));
const { pool: out, report } = dedupPool(pool, { prefer: ['OG13', 'OG12', 'VR2'] });
const after = out.books.flatMap(b => b.sections.map(s => `${b.code} ${s.kind} ${s.questions.length}`));

console.log('before:', before.join(' | '));
console.log('after: ', after.join(' | '));
console.log(`CR questions dropped: ${report.crDropped}`);
console.log(`RC passage groups dropped: ${report.rcGroupsDropped}`);

if (!dryRun) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.copyFileSync(FILE, `${FILE}.bak-predupe-${stamp}`);
  fs.writeFileSync(FILE, JSON.stringify(out, null, 1));
  console.log('wrote', FILE);
}
```

- [ ] **Step 6: Dry-run and sanity-check the collision count**

```bash
node scripts/dedup-og-questions.js --dry-run
```

Read the numbers before writing. A very high collision count against Verbal Review 2e — which is a distinct pool and should collide rarely — means the 200-character fingerprint is too loose. Lengthen it and re-run rather than accepting the result.

- [ ] **Step 7: Run it for real and commit**

```bash
node scripts/dedup-og-questions.js
```

In `package.json` `"scripts"`, after `"og:passages"`:

```json
    "og:dedup": "node scripts/dedup-og-questions.js",
```

```bash
npm test && npm run lint 2>&1 | tail -3
git add scripts/og/dedup.js scripts/dedup-og-questions.js test/unit/og-dedup.test.js package.json
git commit -m "feat(og): dedup across editions, per question for CR and per passage for RC

Question-level dedup on RC would leave a passage with part of its group, which
is not practiceable, so a shared passage takes its whole group with it."
```

---

### Task 12: Difficulty pass

The OG books print no difficulty label, so one offline LLM pass assigns Easy/Medium/Hard. `scripts/classify-lsat-difficulty.core.mjs` already holds the batching, response parsing and retry plumbing; reuse it and replace only the parts that know the data shape and the prompt's framing.

The LSAT prompt asks the model to rate LSAT questions *on the GMAT scale* and warns against defaulting to Medium. These questions are already GMAT questions, so the calibration paragraph has to change — the OG pool spans the real exam's full range rather than sitting at its hard end.

This task spends API budget. Run it only once the report from Task 9 has cleared and the dedup in Task 11 has landed, so nothing is rated twice.

**Files:**
- Create: `scripts/classify-og-difficulty.core.mjs`
- Create: `scripts/classify-og-difficulty.mjs`
- Create: `test/unit/og-difficulty.test.js`
- Modify: `package.json` (add `og:difficulty`)

**Interfaces:**
- Consumes: `scripts/classify-lsat-difficulty.core.mjs` (`VALID_LABELS`, `extractText`, `parseModelResponse`), the deduped pool
- Produces: `scripts/classify-og-difficulty.core.mjs` exports `{ OG_SYSTEM_PROMPT, collectTargets, buildBatches, buildPromptPayload, applyLabels }`
  - `collectTargets(pool, {book, kind, force, limit}) -> Array<{bookCode, kind, number, id, stem, choices, passageText}>` — skips questions that already carry a `difficulty` unless `force`
  - `applyLabels(pool, batch, labels, model) -> number` — writes `difficulty` and `difficulty_source: 'llm'`, returns how many it set

- [ ] **Step 1: Write the failing test**

Create `test/unit/og-difficulty.test.js`:

```js
// test/unit/og-difficulty.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');

// The classifier core is ESM; load it the way src/db.js loads reviewNotes.mjs.
const core = () => import('../../scripts/classify-og-difficulty.core.mjs');

const pool = () => ({ books: [
  { code: 'OG13', sections: [
    { kind: 'CR', questions: [
      { id: 'OG13-CR-1', number: 1, stem: 'Stem one.', choices: [{ label: 'A', text: 'a' }] },
      { id: 'OG13-CR-2', number: 2, stem: 'Stem two.', choices: [], difficulty: 'Hard', difficulty_source: 'llm' },
    ] },
    { kind: 'RC', passages: [{ id: 'OG13-RC-p358', text: 'A passage.' }], questions: [
      { id: 'OG13-RC-1', number: 1, stem: 'Purpose?', choices: [], passageId: 'OG13-RC-p358' },
    ] },
  ] },
] });

test('collectTargets skips questions that already have a difficulty', async () => {
  const { collectTargets } = await core();
  const t = collectTargets(pool(), {});
  assert.deepEqual(t.map(x => x.id), ['OG13-CR-1', 'OG13-RC-1']);
});

test('collectTargets --force re-rates everything', async () => {
  const { collectTargets } = await core();
  assert.equal(collectTargets(pool(), { force: true }).length, 3);
});

test('an RC target carries its passage text so the model can judge it', async () => {
  const { collectTargets } = await core();
  const rc = collectTargets(pool(), {}).find(x => x.kind === 'RC');
  assert.equal(rc.passageText, 'A passage.');
});

test('applyLabels writes difficulty and its source, and counts what it set', async () => {
  const { applyLabels, collectTargets, buildBatches } = await core();
  const p = pool();
  const batch = buildBatches(collectTargets(p, {}))[0];
  const labels = new Map([['OG13-CR-1', 'Medium'], ['OG13-RC-1', 'Easy']]);
  const n = applyLabels(p, batch, labels, 'test-model');
  assert.equal(n, 2);
  const q = p.books[0].sections[0].questions[0];
  assert.equal(q.difficulty, 'Medium');
  assert.equal(q.difficulty_source, 'llm');
});

test('applyLabels refuses a label outside the vocabulary', async () => {
  const { applyLabels, collectTargets, buildBatches } = await core();
  const p = pool();
  const batch = buildBatches(collectTargets(p, {}))[0];
  const n = applyLabels(p, batch, new Map([['OG13-CR-1', 'Impossible']]), 'test-model');
  assert.equal(n, 0);
  assert.equal(p.books[0].sections[0].questions[0].difficulty, undefined);
});

test('the prompt frames these as GMAT questions, not LSAT ones', async () => {
  const { OG_SYSTEM_PROMPT } = await core();
  assert.match(OG_SYSTEM_PROMPT, /GMAT/);
  assert.doesNotMatch(OG_SYSTEM_PROMPT, /LSAT/);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- --test-name-pattern='collectTargets|applyLabels|prompt frames'
```

Expected: FAIL — cannot resolve `classify-og-difficulty.core.mjs`.

- [ ] **Step 3: Implement the core**

Create `scripts/classify-og-difficulty.core.mjs`. It reuses the LSAT core's response handling and label vocabulary and replaces the data-shape and prompt pieces:

```js
// scripts/classify-og-difficulty.core.mjs
// Pure, network-free helpers for rating OG question difficulty.
// Response parsing and the label vocabulary are shared with the LSAT rater.

import { VALID_LABELS } from './classify-lsat-difficulty.core.mjs';
export { VALID_LABELS, extractText, parseModelResponse } from './classify-lsat-difficulty.core.mjs';

export const OG_SYSTEM_PROMPT = [
  'You are a GMAT difficulty rater. You are given official GMAT Critical Reasoning and',
  'Reading Comprehension questions from the Official Guide, and must rate how hard each',
  'one is on the GMAT scale.',
  '',
  'CALIBRATION: Unlike a curated hard set, the Official Guide spans the whole exam range —',
  'it opens each chapter with genuinely easy items and works upward. Expect a broad spread,',
  'roughly a third Easy, a third Medium and a third Hard. Do NOT default to Medium.',
  '',
  'Rate each question on its own merits. Reply with one line per question in the form',
  '<id>: <Easy|Medium|Hard> and nothing else.',
].join('\n');

function eachQuestion(pool, fn) {
  for (const book of pool.books) {
    for (const section of book.sections) {
      const passages = new Map((section.passages || []).map(p => [p.id, p]));
      for (const q of section.questions) fn({ book, section, q, passages });
    }
  }
}

export function collectTargets(pool, { book = null, kind = null, force = false, limit = null } = {}) {
  const out = [];
  eachQuestion(pool, ({ book: b, section, q, passages }) => {
    if (book && b.code !== book) return;
    if (kind && section.kind !== kind) return;
    if (!force && q.difficulty) return;
    const p = q.passageId ? passages.get(q.passageId) : null;
    out.push({
      bookCode: b.code, kind: section.kind, number: q.number, id: q.id,
      stem: q.stem, choices: q.choices || [], passageText: p ? p.text : null,
    });
  });
  return limit ? out.slice(0, Number(limit)) : out;
}

// RC entries carry a passage and are much longer, so they batch smaller.
export function buildBatches(targets, { crBatchSize = 15, rcBatchSize = 5 } = {}) {
  const batches = [];
  for (const kind of ['CR', 'RC']) {
    const group = targets.filter(t => t.kind === kind);
    const size = kind === 'CR' ? crBatchSize : rcBatchSize;
    for (let i = 0; i < group.length; i += size) {
      batches.push({ kind, entries: group.slice(i, i + size) });
    }
  }
  return batches;
}

export function buildPromptPayload(batch) {
  const parts = batch.entries.map(e => {
    const head = e.passageText ? `PASSAGE:\n${e.passageText}\n\n` : '';
    const choices = e.choices.map(c => `(${c.label}) ${c.text}`).join('\n');
    return `### ${e.id}\n${head}QUESTION:\n${e.stem}\n${choices}`;
  });
  return { system: OG_SYSTEM_PROMPT, user: parts.join('\n\n') };
}

export function applyLabels(pool, batch, labels, model) {
  const wanted = new Map(batch.entries.map(e => [e.id, true]));
  let applied = 0;
  eachQuestion(pool, ({ q }) => {
    if (!wanted.has(q.id)) return;
    const label = labels.get(q.id);
    if (!VALID_LABELS.includes(label)) return;
    q.difficulty = label;
    q.difficulty_source = 'llm';
    q.difficulty_model = model;
    applied++;
  });
  return applied;
}
```

- [ ] **Step 4: Run the tests and make them pass**

```bash
npm test -- --test-name-pattern='collectTargets|applyLabels|prompt frames'
```

Expected: 6 passing. If `parseModelResponse` from the LSAT core keys on question *numbers* rather than ids, adapt the OG caller to pass ids through the same shape rather than changing the shared function — the LSAT rater depends on it.

- [ ] **Step 5: Write the CLI**

Create `scripts/classify-og-difficulty.mjs`, copying the structure of `scripts/classify-lsat-difficulty.mjs`: `buildModel` reading `OPENAI_API_KEY`/`LLM_API_KEY` and the optional base URL, `classifyBatch` with two attempts and a 1.5s backoff, a one-time timestamped backup of the pool before the first write, and a periodic flush so an interrupted run keeps its progress. Flags: `--book`, `--kind`, `--limit`, `--force`, `--dry-run`.

- [ ] **Step 6: Rate a small slice first and read the spread**

```bash
node scripts/classify-og-difficulty.mjs --limit 30
node -e '
const d=require("./data/gmat-og-questions.json"),c={};
for (const b of d.books) for (const s of b.sections) for (const q of s.questions)
  if (q.difficulty) c[q.difficulty]=(c[q.difficulty]||0)+1;
console.log(c);
'
```

Expected: a spread across all three labels. If 30 questions all come back Medium, the calibration paragraph is not landing — fix the prompt before spending the full run.

- [ ] **Step 7: Run the full pass**

```bash
node scripts/classify-og-difficulty.mjs
```

- [ ] **Step 8: Add the npm script and commit**

In `package.json` `"scripts"`, after `"og:dedup"`:

```json
    "og:difficulty": "node scripts/classify-og-difficulty.mjs",
```

```bash
npm test && npm run lint 2>&1 | tail -3
git add scripts/classify-og-difficulty.core.mjs scripts/classify-og-difficulty.mjs \
        test/unit/og-difficulty.test.js package.json
git commit -m "feat(og): rate OG question difficulty with one offline LLM pass

Reuses the LSAT rater's response handling and label vocabulary; the prompt is
recalibrated because the Official Guide spans the whole exam range rather than
sitting at its hard end."
```

---

### Task 13: Acceptance run and documentation

Prove the pool meets the spec's acceptance criteria, write down what the next person needs, and clean up.

**Files:**
- Create: `scripts/og/verify.js`
- Create: `test/unit/og-verify.test.js`
- Modify: `package.json` (add `og:verify`)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the finished pool
- Produces: `module.exports = { verifyPool }`; `verifyPool(pool) -> {ok: boolean, checks: Array<{name, ok, detail}>}`

- [ ] **Step 1: Write the failing test**

Create `test/unit/og-verify.test.js`:

```js
// test/unit/og-verify.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { verifyPool } = require('../../scripts/og/verify');

const q = (over = {}) => ({
  id: 'OG13-CR-1', number: 1, stem: 'A stem.',
  choices: 'ABCDE'.split('').map(l => ({ label: l, text: l.toLowerCase() })),
  correct: 'B', typeLabel: 'Argument Construction', difficulty: 'Medium',
  keyDisputed: false, ...over,
});

const good = () => ({ books: [{ code: 'OG13', sections: [
  { kind: 'CR', questions: [q()] },
  { kind: 'RC', passages: [{ id: 'OG13-RC-p358', text: 'Passage.' }],
    questions: [q({ id: 'OG13-RC-1', passageId: 'OG13-RC-p358' })] },
] }] });

test('a clean pool passes every check', () => {
  const r = verifyPool(good());
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter(c => !c.ok)));
});

test('an unkeyed question fails the key check', () => {
  const p = good();
  p.books[0].sections[0].questions[0].correct = null;
  const r = verifyPool(p);
  assert.equal(r.ok, false);
  assert.ok(r.checks.find(c => c.name === 'every question keyed' && !c.ok));
});

test('a disputed key fails even when a letter is present', () => {
  const p = good();
  p.books[0].sections[0].questions[0].keyDisputed = true;
  assert.equal(verifyPool(p).ok, false);
});

test('an RC question with no passage fails', () => {
  const p = good();
  p.books[0].sections[1].questions[0].passageId = null;
  const r = verifyPool(p);
  assert.ok(r.checks.find(c => c.name === 'every RC question has a passage' && !c.ok));
});

test('a passage with no questions fails', () => {
  const p = good();
  p.books[0].sections[1].passages.push({ id: 'OG13-RC-p999', text: 'Orphan.' });
  const r = verifyPool(p);
  assert.ok(r.checks.find(c => c.name === 'every passage has questions' && !c.ok));
});

test('a boldface stem with no bold span fails', () => {
  const p = good();
  p.books[0].sections[0].questions[0].stem = 'In the argument, the portion in boldface plays which role?';
  const r = verifyPool(p);
  assert.ok(r.checks.find(c => c.name === 'boldface stems carry bold spans' && !c.ok));
});

test('footer junk left in a stem fails', () => {
  const p = good();
  p.books[0].sections[0].questions[0].stem = 'A stem. QQ:1014347461制作';
  const r = verifyPool(p);
  assert.ok(r.checks.find(c => c.name === 'no watermark or footer junk' && !c.ok));
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- --test-name-pattern='clean pool|unkeyed|disputed key|no passage|no questions|bold span|footer junk'
```

Expected: FAIL — `Cannot find module '../../scripts/og/verify'`.

- [ ] **Step 3: Implement `scripts/og/verify.js`**

```js
// scripts/og/verify.js
// The spec's acceptance criteria, as runnable checks.

const FIVE_CHOICE_MIN = 0.98;

function allQuestions(pool) {
  const out = [];
  for (const b of pool.books) for (const s of b.sections)
    for (const q of s.questions) out.push({ book: b, section: s, q });
  return out;
}

function verifyPool(pool) {
  const all = allQuestions(pool);
  const checks = [];
  const add = (name, bad, detail) =>
    checks.push({ name, ok: bad.length === 0, detail: detail || bad.slice(0, 10).join(', ') });

  add('every question keyed', all.filter(x => !x.q.correct).map(x => x.q.id));
  add('no disputed keys', all.filter(x => x.q.keyDisputed).map(x => x.q.id));

  const five = all.filter(x => (x.q.choices || []).length === 5).length;
  const ratio = all.length ? five / all.length : 0;
  checks.push({
    name: 'at least 98% have five choices', ok: ratio >= FIVE_CHOICE_MIN,
    detail: `${Math.round(ratio * 1000) / 10}%`,
  });

  add('no watermark or footer junk',
    all.filter(x => /QQ:\d{6,}|制作/.test(x.q.stem)
      || (x.q.choices || []).some(c => /QQ:\d{6,}|制作/.test(c.text)))
      .map(x => x.q.id));

  add('every RC question has a passage',
    all.filter(x => x.section.kind === 'RC' && !x.q.passageId).map(x => x.q.id));

  const used = new Set(all.filter(x => x.q.passageId).map(x => x.q.passageId));
  const orphans = [];
  for (const b of pool.books) for (const s of b.sections)
    for (const p of (s.passages || [])) if (!used.has(p.id)) orphans.push(p.id);
  add('every passage has questions', orphans);

  add('boldface stems carry bold spans',
    all.filter(x => /\bbold\s*face|\bboldfaced\b/i.test(x.q.stem)
      && !(x.q.stemHtml && /<b>/.test(x.q.stemHtml))).map(x => x.q.id));

  add('every question has a type label', all.filter(x => !x.q.typeLabel).map(x => x.q.id));
  add('every question has a difficulty', all.filter(x => !x.q.difficulty).map(x => x.q.id));

  return { ok: checks.every(c => c.ok), checks };
}

module.exports = { verifyPool };
```

- [ ] **Step 4: Run the tests and make them pass**

```bash
npm test -- --test-name-pattern='clean pool|unkeyed|disputed key|no passage|no questions|bold span|footer junk'
```

Expected: 7 passing.

- [ ] **Step 5: Add the verify CLI hook and run it on the real pool**

In `package.json` `"scripts"`, after `"og:difficulty"`:

```json
    "og:verify": "node -e \"const{verifyPool}=require('./scripts/og/verify');const r=verifyPool(require('./data/gmat-og-questions.json'));for(const c of r.checks)console.log((c.ok?'PASS':'FAIL').padEnd(5),c.name,c.detail?'-- '+c.detail:'');process.exit(r.ok?0:1)\"",
```

```bash
npm run og:verify
```

Expected: every line `PASS`. Any `FAIL` names the offending ids — fix at the parser that produced them, re-run the pipeline, verify again.

If Verbal Review 2e is the only book failing and re-OCR did not rescue it, take the spec's stated fallback: drop VR2 from `BOOKS` in `scripts/og/books.js`, re-run, and **report the gap explicitly** rather than shipping unreadable questions.

- [ ] **Step 6: Document the pipeline in CLAUDE.md**

Add a section after "## LSAT practice (PDF-extracted, separate from the scrapers)":

```markdown
## GMAT OG verbal practice (PDF-extracted)

Critical Reasoning and Reading Comprehension questions extracted from three
Official Guide PDFs into `data/gmat-og-questions.json` (gitignored; `.bak-*`
siblings are the rollback). Sentence Correction is out of scope.

**The source PDFs in `docs/` are copyrighted and gitignored** (`/docs/*.pdf`).
This repo is public — never commit them, and never commit `docs/ocr/`.

Pipeline, in order (`npm run og:parse` → `og:passages` → `og:dedup` →
`og:difficulty` → `og:verify`):

- `scripts/og/*.js` — the parsers, one per failure mode: `regions.js` slices a
  book into practice/key/explanations, `answer-key.js` handles both printed
  layouts, `questions.js` reads the practice section, `explanations.js` reads
  type labels and the second key, `assemble.js` reconciles them.
- `scripts/extract-og-passages.py` — pdfplumber pass for RC passages (paragraphs,
  gutter line numbers) and CR boldface spans. Reuses the LSAT extractor's
  column-gutter machinery. Never alters questions, choices or keys.
- `scripts/classify-og-difficulty.mjs` — one LLM pass; reuses the LSAT rater's
  core with a recalibrated prompt.

**Every answer key is derived twice** — once from the book's printed key list,
once from the `Correct.` marker and closing line in the answer explanations —
and a disagreement leaves the question unkeyed and flagged rather than resolved.
This is not belt-and-braces: **OG13's printed CR key (section 8.5) is a rotated
table that OCR destroyed**, so for that section the explanations are the only
key source.

Source hazards, all handled in `scripts/og/text.js`: OG13 reads `(C)` as `(0`
(418 lines) and carries a `QQ:1014347461制作` watermark; Verbal Review 2e reads
`(B)` as `(8)` (394 lines) and, in its four-column answer-key grid, reads `1.`
as `I.`, `101.` as `lOI.` and the letter `D` as a bare `0`. Section headings
recur as running heads inside their own section, and VR2's OCR breaks them at a
different point on nearly every page — hence the whitespace-insensitive match.

`loadOgData()` in `server.js` caches in-process, so **restart the API after
regenerating the file**, same as LSAT.
```

- [ ] **Step 7: Clean up scratch files**

```bash
cd /Users/pletopichaiyoot/Desktop/codespace/gmat-error-log
rm -rf tmp/og tmp/og-parse-report.md
ls tmp/
```

Expected: only `.gitkeep`. (CLAUDE.md, "Temp file convention")

- [ ] **Step 8: Final check and commit**

```bash
npm test && npm run lint 2>&1 | tail -3 && npm run og:verify
git status --short
git add scripts/og/verify.js test/unit/og-verify.test.js package.json CLAUDE.md
git commit -m "feat(og): add acceptance checks and document the extraction pipeline

npm run og:verify runs the spec's acceptance criteria against the pool."
```

`git status --short` must show no PDF and no `data/gmat-og-questions.json` — if either appears, Task 1 did not take.

---

## Self-review

**Spec coverage.** Stage 0 re-OCR → Task 2. Stage 1 parsing, with the two-source key cross-check and the stem fallback → Tasks 3-9. Stage 2 passages and boldface → Task 10. Stage 3 dedup, CR per question and RC per passage group → Task 11. Stage 4 difficulty → Task 12. The data-file schema → Tasks 8, 10 and 12 between them write every field the spec lists. The acceptance criteria → Task 13. The `.gitignore` requirement → Task 1.

Not covered here, by design: migration `0010`, `src/og-dashboard.js`, `/api/og/*`, `GmatOgPractice.jsx` and the merge into `/api/sessions`. Those are the practice-track plan, written once this pool exists.

**Deferred from the spec to the track plan:** the spec's `explanation.choices` is written as `{A: text, ...}` here, matching what `parseExplanations` produces. The spec's schema sketch showed the same shape, so no drift.

**Naming consistency.** `findRegions`/`headingsFor` (Task 4) are called in Tasks 5-9 exactly as defined. `parseAnswerKey` returns `{layout, keys, skipped}` in Task 5 and is destructured that way in Task 8. `parseQuestions` returns `{questions, warnings}` in Task 6, consumed that way in Task 8. `parseExplanations` returns `{entries, passageRefs, warnings}` in Task 7, consumed that way in Task 8 and its `passageRefs` flow into Task 10's `linkQuestionsToPassages`. `assembleSection` returns `{section, stats, warnings}` in Task 8 and the CLI in Task 9 destructures all three. `q.id` is `<book>-<kind>-<number>` from Task 8 onward, and Task 10's `passageId` is derived from it.

**Known soft spot.** Task 8's stem fallback re-runs `parseQuestions` over the whole explanations region once per fallback question. That is O(n²) on a region of a few thousand lines and only fires for questions missing from the practice section — measured in single digits, if any. Left simple deliberately; if the fallback count turns out large, hoist the parse out of the loop.

## Execution status: COMPLETE (2026-09-15)

All thirteen tasks are done and committed on `feat/og-verbal-extraction`
(17 commits, not pushed). 316 unit tests pass, lint adds no new warnings, and
`npm run og:verify` reports all eleven acceptance checks passing.

**Pipeline** — `og:parse` → `og:passages` → `og:dedup` →
`node scripts/classify-og-difficulty.mjs` → `og:verify`. Difficulty ratings are
carried across a re-parse by `scripts/og/carry-ratings.js`, so rebuilding the
pool does not re-spend on the only step that costs money.

**Result: 377 usable questions** in `data/gmat-og-questions.json` (gitignored).

| Book | CR | RC |
|---|---|---|
| OG 12e | 123 | 137 |
| OG 13e | — withheld | 21 |
| Verbal Review 2e | 59 | 37 |

277 carry the book's question-type label and full answer explanation; 100 are
keyed and answerable but unenriched. 162 questions were excluded:
73 unverifiable-key, 27 no-passage, 26 truncated-choice, 12 no-key,
10 wrong choice count, 8 blank-choice, 4 key-disputed, 2 lopsided-choice.

**The usability bar is that a question is ANSWERABLE** (user's rule, 2026-09-15):
a missing or dropped explanation does not disqualify it; a defect in the
passage, stem, choices or key does.

### What the real PDFs disproved, and what it cost

Every one of these was found by measuring, not by reading the plan:

- `--redo-ocr` refuses `--deskew`, and piping ocrmypdf into `tail` hides the
  refusal behind the pipe's exit status.
- **Neither text layer wins everywhere.** Re-OCR fixed 418 misread `(C)` labels
  in OG13 but destroyed its answer-key tables and lost two thirds of the
  question numbers in its explanations. `select-source.js` chooses per region.
- **The `X.4` heading does not start the practice material** — question 1
  precedes it in the text stream.
- **The scans lose question numbers wholesale**, so questions segment on the
  choice run restarting at `(A)`.
- **A choice had nothing ending it** — one OG12 choice reached 3,100 characters,
  swallowing a page footer, a header and the following passage.
- **Explanations were paired to questions by a guessed number.** Verified
  against choice text instead; a pairing that reprints a different question is
  dropped. OG13's CR section has no printed key AND inferred numbering, so
  nothing cross-checks it — measured against OG12's double-confirmed keys,
  3 agreed and 4 disagreed, so the section is withheld entirely.
- **Difficulty is a rough relative ranking, not a calibrated measure.** Asked
  for a label directly the model put 319 of 448 in one bucket; asked for a
  percentage it clusters in 72-82 and correlates only ~0.15-0.22 with printed
  question order. Labels are tertiles of the estimates; `--relabel` re-cuts
  them for free from the stored `difficulty_pct`.

### Next phase — not started

The practice track: migration `0010` (`og_attempts`, `og_sessions`),
`src/og-dashboard.js`, `/api/og/*`, `client/src/GmatOgPractice.jsx` at `#og`,
and merging OG into `/api/sessions` and `/api/errors` under `platform=og`.
Design decisions already agreed with the user and recorded in the spec:
StartTest-style filter-based set builder (book, subject, type label, difficulty,
seen/unseen/wrong, count, timed), RC draws whole passages, Practice vs Timed
explanation modes. **That plan has not been written yet.**

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-14-gmat-og-verbal-extraction.md`.
