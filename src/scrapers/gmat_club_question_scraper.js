(function () {
  'use strict';

  // GMAT Club Phase-2 enrichment — runs in the browser via CDP. The Node-side
  // runner navigates the same tab to each question URL one at a time; this
  // module exposes `window.gmatClubEnrichCurrentPage()` which extracts the
  // stem, answer choices, and revealed official-answer letter from the
  // currently-loaded topic page.
  //
  // Page DOM (verified 2026-04-26 on https://gmatclub.com/forum/topic*.html):
  //   - The OP body is the FIRST `.item.text` in document order. Replies
  //     appear as later `.item.text` siblings.
  //   - Choice labels are inline in the OP body separated by `<br>`, e.g.
  //     "A. 27 : 14<br>B. 27 : 13<br>...". textContent collapses the breaks,
  //     so we read innerHTML and convert `<br>` to newlines before parsing.
  //   - The official answer hides inside a `.spoiler` block; its visible
  //     text after "Show Spoiler" reveals the OA (e.g. "6/16 = 3/8 = A").
  //   - The page title is `.topic-title-inner h1`.
  //
  // Two DOM traps live inside the OP body and both corrupt what we read
  // (verified 2026-08-31 by CDP probe):
  //
  //   1. MATH IS RENDERED THREE TIMES. GMAT Club runs MathJax v2 CHTML, so a
  //      single `[m]\frac{20^2}{9^4}[/m]` expands to
  //        <span class="MathJax_Preview">…20294…</span>
  //        <span id="MathJax-Element-1-Frame" class="mjx-chtml MathJax_CHTML"
  //              data-mathml="<math …>">…20294…<span class="MJX_Assistive_MathML">
  //              …20294…</span></span>
  //        <script type="math/tex" id="MathJax-Element-1">\frac{20^2}{9^4}</script>
  //      Flattening tags kept ALL of them, producing "20294\frac{20^2}{9^4}" (and
  //      a third copy once CHTML finished rendering). `normalizeMathInPlace`
  //      collapses each group to ONE readable string by feeding the frame's
  //      `data-mathml` through the shared `mathmlToText` (injected by the runner
  //      as `window.__mathText`), falling back to the LaTeX source when MathJax
  //      has not rendered yet.
  //
  //   2. THE OP BODY DOES NOT END AT THE QUESTION. After the choices come, in
  //      order: `.spoiler` blocks (OA + community discussion), the answer widget
  //      `.item.twoRowsBlock` (whose hidden text reads "ShowHide Answer Official
  //      Answer B" — i.e. the KEY), a promo CTA div, and `.post_signature`.
  //      Questions WITHOUT lettered choices (every Data Sufficiency topic) have
  //      no "A." line to cut the stem at, so all of that landed in the stem and
  //      leaked the answer. `cleanOpClone` cuts the body at the answer widget and
  //      drops the spoilers/signature before anything is parsed.

  const CHOICE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

  // Data Sufficiency topics never print answer choices — on the real GMAT the
  // five DS options are fixed boilerplate, so GMAT Club omits them. Without
  // them the stored row is a stem plus a bare letter key, which the dashboard
  // and the practice-set resolver both treat as ungradeable. Supply the
  // standard set (only when the page really gave us none).
  const DS_CHOICES = [
    ['A', 'Statement (1) ALONE is sufficient, but statement (2) alone is not sufficient.'],
    ['B', 'Statement (2) ALONE is sufficient, but statement (1) alone is not sufficient.'],
    ['C', 'BOTH statements TOGETHER are sufficient, but NEITHER statement ALONE is sufficient.'],
    ['D', 'EACH statement ALONE is sufficient.'],
    ['E', 'Statements (1) and (2) TOGETHER are NOT sufficient.'],
  ].map(([label, text]) => ({ label, text }));

  // Last-resort LaTeX -> inline text, used only when MathJax has not produced a
  // `data-mathml` twin yet. The rendered path (mathmlToText) is far better.
  const LATEX_SYMBOLS = {
    times: '\u00d7', cdot: '\u00b7', ast: '*', div: '\u00f7', pm: '\u00b1',
    le: '\u2264', leq: '\u2264', ge: '\u2265', geq: '\u2265', ne: '\u2260', neq: '\u2260',
    pi: '\u03c0', ldots: '\u2026', dots: '\u2026', infty: '\u221e', approx: '\u2248',
  };

  function latexToText(src) {
    let s = String(src || '');
    s = s.replace(/\\(?:left|right|displaystyle|big|Big|,|;|!|\s)/g, ' ');
    // Innermost-first rewrite; repeat until stable so nested \frac collapses too.
    for (let i = 0; i < 8; i += 1) {
      const next = s
        .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)')
        .replace(/\\sqrt\s*\{([^{}]*)\}/g, '\u221a($1)')
        .replace(/\^\s*\{([^{}]*)\}/g, '^($1)')
        .replace(/_\s*\{([^{}]*)\}/g, '_($1)');
      if (next === s) break;
      s = next;
    }
    s = s.replace(/\\([a-zA-Z]+)/g, (m, name) => (
      Object.prototype.hasOwnProperty.call(LATEX_SYMBOLS, name) ? LATEX_SYMBOLS[name] : name
    ));
    return s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  }

  // Collapse every MathJax rendering of one expression down to a single text
  // node. Mutates the live document (we navigate away right after) so that both
  // the innerHTML path (single questions) and the innerText path (RC) see the
  // same, de-duplicated text. See trap 1 in the header comment.
  function normalizeMathInPlace(root) {
    const convert = window.__mathText && window.__mathText.mathmlToText;
    const mathmlById = new Map();
    for (const frame of root.querySelectorAll('[data-mathml][id$="-Frame"]')) {
      mathmlById.set(frame.id.slice(0, -'-Frame'.length), frame.getAttribute('data-mathml'));
    }
    for (const el of root.querySelectorAll(
      '.MathJax_Preview, .MJX_Assistive_MathML, .mjx-chtml, .MathJax_CHTML, .MathJax, .MathJax_Display'
    )) el.remove();
    for (const script of Array.from(root.querySelectorAll('script[type^="math/tex"]'))) {
      const mathml = script.id ? mathmlById.get(script.id) : null;
      const text = (mathml && convert) ? convert(mathml) : latexToText(script.textContent);
      script.replaceWith(document.createTextNode(` ${text} `));
    }
  }

  // Remove `node` and everything that follows it in document order, walking up
  // to (but not including) `root`.
  function cutFrom(root, node) {
    let cur = node;
    while (cur && cur !== root && cur.parentNode) {
      const parent = cur.parentNode;
      while (cur.nextSibling) parent.removeChild(cur.nextSibling);
      parent.removeChild(cur);
      cur = parent;
    }
  }

  // A detached copy of the OP body holding ONLY question content. See trap 2.
  function cleanOpClone(opBody) {
    const clone = opBody.cloneNode(true);
    // `table.stoker.di` is the DI answer grid (Yes/No, Contradicts/Does not, …).
    // Everything from it on is answer UI — the grid itself, the Submit button
    // and its "Start the Timer above…" hint, then the answer widget. Cutting at
    // whichever comes first keeps all of it out of the stem; the grid's own
    // content is read separately by extractDiGrid() straight off the live DOM.
    const answerWidget = clone.querySelector(
      'table.stoker.di, .timer_di_submit_button_wrapper, .item.twoRowsBlock, .correctAnswerBlock'
    );
    if (answerWidget) cutFrom(clone, answerWidget);
    for (const el of clone.querySelectorAll(
      '.spoiler, .spoiler-hidden, .spoilerWrap, .post_signature, .signature, script, style'
    )) el.remove();
    // GMAT Club's "Butler" daily-question project appends a fixed banner and a
    // note to tutors inside the post body itself, in an unclassed bordered div
    // and an italic span — no selector to hang off, so match the template text.
    // The length cap keeps a stray match from taking the question with it.
    for (const el of Array.from(clone.querySelectorAll('div, span, p, blockquote'))) {
      if (!el.parentNode) continue; // already removed along with an ancestor
      const text = (el.textContent || '').trim();
      if (!text || text.length > 1200) continue;
      if (/Butler (?:Question|Project)/i.test(text)
        || /^Gentle note to all experts and tutors/i.test(text)) el.remove();
    }
    return clone;
  }

  // Zero-width spaces and soft hyphens are all over GMAT Club posts (they come
  // from pasted Word/PDF content) and survive .trim(), so labels like "a. One\u200b"
  // never compare equal to what the parser expects.
  function stripInvisible(text) {
    return String(text || '').replace(/[\u200b-\u200d\u00ad\ufeff]/g, '');
  }

  function tidyInline(text) {
    return stripInvisible(text)
      // The `_________________` rule GMAT Club prints above a post signature is
      // a bare text node, so element removal alone cannot catch it.
      .replace(/_{4,}/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
  }

  function htmlToLines(htmlSnippet) {
    // The runner injects src/scrapers/mathml-text.js as `window.__mathText`;
    // its htmlToReadableText is the same converter StartTest uses (handles
    // <math>, <br>, block tags and the full entity table). Fall back to the
    // local flattener only if the injection failed.
    const shared = window.__mathText && window.__mathText.htmlToReadableText;
    if (shared) return stripInvisible(shared(String(htmlSnippet || '')));
    // Normalize <br> and block boundaries to newlines, then strip remaining tags.
    const withBreaks = String(htmlSnippet || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    // Decode common HTML entities that appear inside content.
    const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
    return stripInvisible(withBreaks.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => entities[m] || m));
  }

  function findOpBody() {
    // The OP is the FIRST `.item.text` in document order.
    return document.querySelector('.item.text');
  }

  function extractChoicesFromList(opBody) {
    // GMAT Club occasionally renders choices as <ol type="A"> or similar.
    const ol = opBody.querySelector('ol');
    if (!ol) return null;
    const items = Array.from(ol.querySelectorAll(':scope > li'));
    if (items.length < 2 || items.length > 7) return null;
    return items.map((li, idx) => ({
      label: CHOICE_LABELS[idx] || String(idx + 1),
      text: tidyInline(li.textContent).replace(/\n/g, ' '),
    }));
  }

  function extractChoicesFromLines(linesText) {
    // Look for lines starting with "A." / "A)" / "(A)" — find each label
    // anchor, then take the text up to the next anchor or blank line.
    const lines = String(linesText || '').split(/\n/).map((l) => l.trim());
    const choices = [];
    let current = null;
    let lastLabelIdx = -1;
    // Labels are lowercase on plenty of posts ("a. One / b. Two"). Punctuation
    // after the letter is REQUIRED here, and the sequence check below rejects
    // anything out of order, so accepting lowercase cannot swallow a sentence
    // that merely starts with "a".
    const labelRe = /^\(?([A-Fa-f])\)?\s*[\.\)]\s*(.*)$/;
    for (const line of lines) {
      if (!line) {
        if (current) { choices.push(current); current = null; }
        continue;
      }
      const m = line.match(labelRe);
      const label = m ? m[1].toUpperCase() : null;
      const labelIdx = label ? CHOICE_LABELS.indexOf(label) : -1;
      // Only treat as a new choice if the label is the next one in sequence
      // (avoids false positives inside math expressions).
      if (m && labelIdx === lastLabelIdx + 1 && labelIdx < CHOICE_LABELS.length) {
        if (current) choices.push(current);
        current = { label, text: m[2].trim() };
        lastLabelIdx = labelIdx;
      } else if (current) {
        current.text = (current.text + ' ' + line).trim();
      }
    }
    if (current) choices.push(current);
    return choices;
  }

  // Some posters put the whole answer list on ONE line, and use a colon instead
  // of a period: "A: 30/121 B: 3/11 C: 1/2 D: 6/11 E: 3/5". The line-oriented
  // parser above sees a single line and returns nothing, so the choices used to
  // be swallowed by the stem. Requires a run of at least three sequential
  // labels starting at A, which is what keeps prose from matching.
  function extractChoicesFromInline(linesText) {
    const text = String(linesText || '').replace(/\s+/g, ' ').trim();
    const re = /(?:^|\s)\(?([A-Fa-f])\)?\s*[.):]\s+/g;
    const run = [];
    let m;
    while ((m = re.exec(text))) {
      const label = m[1].toUpperCase();
      if (CHOICE_LABELS.indexOf(label) !== run.length) continue;
      run.push({ label, start: m.index, end: re.lastIndex });
    }
    if (run.length < 3) return null;
    const choices = run.map((h, i) => ({
      label: h.label,
      text: text.slice(h.end, i + 1 < run.length ? run[i + 1].start : text.length).trim(),
    }));
    if (choices.some((c) => !c.text)) return null;
    return { choices, stem: tidyInline(text.slice(0, run[0].start)).replace(/\n+/g, ' ') };
  }

  function stemBeforeChoices(linesText) {
    // Cut the stem at the first "A." / "A)" / "(A)" line.
    const lines = String(linesText || '').split(/\n/);
    const cutAt = lines.findIndex((line) => /^\s*\(?[Aa]\)?\s*[\.\)]\s+/.test(line));
    const stemLines = cutAt === -1 ? lines : lines.slice(0, cutAt);
    return tidyInline(stemLines.join('\n')).replace(/\n+/g, ' ').trim();
  }

  // A DI data table (Graphs & Tables / Table Analysis) renders as GMAT Club's
  // own `table.stoker` — sortable, with a real thead. Flattening it to text
  // turns "Participants | Attempts | Probability" into
  // "ParticipantsAttemptsProbability 1100.2 2150.53 …", which is unreadable and
  // unusable. Lift it out of the clone as HTML (the dashboard already renders
  // `stimulus` through a sanitizer that allows table markup) and remove it so
  // the stem keeps only the prose. Scoped to `.stoker` on purpose: plenty of
  // posts use a bare <table> for layout, and pulling those would strip content
  // out of ordinary stems.
  // A Graphics Interpretation graph is an <img>, and its URL is no use to the
  // dashboard: GMAT Club's own attachment endpoint needs a signed-in session,
  // and the stimulus sanitizer keeps only `data:` images for that reason. The
  // picture therefore has to be inlined at scrape time.
  //
  // It cannot be inlined from here. A canvas draw works for GMAT Club's own
  // attachments (same origin) but throws on the many graphs served from
  // s3.amazonaws.com, which send no CORS header — `fetch` fails there too. So
  // each image is MARKED on the live DOM and the runner screenshots it through
  // Playwright, which no cross-origin rule applies to. Marking has to happen
  // before the clone is taken, since that is what carries the attribute over.
  function markStimulusImages(opBody) {
    let shot = 0;
    for (const img of Array.from(opBody.querySelectorAll('img'))) {
      // Forum smilies and rank badges are images too; anything this small is
      // decoration, not a figure.
      if (img.naturalWidth < 80 || img.naturalHeight < 80) continue;
      img.setAttribute('data-shot', String(shot));
      shot += 1;
    }
    return shot;
  }

  function extractStimulus(clone) {
    // Document order, so a graph above a table stays above it.
    const nodes = Array.from(clone.querySelectorAll('table.stoker, table[data-type="sortable"], img'));
    if (!nodes.length) return null;
    const parts = [];
    const imageSelectors = [];
    for (const node of nodes) {
      if (node.tagName === 'IMG') {
        const shot = node.getAttribute('data-shot');
        if (shot !== null) {
          parts.push(`<img data-shot="${shot}">`);
          imageSelectors.push(`img[data-shot="${shot}"]`);
        }
        node.remove();
        continue;
      }
      // Sort-arrow glyph spans are icon-font only and render as nothing here.
      for (const icon of node.querySelectorAll('span[class*="icon-svg"]')) icon.remove();
      parts.push(node.outerHTML);
      node.remove();
    }
    return parts.length ? { html: parts.join('\n'), imageSelectors } : null;
  }

  // Graphics Interpretation blanks are `select.di_graph_dropdown`. Store them
  // the way the StartTest dropdown path already stores and renders its own:
  // one `answer_choices` entry per blank carrying the menu it offered, and the
  // stem keeping each blank FLATTENED as a "Select..." marker followed by that
  // blank's options, which is what `buildDropdownStatement` reads to put the
  // sentence back together. GMAT Club spells the placeholder "Select", so the
  // marker is normalized on the way out rather than widening the shared parser.
  function extractGraphDropdowns(clone) {
    const selects = Array.from(clone.querySelectorAll('select.di_graph_dropdown'));
    if (!selects.length) return null;
    const blanks = [];
    selects.forEach((select, index) => {
      const options = Array.from(select.options)
        .map((option) => tidyInline(option.textContent).replace(/\n/g, ' '))
        .filter((text) => text && !/^select\.*$/i.test(text));
      if (!options.length) return;
      const run = document.createElement('div');
      ['Select...', ...options].forEach((line) => {
        const row = document.createElement('div');
        row.textContent = line;
        run.append(row);
      });
      // The select sits INLINE ("…the air temperature is <select>"), and the
      // flattener only breaks on a closing tag — without a leading break the
      // marker lands at the end of the prose line and isMarker (whole-line)
      // never sees it.
      select.replaceWith(document.createElement('br'), run);
      blanks.push({
        label: `Blank ${index + 1}`,
        text: '',                       // the page never restores the user's pick
        options: options.map((text) => ({ text })),
      });
    });
    return blanks.length === selects.length ? blanks : null;
  }

  // The official answer is already in the DOM, hidden by CSS rather than
  // fetched on click: `#di_oa_spoiler .downRow.di` reads
  // "Dropdown 1: Positive Dropdown 2: less than". Stored as the option TEXTS
  // joined with a comma, which is the dropdown convention (and why
  // splitDropdownAnswers consumes it against the option lists).
  function parseGraphAnswerKey(text, blanks) {
    if (!Array.isArray(blanks) || !blanks.length) return null;
    // The blanks run together in one line, so the labels are the separator.
    const parts = String(text || '').split(/\s*Dropdown\s*\d+\s*:\s*/i).slice(1).map((part) => part.trim());
    if (parts.length !== blanks.length || parts.some((part) => !part)) return null;
    // Prefer the option as the menu spells it, so the key matches a choice.
    return parts
      .map((part, i) => {
        const options = (blanks[i].options || []).map((option) => option.text);
        return options.find((option) => option.toLowerCase() === part.toLowerCase()) || part;
      })
      .join(',');
  }

  function extractGraphAnswerKey(blanks) {
    const block = document.querySelector('#di_oa_spoiler .downRow.di, .item.twoRowsBlock .downRow.di');
    if (!block) return null;
    return parseGraphAnswerKey(tidyInline(block.textContent).replace(/\n/g, ' '), blanks);
  }

  // The DI answer grid: one row per statement, one column per option.
  //   - the header row's LAST cell is the (blank) statement column
  //   - `td.official_answer` marks the correct column for that statement
  //   - `input.selectedAnswer` marks the column the user picked
  // Both verified 2026-09-21 against two Table Analysis topics, one answered
  // right (pick inside the official cell) and one wrong (pick beside it).
  function extractDiGrid(opBody) {
    const table = opBody.querySelector('table.stoker.di');
    if (!table) return null;
    const trs = Array.from(table.rows);
    if (trs.length < 2) return null;
    const headerCells = Array.from(trs[0].cells).map((c) => tidyInline(c.textContent).replace(/\n/g, ' '));
    const headers = headerCells.slice(0, -1);
    const colCount = headers.length;
    if (!colCount || headers.some((h) => !h)) return null;
    const rows = [];
    for (const tr of trs.slice(1)) {
      const cells = Array.from(tr.cells);
      if (cells.length < colCount + 1) continue;
      rows.push({
        label: tidyInline(cells[colCount].textContent).replace(/\n/g, ' '),
        options: cells.slice(0, colCount).map((td) => ({
          isCorrect: td.classList.contains('official_answer'),
          isUserSelected: !!td.querySelector('input.selectedAnswer'),
        })),
      });
    }
    if (!rows.length) return null;
    return { headers, rows };
  }

  // Shape the grid the way the StartTest matrix path already stores and renders
  // it: one answer_choices entry per statement carrying the per-cell flags, and
  // both answers as a CSV of 1-based column indices (one entry per row).
  function buildDiGridAnswers(grid) {
    if (!grid || !Array.isArray(grid.rows) || !grid.rows.length) return null;
    const headers = Array.isArray(grid.headers) ? grid.headers : [];
    const csv = (flag) => grid.rows
      .map((row) => {
        const idx = (row.options || []).findIndex((o) => o && o[flag]);
        return idx >= 0 ? String(idx + 1) : '';
      })
      .join(',');
    const correct = csv('isCorrect');
    const mine = csv('isUserSelected');
    return {
      choices: grid.rows.map((row, i) => ({
        label: `Q${i + 1}`,
        text: row.label || '',
        options: row.options || [],
        headers,
      })),
      correct_answer: /\d/.test(correct) ? correct : null,
      my_answer: /\d/.test(mine) ? mine : null,
    };
  }

  function extractAnswerStats() {
    // Primary source: GMAT Club's timer/answer-stats widget. The block carries
    // all data even when the wrapper has the `hidden` class (it only reveals
    // visually after the user clicks "Show Answer"). The correct letter is
    // marked by the `.correctAnswer` modifier on its wrapper, and the user's
    // selected letter by `.selectedAnswer`. Letters render lowercase here.
    const wrap = document.querySelector('.correctAnswerBlock');
    if (!wrap) return { correct: null, mine: null, distribution: [] };
    let correct = null;
    let mine = null;
    const distribution = [];
    for (const el of wrap.querySelectorAll('.statisticWrapExisting')) {
      const cls = el.className || '';
      const letter = (el.querySelector('.answerType')?.textContent || '').trim().toUpperCase();
      if (!letter) continue;
      const percent = (el.querySelector('.answerPercentage')?.textContent || '').trim();
      if (/\bcorrectAnswer\b/.test(cls) && !correct) correct = letter;
      if (/\bselectedAnswer\b/.test(cls) && !mine) mine = letter;
      distribution.push({ letter, percent });
    }
    return { correct, mine, distribution };
  }

  function extractCorrectLetterFromSpoiler() {
    // Fallback when no `.correctAnswerBlock` is on the page (rare). Pulls a
    // single letter A-E from a `.spoiler` block.
    const spoilers = Array.from(document.querySelectorAll('.spoiler-hidden, .spoiler'));
    for (const sp of spoilers) {
      const text = String(sp.textContent || '').replace(/\s+/g, ' ').replace(/^Show Spoiler\s*/i, '').trim();
      if (!text) continue;
      const trailing = text.match(/\b([A-E])\b\s*$/);
      if (trailing) return trailing[1];
      const explicit = text.match(/\b(?:OA|answer)[:\s]+\(?([A-E])\)?\b/i);
      if (explicit) return explicit[1];
      const paren = text.match(/\(([A-E])\)/);
      if (paren) return paren[1];
    }
    return null;
  }

  function extractTitle() {
    const h1 = document.querySelector('.topic-title-inner h1, h1.topic-title, h1');
    return tidyInline(h1?.textContent || '').replace(/\n/g, ' ');
  }

  // Question FORMAT (Problem Solving vs Data Sufficiency).
  //
  // Verified 2026-08-29: the Phase-1 analytics table has NO format column —
  // its "Category" cell holds a CONTENT topic ("Percent and Interest
  // Problems", "Remainders"), which the Phase-1 scraper maps to `PS` for
  // every quant row. That default silently mislabelled every GMAT Club DS
  // question as PS.
  //
  // The format is only recoverable here, from `document.title`, which GMAT
  // Club suffixes with the source forum:
  //   "Is y = 6? (1) y^2 = 36 (2) y^2 - 7y + 6 = 0 : Data Sufficiency (DS)"
  // The h1 carries the thread title WITHOUT the suffix, so read document.title.
  // (Forum <a> text is not usable — topic pages link out to unrelated
  // "Butler" threads whose names also contain "Problem Solving".)
  function extractFormat() {
    const title = String(document.title || '');
    const idx = title.lastIndexOf(' : ');
    const forum = idx === -1 ? '' : title.slice(idx + 3).trim();
    if (!forum) return { format_forum: null, format_code: null };
    if (/data\s*sufficiency|\(\s*DS\s*\)/i.test(forum)) return { format_forum: forum, format_code: 'DS' };
    if (/problem\s*solving|\(\s*PS\s*\)/i.test(forum)) return { format_forum: forum, format_code: 'PS' };
    return { format_forum: forum, format_code: null };
  }

  // RC layout detection. RC topics on GMAT Club render the passage as the
  // first content block, then a Q1..QN table-of-contents, then per-question
  // sections each wrapped in a `.itemRC.timer` widget. CR / single-question
  // topics have at most one `.itemRC.timer`.
  function detectRcLayout() {
    const blocks = document.querySelectorAll('.itemRC.timer');
    if (blocks.length < 2) return false;
    const op = findOpBody();
    if (!op) return false;
    const text = op.innerText || '';
    // Need at least two numbered question markers to safely split.
    const numbered = text.match(/^\s*\d+\.\s/gm) || [];
    return numbered.length >= 2;
  }

  // For RC, the .bbcodeBoxOut child of the OP body contains the passage text
  // followed by a "Question N" TOC and the per-question stems + choices. We
  // cut at the "All questions" / first "Question 1" marker to isolate just
  // the passage.
  function extractRcPassage(opBody) {
    const bb = opBody.querySelector('.bbcodeBoxOut') || opBody;
    const text = tidyInline(bb.innerText || '');
    if (!text) return null;
    // Cut at the "All questions" header or the first "Question N" anchor.
    const cutAt = text.search(/^\s*All questions\s*$/m);
    let head;
    if (cutAt > 0) {
      head = text.slice(0, cutAt);
    } else {
      const altCut = text.search(/^\s*Question\s+\d+\s*$/m);
      head = altCut > 0 ? text.slice(0, altCut) : text;
    }
    return head.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Parse per-question stems and choices from the OP body innerText. Returns
  // an array of { position, stem, choices: [{label,text}, ...] } in document
  // order. Stems are the lines starting "N." (1-indexed); choices follow as
  // "A ..." / "(A) ..." / "A) ..." lines.
  function extractRcQuestions(opBody) {
    const bb = opBody.querySelector('.bbcodeBoxOut') || opBody;
    const text = bb.innerText || '';
    if (!text) return [];
    const lines = text.split('\n').map((l) => l.trim());
    const labelRe = /^\(?([A-F])\)?[\.\)]?\s+(.*)$/;
    // Phase 1: collect numbered stems (positions where a line starts with "N.").
    const stems = [];
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(/^(\d+)\.\s+(.*)$/);
      if (m) stems.push({ position: parseInt(m[1], 10), startLine: i, firstText: m[2] });
    }
    if (stems.length < 2) return [];
    // Phase 2: for each stem, the body runs until the next stem's startLine
    // (or end-of-text). Within that body, separate the question text from
    // the A-E choice lines.
    const out = [];
    for (let s = 0; s < stems.length; s += 1) {
      const cur = stems[s];
      const next = stems[s + 1];
      const endLine = next ? next.startLine : lines.length;
      let stemText = cur.firstText;
      const choices = [];
      let lastLabelIdx = -1;
      let inChoices = false;
      // Lines that signal the start of the next question's timer widget; any
      // of these terminates choice / stem extraction for the current question.
      const widgetMarkerRe = /^(Question\s+\d+|All questions|Show Answer|Hide|History|Tag Mistake|My Mistake|Difficulty:|Question Stats:|\d{2}:\d{2}|Result|Date|Time)$/i;
      for (let i = cur.startLine + 1; i < endLine; i += 1) {
        const line = lines[i];
        if (!line) continue;
        if (widgetMarkerRe.test(line)) {
          // Stop appending — we've crossed into the next question's widget.
          if (inChoices) break;
          continue;
        }
        const m = line.match(labelRe);
        const labelIdx = m ? CHOICE_LABELS.indexOf(m[1]) : -1;
        if (m && labelIdx === lastLabelIdx + 1 && labelIdx < CHOICE_LABELS.length) {
          // Treat as a new choice only if it's the next label in sequence.
          choices.push({ label: m[1], text: m[2].trim() });
          lastLabelIdx = labelIdx;
          inChoices = true;
        } else if (inChoices && choices.length) {
          // Continuation of the previous choice.
          choices[choices.length - 1].text = (choices[choices.length - 1].text + ' ' + line).trim();
        } else {
          // Continuation of the stem.
          stemText = (stemText + ' ' + line).trim();
        }
      }
      out.push({
        position: cur.position,
        stem: tidyInline(stemText).replace(/\n+/g, ' '),
        choices,
      });
    }
    return out;
  }

  // For RC, each `.itemRC.timer` widget carries the per-question stats
  // (correct + user-pick + distribution). Iterate them in document order to
  // align with question position 1..N.
  function extractRcStatsByPosition() {
    const blocks = Array.from(document.querySelectorAll('.itemRC.timer'));
    return blocks.map((b, idx) => {
      const cb = b.querySelector('.correctAnswerBlock');
      let correct = null;
      let mine = null;
      const distribution = [];
      if (cb) {
        for (const el of cb.querySelectorAll('.statisticWrapExisting')) {
          const cls = el.className || '';
          const letter = (el.querySelector('.answerType')?.textContent || '').trim().toUpperCase();
          if (!letter) continue;
          const percent = (el.querySelector('.answerPercentage')?.textContent || '').trim();
          if (/\bcorrectAnswer\b/.test(cls) && !correct) correct = letter;
          if (/\bselectedAnswer\b/.test(cls) && !mine) mine = letter;
          distribution.push({ letter, percent });
        }
      }
      return { position: idx + 1, correct, mine, distribution };
    });
  }

  function gmatClubEnrichCurrentPage() {
    // Must run before any read: it rewrites the triple-rendered MathJax nodes
    // into single text nodes, in place, for both the RC and single-question paths.
    normalizeMathInPlace(document);
    const opBody = findOpBody();
    if (!opBody) return { ok: false, reason: 'no-op-body', url: location.href };

    const isRc = detectRcLayout();
    const title = extractTitle();
    const fmt = extractFormat();

    if (isRc) {
      const passage = extractRcPassage(opBody);
      const questions = extractRcQuestions(opBody);
      const statsByPos = extractRcStatsByPosition();
      const merged = questions.map((q) => {
        const s = statsByPos.find((x) => x.position === q.position) || {};
        return {
          position: q.position,
          stem: q.stem,
          choices: q.choices,
          correct_answer: s.correct || null,
          my_answer: s.mine || null,
          answer_distribution: s.distribution || [],
        };
      });
      return {
        ok: true,
        url: location.href,
        title,
        format_forum: fmt.format_forum,
        format_code: fmt.format_code,
        layout: 'rc',
        passage,
        questions: merged,
      };
    }

    // Read the DI answer grid off the LIVE body: cleanOpClone cuts the clone at
    // that grid, so by the time we have the clone it is gone.
    const diGrid = extractDiGrid(opBody);
    markStimulusImages(opBody);
    const questionOnly = cleanOpClone(opBody);
    const stimulus = extractStimulus(questionOnly);
    // Rewrites each dropdown into its flattened marker run, so it has to run
    // before the clone is turned into text.
    const diBlanks = extractGraphDropdowns(questionOnly);
    const linesText = htmlToLines(questionOnly.innerHTML || '');
    const choicesFromList = extractChoicesFromList(questionOnly);
    const choicesFromText = extractChoicesFromLines(linesText);
    let choices = (choicesFromList && choicesFromList.length >= 2)
      ? choicesFromList
      : choicesFromText;
    // A dropdown item's stem must KEEP its newlines: buildDropdownStatement is
    // line-based, and stemBeforeChoices collapses them to spaces.
    let stem = diBlanks ? tidyInline(linesText) : stemBeforeChoices(linesText);
    if (choices.length < 2) {
      const inline = extractChoicesFromInline(linesText);
      if (inline) { choices = inline.choices; stem = inline.stem; }
    }
    // Data Sufficiency topics print no choices at all — supply the fixed set.
    if (!choices.length && fmt.format_code === 'DS') choices = DS_CHOICES.map((c) => ({ ...c }));

    const stats = extractAnswerStats();
    const correctLetter = stats.correct || extractCorrectLetterFromSpoiler();

    // A DI grid item has no lettered choices and no A-E vote widget: its
    // answers live in the grid, per statement. Whatever the line parser made of
    // the grid's stray text is wrong here, so replace it outright.
    const diAnswers = buildDiGridAnswers(diGrid);
    const diKey = diBlanks ? extractGraphAnswerKey(diBlanks) : null;
    const responseFormat = diAnswers ? 'matrix' : (diBlanks ? 'dropdown' : null);

    return {
      ok: true,
      url: location.href,
      title,
      format_forum: fmt.format_forum,
      format_code: fmt.format_code,
      layout: 'single',
      response_format: responseFormat,
      stem,
      stimulus,
      choices: diAnswers ? diAnswers.choices : (diBlanks || choices),
      // A Graphics Interpretation page never restores the user's own picks —
      // the selects load on "Select" — so my_answer stays null rather than
      // being guessed at.
      correct_answer: diAnswers ? diAnswers.correct_answer : (diBlanks ? diKey : correctLetter),
      my_answer: diAnswers ? diAnswers.my_answer : (diBlanks ? null : stats.mine),
      answer_distribution: (diAnswers || diBlanks) ? [] : stats.distribution,
    };
  }

  if (typeof window !== 'undefined') window.gmatClubEnrichCurrentPage = gmatClubEnrichCurrentPage;

  // Node-side unit tests reach the pure helpers here; in the browser `module`
  // is undefined and this is a no-op.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      _internals: {
        latexToText, tidyInline, extractChoicesFromLines, extractChoicesFromInline,
        stemBeforeChoices, DS_CHOICES, buildDiGridAnswers, parseGraphAnswerKey,
      },
    };
  }
})();
