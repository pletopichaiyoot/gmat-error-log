#!/usr/bin/env node
/* eslint-disable no-console */
// Parse LSAT PrepTest PDF (extracted to raw text via `pdftotext -raw`) into structured JSON.
// Output: data/lsat-questions.json with tests -> sections -> questions

const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || '/tmp/lsat-probe/full-raw.txt';
const OUT = process.argv[3] || path.join(__dirname, '..', 'data', 'lsat-questions.json');

const raw = fs.readFileSync(SRC, 'utf-8');
const lines = raw.split('\n');

// ---------- 1. Find test boundaries ----------
function detectTests() {
  const anchors = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let m;
    if ((m = ln.match(/^PrepTest\s+(\d+)\s*$/i))) {
      anchors.push({ line: i, num: parseInt(m[1], 10), kind: 'preptest' });
    } else if ((m = ln.match(/^Test ID:?\s*LL30(\d{2})/i))) {
      anchors.push({ line: i, num: parseInt(m[1], 10), kind: 'testid' });
    } else if ((m = ln.match(/^(?:[A-Z][a-z]+\s+\d{4})\s*[-–—]\s*PrepTest\s+(\d+)/i))) {
      anchors.push({ line: i, num: parseInt(m[1], 10), kind: 'date-prefix' });
    } else if ((m = ln.match(/PT\s+(\d+)\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d+/i))) {
      // PT 42 December 03 style - anchor only if it appears at the start of a test
      anchors.push({ line: i, num: parseInt(m[1], 10), kind: 'pt-date' });
    } else if ((m = ln.match(/^(\d+)\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\s*$/))) {
      const num = parseInt(m[1], 10);
      if (num >= 50 && num <= 89) anchors.push({ line: i, num, kind: 'date-only' });
    }
  }
  // Keep first anchor per test number
  const byNum = new Map();
  for (const a of anchors) {
    if (!byNum.has(a.num)) byNum.set(a.num, a);
  }
  return Array.from(byNum.values()).sort((x, y) => x.line - y.line);
}

const testStarts = detectTests();
console.log(`Detected ${testStarts.length} tests:`, testStarts.map(t => t.num).join(','));

const tests = testStarts.map((t, i) => ({
  num: t.num,
  startLine: t.line,
  endLine: i + 1 < testStarts.length ? testStarts[i + 1].line : lines.length,
}));

// ---------- 2. Section types from cover-page TOC ----------
function findSectionTypes(testLines) {
  // Look at first ~150 lines for cover-page TOC entries
  const head = testLines.slice(0, 200).join('\n');
  const types = {};
  const re = /(Reading Comprehension|Logical Reasoning|Analytical Reasoning)[^A-Z]*?SECTION\s+(I{1,3}V?|IV|V)/gi;
  let m;
  while ((m = re.exec(head)) !== null) {
    const subject = m[1].toLowerCase();
    const sec = m[2].toUpperCase();
    let kind = null;
    if (subject.startsWith('reading')) kind = 'RC';
    else if (subject.startsWith('logical')) kind = 'LR';
    else if (subject.startsWith('analytical')) kind = 'AR';
    if (kind && !types[sec]) types[sec] = kind;
  }
  return types;
}

// ---------- 3. Find sections via STOP markers ----------
function findSections(testLines) {
  // STOP markers signal section ends
  const stopIdxs = [];
  for (let i = 0; i < testLines.length; i++) {
    if (/^S\s*T\s*O\s*P\s*$/.test(testLines[i])) stopIdxs.push(i);
  }
  return stopIdxs;
}

// ---------- 4. Detect section type from Question count + Directions ----------
function detectSectionKindFromHeader(sectionLines) {
  // Look at the section header (within first ~30 lines) for Q count and directions
  const head = sectionLines.slice(0, 50).join(' ');
  // RC has "Each passage in this section" or "single passage or a pair of passages"
  if (/Each passage in this section|single passage or a pair of passages|each passage is followed/i.test(head)) return 'RC';
  // LR has "based on the reasoning contained in"
  if (/based on the reasoning contained|brief statements or passages/i.test(head)) return 'LR';
  // AR (Logic Games) has "Each group of questions" or "based on the same set of conditions"
  if (/based on the same set of conditions|the questions in each group are/i.test(head)) return 'AR';
  return null;
}

// ---------- 5. Parse questions in a section ----------
function parseSectionContent(sectionText, sectionKind) {
  // Step 1: Convert form-feed page-break chars FIRST so subsequent line-level
  // strips and our PAGEBREAK sentinel both line up properly.
  let cleaned = sectionText.replace(/\f/g, '\n__PAGEBREAK__\n');

  // Step 2: Strip page-noise lines that pdftotext emits between PDF pages.
  cleaned = cleaned
    .replace(/^GO ON TO THE NEXT PAGE\.?$/gm, '__PAGEBREAK__')
    .replace(/^\d+\s*-\d+-\s*$/gm, '')
    .replace(/^[A-Z]\s*-\d+-\s*$/gm, '')
    .replace(/^\s*\[\s*\]\s*\d+\s*$/gm, '')
    .replace(/^PT\s+\d+\s+\d+\/\d+\/\d+.*?Page\s+\S+/gm, '')
    .replace(/^([A-Z]\s){2,}[A-Z]?\s*-\d+-\s*$/gm, '')
    .replace(/^([A-Z]\s){2,}[A-Z]?\s*$/gm, '')
    .replace(/^\s*\d+\s+\d+(\s+\d+)*\s*$/gm, '')
    .replace(/^\s*\(\d+\)\s*$/gm, '')
    .replace(/^\s*SECTION\s+[IVX]+\s*$/gm, '')
    .replace(/^\s*Time\s*[—–\-:]\s*\d+\s+[Mm]inutes\s*$/gm, '')
    .replace(/^\s*\d+\s+Questions\s*$/gm, '')
    .replace(/^\s*\d{1,2}\s*$/gm, '');

  // Step 3: Strip leading `(NN)` line markers from question starts.
  cleaned = cleaned.replace(/^(\(\d+\))(\d{1,2}\.\s)/gm, '$2');

  // Pre-process: split lines where boilerplate/directions are concatenated with a question start.
  // e.g. "DO NOT WORK ON ANY OTHER SECTION IN THE TEST. 1. It is..." -> two lines.
  cleaned = cleaned.replace(/([a-z\.\)])\s*(\d{1,2}\.\s+[A-Z])/g, '$1\n$2');

  // Pre-process: split lines where a question-start is concatenated to a footer or end-of-prior-question text.
  // e.g. "A A A A A -16- 19. It is unlikely..." -> "-16-" and "19. It is unlikely..."
  cleaned = cleaned.replace(/(-\d+-)\s*(\d{1,2}\.\s+[A-Z])/g, '$1\n$2');

  // Pre-process: split TOC lines that are concatenated with passage start.
  // e.g. "Logical Reasoning . . . SECTION IVFor the poet..." -> separate lines.
  cleaned = cleaned.replace(/(SECTION\s+(?:I{1,3}V?|IV|V))\s*([A-Z][a-z])/g, '$1\n$2');

  const all = cleaned.split('\n');

  // Find question-start lines: "N. text..."
  const candidates = [];
  for (let i = 0; i < all.length; i++) {
    const m = all[i].match(/^(\d{1,2})\.\s+(.+)/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n < 1 || n > 35) continue;
    // Sanity check: rest of line should look like a question stem (not just "C" or "B" alone)
    const rest = m[2].trim();
    if (rest.length < 5) continue;
    // Reject lines like "1. C" or "1. B" (those are answer-key lines)
    if (/^[A-E]\s*$/.test(rest)) continue;
    candidates.push({ idx: i, n });
  }

  // Greedily build a monotonically-increasing question sequence starting at 1
  const qs = [];
  for (const c of candidates) {
    if (qs.length === 0) {
      if (c.n === 1) qs.push(c);
      continue;
    }
    const last = qs[qs.length - 1].n;
    if (c.n === last + 1) {
      qs.push(c);
    } else if (c.n > last && c.n <= last + 3) {
      // tolerate small skips (broken parsing of intervening question)
      qs.push(c);
    }
    // else: ignore (likely false match within passage text or far away)
  }

  // Stem-to-passage: lines BEFORE qs[0] are passage + section header.
  const firstQuestionIdx = qs.length ? qs[0].idx : all.length;
  let passageText = null;
  if (sectionKind === 'RC' || sectionKind === 'AR') {
    const beforeQ = all.slice(0, firstQuestionIdx);
    const filtered = beforeQ.filter(ln => {
      // Strip leading punctuation/asterisks/spaces so cover-page boilerplate matches even when prefixed.
      let t = ln.trim().replace(/^[\*•\s\x00-\x1f]+/, '').trim();
      if (!t) return false;
      if (t === '__PAGEBREAK__') return false;
      // Section directions
      if (/^Directions:/.test(t)) return false;
      if (/^the basis of what is stated/i.test(t)) return false;
      if (/^to choose the best answer/i.test(t)) return false;
      if (/^corresponding space on/i.test(t)) return false;
      if (/^in the passage\. For some/i.test(t)) return false;
      if (/^in the passage or pair of passages/i.test(t)) return false;
      if (/^that is, the response that/i.test(t)) return false;
      if (/^that most accurately and completely/i.test(t)) return false;
      if (/^The questions are to be/i.test(t)) return false;
      if (/^answered on the basis of/i.test(t)) return false;
      if (/^of the choices could conceivably/i.test(t)) return false;
      if (/^Each passage in this section/i.test(t)) return false;
      if (/^Each set of questions in this/i.test(t)) return false;
      if (/^The questions in this section/i.test(t)) return false;
      if (/^Time\s*[—–\-:]\s*\d+/i.test(t)) return false;
      if (/^\d+\s+Questions/i.test(t)) return false;
      if (/^SECTION\s+[IVX]+/i.test(t)) return false;
      // Cover-page TOC entries
      if (/^Reading Comprehension.*SECTION/i.test(t)) return false;
      if (/^Logical Reasoning.*SECTION/i.test(t)) return false;
      if (/^Analytical Reasoning.*SECTION/i.test(t)) return false;
      // Cover-page boilerplate
      if (/^PrepTest\s+\d+/i.test(t)) return false;
      if (/^Prep\s*Test\s+/i.test(t)) return false;
      if (/^Test ID:/i.test(t)) return false;
      if (/^TEST ID:/i.test(t)) return false;
      if (/^LSAT\s*$/i.test(t)) return false;
      if (/^Form\s+\dLSN/i.test(t)) return false;
      if (/Law School Admission Council/i.test(t)) return false;
      if (/©\s*\d{4}/i.test(t)) return false;
      if (/^A complete version of/i.test(t)) return false;
      if (/^All actual LSAT questions/i.test(t)) return false;
      if (/permission of Law School/i.test(t)) return false;
      if (/Newton, PA|Newtown, PA/i.test(t)) return false;
      if (/copyright owner|LSAC does not review/i.test(t)) return false;
      if (/^does not review or endorse/i.test(t)) return false;
      if (/^services, and inclusion of/i.test(t)) return false;
      if (/^work does not imply/i.test(t)) return false;
      if (/Kaplan Educational|Kaplan, Inc\.|©\s*Kaplan/i.test(t)) return false;
      if (/^All right reserved/i.test(t)) return false;
      if (/^All rights reserved/i.test(t)) return false;
      if (/photostat, microfilm/i.test(t)) return false;
      if (/^information retrieval system/i.test(t)) return false;
      if (/^permission of Kaplan/i.test(t)) return false;
      if (/^June\s+\d{4}\s*$/i.test(t)) return false;
      if (/^December\s+\d{4}\s*$/i.test(t)) return false;
      if (/^October\s+\d{4}\s*$/i.test(t)) return false;
      if (/^[A-Z][a-z]+\s+\d{4}\s*$/i.test(t)) return false;
      if (/^[A-Z][a-z]+\s+\d{4}\s*[-–—]\s*PrepTest/i.test(t)) return false;
      if (/^Printed in USA/i.test(t)) return false;
      if (/^LL\d{4}/i.test(t)) return false;
      if (/^Ö+LL\d/i.test(t)) return false;
      if (/^[\d\s\.\-]+\*?\s*$/.test(t) && t.length < 20) return false; // numeric junk
      if (/^Ackowledgment|^Acknowledgment/i.test(t)) return false;
      if (/^From .+©.+by/i.test(t)) return false;
      if (/^[A-Z]\s+[A-Z]\s+[A-Z]/.test(t) && t.length < 30) return false; // page chars like "A A A A"
      if (/^Time:\s+\d+\s+Minutes/i.test(t)) return false;
      if (/^[A-Z]+,\s+[A-Z][a-z]+\.\s+["“]/.test(t)) return false; // citation lines
      // Skip sub-page rambles from contents pages
      if (/^•/.test(t)) return false;
      if (/^THE PREPTEST/i.test(t)) return false;
      if (/^[▀-▟]/.test(t)) return false; // box-drawing chars
      return true;
    }).map(ln => ln.trim().replace(/^[\*•\s\x00-\x1f]+/, '').trim()).filter(Boolean);
    // pdftotext -raw drops the space after commas/periods that wrap a line in the source PDF
    // ("Wheatley,who" instead of "Wheatley, who"). Restore them — but never add spaces
    // before a digit (would break "1,000") or inside abbreviations like "U.S.".
    passageText = filtered.join('\n')
      .replace(/([a-z0-9])([,;:])([A-Za-z])/g, '$1$2 $3')
      .replace(/([a-z])\.([A-Z][a-z])/g, '$1. $2')
      .replace(/(\w)([—–])(\w)/g, '$1$2 $3')
      .trim();
    // Reflow into a single paragraph stream — pdftotext -raw breaks inside sentences
    // because of the original 2-column layout. Then heuristically split into paragraphs:
    // a sentence-end (.!?) followed by a capital that starts a new line is likely a
    // paragraph break. This is imperfect but produces readable rendering.
    const flowed = passageText.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    // Split on `. ` then re-join into paragraphs of ~3-5 sentences each.
    const sentences = flowed.match(/[^.!?]+[.!?]+["'”’\)]?\s*/g) || [flowed];
    const paragraphs = [];
    let buf = [];
    for (const s of sentences) {
      buf.push(s.trim());
      if (buf.join(' ').length > 350 && buf.length >= 3) {
        paragraphs.push(buf.join(' '));
        buf = [];
      }
    }
    if (buf.length) paragraphs.push(buf.join(' '));
    passageText = paragraphs.filter(Boolean).join('\n\n');
  }

  // Parse each question. For RC, also collect "tail prose" — text after (E) that
  // is the start of the next passage, terminated by a __PAGEBREAK__ sentinel.
  const questions = [];
  // passages[] is the section-level output. Initialize with passage 0 = the
  // pre-Q1 passage we already extracted.
  const passages = [];
  if (sectionKind === 'RC' && passageText) {
    passages.push({ firstQuestion: 1, text: passageText });
  }

  for (let qi = 0; qi < qs.length; qi++) {
    const start = qs[qi].idx;
    const end = qi + 1 < qs.length ? qs[qi + 1].idx : all.length;
    const qLines = all.slice(start, end);

    const firstMatch = qLines[0].match(/^(\d{1,2})\.\s+(.+)/);
    if (!firstMatch) continue;
    const number = parseInt(firstMatch[1], 10);
    const stemAndChoices = qLines.slice();
    stemAndChoices[0] = firstMatch[2];

    let choiceStartIdx = -1;
    for (let j = 0; j < stemAndChoices.length; j++) {
      if (/^\(A\)/.test(stemAndChoices[j].trim())) { choiceStartIdx = j; break; }
    }
    if (choiceStartIdx === -1) continue;

    const stem = stemAndChoices.slice(0, choiceStartIdx).join(' ').replace(/\s+/g, ' ').trim();

    const choices = [];
    let curLetter = null;
    let curText = [];
    const flush = () => {
      if (curLetter) choices.push({ label: curLetter, text: curText.join(' ').replace(/\s+/g, ' ').trim() });
      curLetter = null; curText = [];
    };

    // Tail-prose detection state (RC sections only).
    const tailLines = [];
    let inTail = false;
    let sawPageBreakAfterE = false;

    for (let j = choiceStartIdx; j < stemAndChoices.length; j++) {
      const ln = stemAndChoices[j].trim();
      if (ln === '__PAGEBREAK__') {
        if (curLetter === 'E') sawPageBreakAfterE = true;
        continue;
      }
      if (!ln) continue;
      if (/^STOP/.test(ln)) break;

      if (inTail) {
        tailLines.push(ln);
        continue;
      }

      const cm = ln.match(/^\(([A-E])\)\s*(.*)/);
      if (cm) {
        flush();
        curLetter = cm[1];
        if (cm[2]) curText.push(cm[2]);
        sawPageBreakAfterE = false;
        continue;
      }

      // RC tail detection: after (E) has accumulated meaningful text AND we
      // crossed a page break, the next prose line starts a new passage.
      if (
        sectionKind === 'RC' &&
        curLetter === 'E' &&
        curText.length > 0 &&
        sawPageBreakAfterE &&
        /^[A-Z]/.test(ln)
      ) {
        inTail = true;
        tailLines.push(ln);
        continue;
      }

      if (curLetter) curText.push(ln);
    }
    flush();

    if (choices.length >= 2) {
      questions.push({
        number,
        stem: restoreSpacing(stem),
        choices: choices.map(c => ({ ...c, text: restoreSpacing(c.text) })),
      });
    }

    // If the tail captured a substantive prose block, register it as the next
    // passage starting at the next question.
    if (sectionKind === 'RC' && tailLines.length) {
      const nextQ = qs[qi + 1]?.n;
      if (nextQ) {
        // Drop section-directions noise that occasionally leaks into the tail.
        const cleanedTail = tailLines.filter(t => {
          if (/^Directions:/i.test(t)) return false;
          if (/^the basis of what is stated/i.test(t)) return false;
          if (/^to choose the best answer/i.test(t)) return false;
          if (/^corresponding space on/i.test(t)) return false;
          if (/^in the passage\. For some/i.test(t)) return false;
          if (/^in the passage or pair of passages/i.test(t)) return false;
          if (/^that is, the response that/i.test(t)) return false;
          if (/^that most accurately and completely/i.test(t)) return false;
          if (/^The questions are to be/i.test(t)) return false;
          if (/^answered on the basis of/i.test(t)) return false;
          if (/^of the choices could conceivably/i.test(t)) return false;
          if (/^Each passage in this section/i.test(t)) return false;
          if (/^Each set of questions in this/i.test(t)) return false;
          if (/^The questions in this section/i.test(t)) return false;
          if (/^Time\s*[—–\-:]\s*\d+/i.test(t)) return false;
          if (/^\d+\s+Questions/i.test(t)) return false;
          if (/^SECTION\s+[IVX]+/i.test(t)) return false;
          return true;
        });
        const tailText = reflowPassage(cleanedTail.join('\n'));
        if (tailText.length > 300) {
          passages.push({ firstQuestion: nextQ, text: tailText });
        }
      }
    }
  }

  return { passage: passageText, passages, questions };
}

// Reflow a multi-line raw passage chunk into clean paragraphs (used for tail prose
// captured between RC questions, which we initially see as one line per source row).
function reflowPassage(raw) {
  if (!raw) return '';
  const restored = raw
    .replace(/([a-z0-9])([,;:])([A-Za-z])/g, '$1$2 $3')
    .replace(/([a-z])\.([A-Z][a-z])/g, '$1. $2')
    .replace(/(\w)([—–])(\w)/g, '$1$2 $3')
    .trim();
  const flowed = restored.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  const sentences = flowed.match(/[^.!?]+[.!?]+["'”’\)]?\s*/g) || [flowed];
  const paragraphs = [];
  let buf = [];
  for (const s of sentences) {
    buf.push(s.trim());
    if (buf.join(' ').length > 350 && buf.length >= 3) {
      paragraphs.push(buf.join(' '));
      buf = [];
    }
  }
  if (buf.length) paragraphs.push(buf.join(' '));
  return paragraphs.filter(Boolean).join('\n\n');
}

function restoreSpacing(s) {
  if (!s) return s;
  return s
    .replace(/([a-z0-9])([,;:])([A-Za-z])/g, '$1$2 $3')
    .replace(/([a-z])\.([A-Z][a-z])/g, '$1. $2')
    .replace(/(\w)([—–])(\w)/g, '$1$2 $3');
}

// ---------- 6. Parse answer key ----------
function parseAnswerKey(testLines) {
  const answerLines = [];
  for (let i = 0; i < testLines.length; i++) {
    // accept "1. C" and also "1. c" (some keys are lowercase due to OCR-like noise)
    const m = testLines[i].match(/^(\d{1,2})\.\s+([A-Ea-e])\s*$/);
    if (m) answerLines.push({ idx: i, n: parseInt(m[1], 10), letter: m[2].toUpperCase() });
  }
  if (!answerLines.length) return null;

  // Find dense blocks (gap <= 3 lines)
  const candidates = [];
  let cur = [];
  let prev = -1;
  for (const al of answerLines) {
    if (cur.length === 0 || al.idx - prev <= 4) {
      cur.push(al);
    } else {
      if (cur.length >= 5) candidates.push(cur);
      cur = [al];
    }
    prev = al.idx;
  }
  if (cur.length >= 5) candidates.push(cur);
  if (!candidates.length) return null;

  // Pick the largest block (likely the answer key)
  candidates.sort((a, b) => b.length - a.length);
  const block = candidates[0];

  // Split block into groups whenever the next number isn't (prev + 1)
  const rawGroups = [];
  let curG = [];
  for (const al of block) {
    if (curG.length && al.n !== curG[curG.length - 1].n + 1) {
      rawGroups.push(curG);
      curG = [];
    }
    curG.push(al);
  }
  if (curG.length) rawGroups.push(curG);

  // PDF answer-key layout: 4 sections × N columns, read column-major.
  // Sequence: S1col0, S2col0, S3col0, S4col0, S1col1, S2col1, S3col1, S4col1, ...
  // Within S(k)col(c) → S(k+1)col(c) the question numbers reset (e.g. 7→1) — clean split.
  // BUT S4col(c) → S1col(c+1) is consecutive (e.g. 7→8) so two groups get merged.
  // Fix: split any oversized group on a fixed columnSize boundary (typically 7 per col).
  const COL_SIZE = 7;
  const groups = [];
  for (const g of rawGroups) {
    if (g.length <= COL_SIZE + 1) {
      groups.push(g);
      continue;
    }
    for (let s = 0; s < g.length; s += COL_SIZE) {
      groups.push(g.slice(s, s + COL_SIZE));
    }
  }

  const tryAssign = (sectionCount) => {
    if (groups.length % sectionCount !== 0) return null;
    const numCols = Math.floor(groups.length / sectionCount);
    const key = {};
    for (let s = 0; s < sectionCount; s++) {
      const roman = ['I', 'II', 'III', 'IV', 'V'][s];
      const merged = {};
      for (let c = 0; c < numCols; c++) {
        const grp = groups[c * sectionCount + s];
        if (!grp) continue;
        for (const al of grp) merged[al.n] = al.letter;
      }
      key[roman] = merged;
    }
    return key;
  };

  return tryAssign(4) || tryAssign(3) || tryAssign(5);
}

// ---------- Main ----------
const out = { tests: [] };
const skipped = [];

for (let ti = 0; ti < tests.length; ti++) {
  const t = tests[ti];
  const tLines = lines.slice(t.startLine, t.endLine);
  try {
    const sectionTypes = findSectionTypes(tLines);
    const stopIdxs = findSections(tLines);
    const answerKey = parseAnswerKey(tLines);

    if (stopIdxs.length < 3) {
      skipped.push({ num: t.num, reason: `only ${stopIdxs.length} STOP markers` });
      continue;
    }
    // Answer key is optional — if missing, questions are still extracted but
    // attempts will save without correctness scoring (correct stays null).

    // Build section regions: section i = (prevStop+1 OR contentStart, currentStop)
    // contentStart = first line after cover-page TOC. Heuristic: first line that has substantial content
    // and is not part of cover/TOC — easier: just use 0 (test start).
    // The first section's content starts AFTER the TOC. Find a clear marker for content start.
    // Look for the first "SECTION I" + "Time-35 minutes" + Q count block, then content begins after it.
    // OR: look for the first numbered question "1. ..." in the test.
    // Simpler: just slice from line 0 — passage filtering will remove the TOC.

    const sectionEnds = stopIdxs.slice(0, 4); // take first 4 STOPs (sections)
    const sectionRegions = [];
    let prevEnd = 0;
    for (let si = 0; si < sectionEnds.length; si++) {
      sectionRegions.push({ start: prevEnd, end: sectionEnds[si] });
      prevEnd = sectionEnds[si] + 1;
    }

    const sections = [];
    for (let si = 0; si < sectionRegions.length; si++) {
      const r = sectionRegions[si];
      const secLines = tLines.slice(r.start, r.end);
      const roman = ['I', 'II', 'III', 'IV'][si];

      // Determine kind: prefer cover-TOC mapping; fall back to header detection
      let kind = sectionTypes[roman] || detectSectionKindFromHeader(secLines);
      if (!kind) {
        // fallback: try to infer from question count or content
        kind = 'LR'; // assume LR if unknown
      }

      // We only want RC and LR
      if (kind !== 'RC' && kind !== 'LR') continue;

      const secText = secLines.join('\n');
      const parsed = parseSectionContent(secText, kind);
      const keys = (answerKey && answerKey[roman]) || {};
      const questionsWithKeys = parsed.questions.map(q => ({
        ...q,
        correct: keys[q.number] || null,
      }));

      sections.push({
        roman,
        kind,
        passage: parsed.passage,
        passages: parsed.passages || [],
        questions: questionsWithKeys,
      });
    }

    if (!sections.length) {
      skipped.push({ num: t.num, reason: 'no RC/LR sections after filtering' });
      continue;
    }

    // Only quality gate: drop tests where parsing produced zero questions
    // (e.g. tests 67-73 use a custom font that pdftotext can't decode).
    let totalQ = 0;
    for (const s of sections) totalQ += s.questions.length;
    if (totalQ === 0) {
      skipped.push({ num: t.num, reason: 'no questions parsed (likely garbled PDF font)' });
      continue;
    }
    // Keep ALL questions, including those without an answer key. The session UI
    // will save attempts unscored (correct/is_correct stay null) — still useful
    // for timed practice and review.
    out.tests.push({
      num: t.num,
      sectionTypes,
      sections,
    });
  } catch (e) {
    skipped.push({ num: t.num, reason: `parse error: ${e.message}` });
  }
}

let totalQ = 0, totalRC = 0, totalLR = 0, totalWithAnswer = 0;
for (const t of out.tests) {
  for (const s of t.sections) {
    totalQ += s.questions.length;
    if (s.kind === 'RC') totalRC += s.questions.length;
    if (s.kind === 'LR') totalLR += s.questions.length;
    totalWithAnswer += s.questions.filter(q => q.correct).length;
  }
}
console.log(`Parsed ${out.tests.length} tests, ${totalQ} questions (RC ${totalRC}, LR ${totalLR}), ${totalWithAnswer} with answer keys`);
console.log(`Skipped ${skipped.length} tests:`);
skipped.slice(0, 20).forEach(s => console.log(`  - PrepTest ${s.num}: ${s.reason}`));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
