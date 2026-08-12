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

// ---------- 4b. "Questions N–M" group headers ----------
// Both Logical Reasoning and Analytical Reasoning print shared material under a
// "Questions 15–16" header, with the stimulus BETWEEN the header and question N.
// The per-question slicer starts at the "N." line, so that material used to be
// dropped on the floor. Find the headers here so we can (a) re-attach the text
// and (b) tell Logic Games apart from ordinary LR.
const GROUP_HEADER = /^Questions\s+(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*$/;

function findGroupHeaders(allLines) {
  const headers = [];
  for (let i = 0; i < allLines.length; i++) {
    const m = allLines[i].trim().match(GROUP_HEADER);
    if (!m) continue;
    const from = parseInt(m[1], 10);
    const to = parseInt(m[2], 10);
    if (to <= from || to - from > 12) continue;
    headers.push({ idx: i, from, to });
  }
  return headers;
}

// Analytical Reasoning (Logic Games) is structurally unmistakable: the whole
// section is 3–4 groups of 4+ questions, each sharing one setup. Ordinary LR
// pairs at most 2 questions per stimulus, and only for a handful of items.
function looksLikeAnalyticalReasoning(headers, questionCount) {
  const games = headers.filter((h) => h.to - h.from + 1 >= 4);
  if (games.length < 2) return false;
  const covered = games.reduce((sum, h) => sum + (h.to - h.from + 1), 0);
  return questionCount > 0 && covered / questionCount > 0.6;
}

// ---------- 5. Parse questions in a section ----------
function parseSectionContent(sectionText, sectionKind) {
  // Step 1: Convert form-feed page-break chars FIRST so subsequent line-level
  // strips and our PAGEBREAK sentinel both line up properly.
  let cleaned = sectionText.replace(/\f/g, '\n__PAGEBREAK__\n');

  // Step 2: Strip page-noise lines that pdftotext emits between PDF pages.
  cleaned = cleaned
    .replace(/^GO ON TO THE NEXT PAGE\.?$/gm, '__PAGEBREAK__')
    // Page footer, with any number of repeated section-marker digits in front:
    // "-11-", "1 -11-", "1 1 -11-".
    .replace(/^\s*(?:\d+\s+)*\d*\s*-\d+-\s*$/gm, '')
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
  // The `(?<!\d)` guard keeps decimals intact: "barite, a very heavy mineral of
  // density 4.3 to 4.6. It is also used…" must NOT be cut into a bogus "6. It is
  // also used…" question start, which swallowed a whole RC passage into PT54 SI Q6.
  cleaned = cleaned.replace(/(?<!\d)([a-z.)])\s*(\d{1,2}\.\s+[A-Z])/g, '$1\n$2');

  // Pre-process: split lines where a question-start is concatenated to a footer or end-of-prior-question text.
  // e.g. "A A A A A -16- 19. It is unlikely..." -> "-16-" and "19. It is unlikely..."
  cleaned = cleaned.replace(/(-\d+-)\s*(\d{1,2}\.\s+[A-Z])/g, '$1\n$2');

  // Pre-process: drop the section-number page marker that pdftotext sometimes
  // glues to the front of a question line — "1 7. In 1955, legislation…". The
  // `^N.` detector below would miss it, and the question would be swallowed into
  // its predecessor (this cost PT55 SI seven questions). The trailing space in
  // `\d\s+` is what keeps a real "10." from matching.
  cleaned = cleaned.replace(/^(?:\d\s+)+(\d{1,2}\.\s+[A-Z])/gm, '$1');

  // Pre-process: split TOC lines that are concatenated with passage start.
  // e.g. "Logical Reasoning . . . SECTION IVFor the poet..." -> separate lines.
  cleaned = cleaned.replace(/(SECTION\s+(?:I{1,3}V?|IV|V))\s*([A-Z][a-z])/g, '$1\n$2');

  const all = cleaned.split('\n');

  // Find question-start lines: "N. text..."
  // Each line can have more than one plausible reading, because pdftotext glues
  // the per-page section marker onto the number with no space: "115. Zack's
  // Coffeehouse…" is marker 1 + question 15, not question 115. We offer both
  // readings and let the sequencer below keep whichever continues the run.
  const candidates = [];
  for (let i = 0; i < all.length; i++) {
    const m = all[i].match(/^(\d{1,3})\.\s+(.+)/);
    if (!m) continue;
    // Sanity check: rest of line should look like a question stem (not just "C" or "B" alone)
    const rest = m[2].trim();
    if (rest.length < 5) continue;
    // Reject lines like "1. C" or "1. B" (those are answer-key lines)
    if (/^[A-E]\s*$/.test(rest)) continue;
    const digits = m[1];
    const readings = [];
    const asIs = parseInt(digits, 10);
    if (asIs >= 1 && asIs <= 35) readings.push({ n: asIs, strip: 0 });
    if (digits.length >= 2) {
      const stripped = parseInt(digits.slice(1), 10);
      // A stripped reading must be a plausible section marker (1–4) up front.
      if (stripped >= 1 && stripped <= 35 && Number(digits[0]) >= 1 && Number(digits[0]) <= 4) {
        readings.push({ n: stripped, strip: 1 });
      }
    }
    if (readings.length) candidates.push({ idx: i, readings });
  }

  // Greedily build a monotonically-increasing question sequence starting at 1
  const qs = [];
  for (const c of candidates) {
    const last = qs.length ? qs[qs.length - 1].n : 0;
    // Prefer the reading that continues the run exactly; fall back to a small
    // forward skip (a question whose own line we failed to parse).
    const pick = c.readings.find((r) => r.n === last + 1)
      || (qs.length ? c.readings.find((r) => r.n > last && r.n <= last + 3) : null);
    if (pick) {
      qs.push({ idx: c.idx, n: pick.n, strip: pick.strip });
    }
    // else: ignore (likely false match within passage text or far away)
  }

  // Shared stimuli. A "Questions N–M" header is followed by material that
  // belongs to every question in [N, M] but physically sits above question N's
  // number line — so slice it out here and hand it to each of them.
  const groupHeaders = findGroupHeaders(all);
  const qIdxByNumber = new Map(qs.map((q) => [q.n, q.idx]));
  const sharedStimulus = new Map();
  for (const h of groupHeaders) {
    const stopAt = qIdxByNumber.get(h.from);
    if (stopAt == null || stopAt <= h.idx) continue;
    const body = all
      .slice(h.idx + 1, stopAt)
      .map((ln) => ln.trim())
      .filter((ln) => ln && ln !== '__PAGEBREAK__' && !/^STOP/.test(ln) && !/^\(?[A-E]\)?\s*$/.test(ln))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (body.length < 40) continue;
    for (let n = h.from; n <= h.to; n++) sharedStimulus.set(n, restoreSpacing(body));
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

    // Drop the glued section marker before reading the question number.
    if (qs[qi].strip) qLines[0] = qLines[0].slice(qs[qi].strip);
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
      // Re-attach the group's shared stimulus ahead of this question's own text.
      // RC keeps its stimulus in the passage pane, so it is exempt.
      const shared = sectionKind === 'RC' ? null : sharedStimulus.get(number);
      const fullStem = shared ? `${shared} ${restoreSpacing(stem)}`.trim() : restoreSpacing(stem);
      questions.push({
        number,
        stem: fullStem,
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

  return { passage: passageText, passages, questions, groupHeaders };
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
    .replace(/(\w)([—–])(\w)/g, '$1$2 $3')
    // A page footer that pdftotext ran onto the end of the last line rather than
    // emitting standalone, so the line-level strippers above never saw it:
    // "… examiners -5- 1", "… assumptions 1 --0-", "… paper will decrease. [] -3- 1".
    .replace(/\s*(?:\[\s*\]\s*)?(?:\d+\s+)?-{1,2}\d{1,3}-{1,2}(?:\s+\d+)?\s*$/, '')
    .trim();
}

// ---------- 6. Parse answer key ----------
// The PDF prints answer keys in TWO different layouts, and assuming the first
// one silently mis-assigns every key in the second (see the `contiguous` branch
// below). Both are detected from the shape of the number runs:
//
//   banded (PT1–59)      7,7,7,14,7,7,14,…   bands of 7 read column-major across
//                                            the four sections
//   contiguous (PT60–66) 27,25,23,26         each section's key printed whole,
//                                            one after another, usually under a
//                                            "Section II" header
const ROMANS = ['I', 'II', 'III', 'IV', 'V'];

// `counts` (optional) maps roman -> question count for EVERY section of the test,
// including Analytical Reasoning sections we later discard — they still occupy a
// slot in the printed key, so leaving them out would shift everything after them.
function parseAnswerKey(testLines, counts) {
  const answerLines = [];
  const sectionHeaders = [];
  for (let i = 0; i < testLines.length; i++) {
    // accept "1. C" and also "1. c" (some keys are lowercase due to OCR-like noise)
    const m = testLines[i].match(/^(\d{1,2})\.\s+([A-Ea-e])\s*$/);
    if (m) answerLines.push({ idx: i, n: parseInt(m[1], 10), letter: m[2].toUpperCase() });
    // "9. *" — "Item removed from scoring". It has no letter but it DOES occupy a
    // slot in the printed key, so it has to be kept or every later key in the
    // section shifts up by one.
    const v = testLines[i].match(/^(\d{1,2})\.\s+\*\s*$/);
    if (v) answerLines.push({ idx: i, n: parseInt(v[1], 10), letter: null });
    // "SECTION III" / "Section III" on its own line. The scoring worksheet's
    // "SECTION I . . . . ." never matches because of the trailing dots.
    const h = testLines[i].trim().match(/^SECTION\s+(I{1,3}V?|IV|V)\s*$/i);
    if (h) sectionHeaders.push({ idx: i, roman: h[1].toUpperCase() });
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

  // ---- Layout A: contiguous, one whole section per run (PT60–66) ----
  // A run as long as a whole section (>=19) can only be a full section key, never
  // a band of 7. Feeding these to the banded logic below shreds them and assigns
  // section IV's letters to section I — the keys come out WRONG, not just sparse.
  if (rawGroups.filter((g) => g.length >= 19).length >= 3) {
    // Re-join fragments: a new section begins only where the numbering restarts
    // at 1. (PT60 section I breaks at its void "19. *" entry.)
    const perSection = [];
    for (const g of rawGroups) {
      if (!perSection.length || g[0].n === 1) perSection.push([...g]);
      else perSection[perSection.length - 1].push(...g);
    }
    const key = {};
    perSection.forEach((entries, i) => {
      // Prefer an explicit "Section N" header immediately above the run; fall
      // back to position, which matches on the tests that print no headers.
      const header = sectionHeaders.filter((h) => h.idx < entries[0].idx && entries[0].idx - h.idx <= 3).pop();
      const roman = header ? header.roman : ROMANS[i];
      if (!roman) return;
      const merged = {};
      for (const al of entries) if (al.letter) merged[al.n] = al.letter;
      key[roman] = merged;
    });
    return key;
  }

  // ---- Layout B: banded, 4 sections × N columns, read column-major ----
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

  // Exact banded assignment, when we know how many questions each section has.
  // The printed order is fully determined: band 0 = section I's Q1–7, section
  // II's Q1–7, …; band 1 = each section's Q8–14; and so on, with the final band
  // ragged because sections differ in length. Generating that expected number
  // sequence and zipping it against the block is self-checking — if the lengths
  // disagree we learned nothing and fall through to the old heuristic.
  const assignBandedExact = () => {
    if (!counts) return null;
    const romans = ROMANS.filter((r) => counts[r] > 0);
    if (romans.length < 3) return null;
    const bandSize = rawGroups[0] ? rawGroups[0].length : 7;
    if (bandSize < 5 || bandSize > 10) return null;
    const maxQ = Math.max(...romans.map((r) => counts[r]));
    const expected = [];
    for (let start = 1; start <= maxQ; start += bandSize) {
      for (const r of romans) {
        for (let n = start; n < start + bandSize && n <= counts[r]; n++) expected.push({ roman: r, n });
      }
    }
    if (expected.length !== block.length) return null;
    // Every printed number must land on the number the layout predicts.
    for (let i = 0; i < expected.length; i++) if (expected[i].n !== block[i].n) return null;
    const key = {};
    for (const r of romans) key[r] = {};
    expected.forEach((e, i) => { if (block[i].letter) key[e.roman][e.n] = block[i].letter; });
    return key;
  };
  const exact = assignBandedExact();
  if (exact) return exact;

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
        for (const al of grp) if (al.letter) merged[al.n] = al.letter;
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
const droppedAr = [];

for (let ti = 0; ti < tests.length; ti++) {
  const t = tests[ti];
  const tLines = lines.slice(t.startLine, t.endLine);
  try {
    const sectionTypes = findSectionTypes(tLines);
    const stopIdxs = findSections(tLines);

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

    // Pass 1: parse every section, INCLUDING Analytical Reasoning. AR sections are
    // discarded from the output but still occupy a slot in the printed answer key,
    // so the key parser needs their question counts to align the banded layout.
    const parsedSections = [];
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
      if (kind !== 'RC' && kind !== 'LR' && kind !== 'AR') continue;

      const parsed = parseSectionContent(secLines.join('\n'), kind);

      // Analytical Reasoning (Logic Games) sections have no cover-page TOC entry
      // in some printings, so they used to fall through the `kind = 'LR'` default
      // and pollute the LR pool. Catch them structurally: games left the LSAT in
      // 2024 and have no GMAT analogue, so they are dropped below — after their
      // question count has been handed to the key parser.
      if (kind === 'LR' && looksLikeAnalyticalReasoning(parsed.groupHeaders || [], parsed.questions.length)) {
        kind = 'AR';
      }
      parsedSections.push({ roman, kind, parsed });
    }

    const counts = {};
    for (const ps of parsedSections) counts[ps.roman] = ps.parsed.questions.length;
    const answerKey = parseAnswerKey(tLines, counts);

    // Pass 2: attach keys and drop the AR sections.
    const sections = [];
    for (const { roman, kind, parsed } of parsedSections) {
      if (kind === 'AR') {
        droppedAr.push(`PT${t.num} S${roman} (${parsed.questions.length} Qs)`);
        continue;
      }
      const keys = (answerKey && answerKey[roman]) || {};
      sections.push({
        roman,
        kind,
        passage: parsed.passage,
        passages: parsed.passages || [],
        questions: parsed.questions.map((q) => ({ ...q, correct: keys[q.number] || null })),
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
if (droppedAr.length) {
  console.log(`Dropped ${droppedAr.length} Analytical Reasoning (Logic Games) sections: ${droppedAr.join(', ')}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
