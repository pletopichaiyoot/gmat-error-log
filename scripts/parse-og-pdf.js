#!/usr/bin/env node
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
const { pickRegions } = require('./og/select-source');
const { parseAnswerKey } = require('./og/answer-key');
const { parseQuestions } = require('./og/questions');
const { parseExplanations } = require('./og/explanations');
const { assembleSection } = require('./og/assemble');
const { linkQuestionsToPassages } = require('./og/passage-link');
const { carryRatings } = require('./og/carry-ratings');

const OUT = path.join(__dirname, '..', 'data', 'gmat-og-questions.json');
const REPORT = path.join(__dirname, '..', 'tmp', 'og-parse-report.md');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const onlyBook = arg('--book');
const onlyKind = arg('--kind');
const dryRun = process.argv.includes('--dry-run');

const textCache = new Map();
function readText(pdf) {
  if (textCache.has(pdf)) return textCache.get(pdf);
  const out = cp.execFileSync('pdftotext', ['-raw', pdf, '-'],
    { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n');
  textCache.set(pdf, out);
  return out;
}

// A re-OCR'd book has two text layers and neither is better everywhere, so
// each region takes the one that parses better for its job. See select-source.
function layersFor(book) {
  const out = [];
  if (book.ocrPdf && fs.existsSync(book.ocrPdf)) out.push(['ocr', book.ocrPdf]);
  out.push(['orig', book.pdf]);
  return out;
}

const books = [];
const rows = [];
const allWarnings = [];

for (const book of BOOKS) {
  if (onlyBook && book.code !== onlyBook) continue;
  if (!fs.existsSync(book.pdf)) {
    allWarnings.push(`${book.code}: missing PDF ${book.pdf}`);
    continue;
  }
  const sections = [];

  for (const kind of ['RC', 'CR']) {
    if (onlyKind && kind !== onlyKind) continue;

    const candidates = layersFor(book).map(([tag, pdf]) => {
      try {
        return { tag, regions: findRegions(readText(pdf), book, kind) };
      } catch (err) {
        return { tag, error: err.message };
      }
    });

    let picked;
    try {
      picked = pickRegions(candidates);
    } catch (err) {
      rows.push({ book: book.code, kind, error: err.message });
      allWarnings.push(`${book.code}-${kind}: ${err.message}`);
      continue;
    }

    const key = parseAnswerKey(picked.regions.key);
    if (key.layout === 'unreadable') {
      allWarnings.push(`${book.code}-${kind}: printed answer key unreadable; relying on explanations`);
    }
    const practice = parseQuestions(picked.regions.practice);
    const expl = parseExplanations(picked.regions.explanations);
    allWarnings.push(...practice.warnings.map(w => `${book.code}-${kind} practice: ${w}`));
    allWarnings.push(...expl.warnings.map(w => `${book.code}-${kind} explanations: ${w}`));

    // RC questions need their passage before they can be judged usable, so
    // link them to the printed references first.
    let linkWarnings = [];
    if (kind === 'RC') {
      try {
        const linked = linkQuestionsToPassages(
          { kind, passageRefs: expl.passageRefs, questions: practice.questions }, book.code);
        if (linked.unlinked.length) {
          linkWarnings = [`${book.code}-${kind}: ${linked.unlinked.length} questions ` +
            'fall outside every printed passage reference'];
        }
      } catch (err) {
        linkWarnings = [`${book.code}-${kind}: ${err.message}`];
      }
    }
    allWarnings.push(...linkWarnings);

    const { section, stats, warnings } = assembleSection({
      book, kind,
      questions: practice.questions,
      keys: key.keys,
      explanations: expl.entries,
      passageRefs: expl.passageRefs,
    });
    allWarnings.push(...warnings);
    sections.push(section);
    rows.push({ book: book.code, kind, sources: picked.sources, keyLayout: key.layout, ...stats });
  }

  books.push({ code: book.code, title: book.title, sections });
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

const lines = ['# OG parse report', '', `Generated ${new Date().toISOString()}`, ''];
lines.push('| Book | Kind | Parsed | **Usable** | Keyed | Disputed | 5-choice | Labelled | Inferred no. | Sources p/k/e |');
lines.push('|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  if (r.error) { lines.push(`| ${r.book} | ${r.kind} | — | — | — | — | — | — | — | ${r.error} |`); continue; }
  const s = `${r.sources.practice}/${r.sources.key}/${r.sources.explanations}`;
  lines.push(`| ${r.book} | ${r.kind} | ${r.total} | **${r.usable}** | ${pct(r.keyed, r.total)}% | ${r.disputed} | ` +
    `${pct(r.fiveChoice, r.total)}% | ${pct(r.labelled, r.total)}% | ` +
    `${r.numberInferred} | ${s} |`);
}
const totals = rows.filter(r => !r.error).reduce((a, r) => ({
  total: a.total + r.total, usable: a.usable + r.usable,
}), { total: 0, usable: 0 });
lines.push('', `**${totals.usable} usable of ${totals.total} parsed.**`, '');
lines.push('', `## Warnings (${allWarnings.length})`, '');
for (const w of allWarnings) lines.push(`- ${w}`);

fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, lines.join('\n'));

// The difficulty pass is the only step that costs money, and a re-parse would
// otherwise throw it away.
let carried = 0;
if (fs.existsSync(OUT)) {
  try {
    carried = carryRatings({ books }, JSON.parse(fs.readFileSync(OUT, 'utf-8')));
  } catch (err) {
    console.warn(`could not carry existing difficulty ratings: ${err.message}`);
  }
}

if (!dryRun) {
  if (fs.existsSync(OUT)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    fs.copyFileSync(OUT, `${OUT}.bak-parse-${stamp}`);
  }
  fs.writeFileSync(OUT, JSON.stringify({ books }, null, 1));
  console.log(`wrote ${OUT}`);
}
console.log(`wrote ${REPORT}`);
if (carried) console.log(`carried ${carried} difficulty ratings from the previous pool`);
for (const r of rows) {
  if (r.error) { console.log(`${r.book} ${r.kind}  ERROR ${r.error}`); continue; }
  console.log(`${r.book} ${r.kind}  parsed=${String(r.total).padStart(3)} ` +
    `usable=${String(r.usable).padStart(3)} ` +
    `keyed=${String(pct(r.keyed, r.total)).padStart(5)}% disputed=${String(r.disputed).padStart(2)} ` +
    `5ch=${String(pct(r.fiveChoice, r.total)).padStart(5)}%`);
}
const usableTotal = rows.filter(r => !r.error).reduce((a, r) => a + r.usable, 0);
const parsedTotal = rows.filter(r => !r.error).reduce((a, r) => a + r.total, 0);
console.log(`\n${usableTotal} usable of ${parsedTotal} parsed.`);
