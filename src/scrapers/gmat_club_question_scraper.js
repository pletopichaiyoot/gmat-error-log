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

  const CHOICE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

  function tidyInline(text) {
    return String(text || '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  }

  function htmlToLines(htmlSnippet) {
    // Normalize <br> and block boundaries to newlines, then strip remaining tags.
    const withBreaks = String(htmlSnippet || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    // Decode common HTML entities that appear inside content.
    const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
    return withBreaks.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => entities[m] || m);
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
    const labelRe = /^\(?([A-F])\)?\s*[\.\)]\s*(.*)$/;
    for (const line of lines) {
      if (!line) {
        if (current) { choices.push(current); current = null; }
        continue;
      }
      const m = line.match(labelRe);
      const labelIdx = m ? CHOICE_LABELS.indexOf(m[1]) : -1;
      // Only treat as a new choice if the label is the next one in sequence
      // (avoids false positives inside math expressions).
      if (m && labelIdx === lastLabelIdx + 1 && labelIdx < CHOICE_LABELS.length) {
        if (current) choices.push(current);
        current = { label: m[1], text: m[2].trim() };
        lastLabelIdx = labelIdx;
      } else if (current) {
        current.text = (current.text + ' ' + line).trim();
      }
    }
    if (current) choices.push(current);
    return choices;
  }

  function stemBeforeChoices(linesText) {
    // Cut the stem at the first "A." / "A)" / "(A)" line.
    const lines = String(linesText || '').split(/\n/);
    const cutAt = lines.findIndex((line) => /^\s*\(?A\)?\s*[\.\)]\s+/.test(line));
    const stemLines = cutAt === -1 ? lines : lines.slice(0, cutAt);
    return tidyInline(stemLines.join('\n')).replace(/\n+/g, ' ').trim();
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
    const text = (bb.innerText || '').trim();
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

  window.gmatClubEnrichCurrentPage = function gmatClubEnrichCurrentPage() {
    const opBody = findOpBody();
    if (!opBody) return { ok: false, reason: 'no-op-body', url: location.href };

    const isRc = detectRcLayout();
    const title = extractTitle();

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
        layout: 'rc',
        passage,
        questions: merged,
      };
    }

    const linesText = htmlToLines(opBody.innerHTML || '');
    const choicesFromList = extractChoicesFromList(opBody);
    const choicesFromText = extractChoicesFromLines(linesText);
    const choices = (choicesFromList && choicesFromList.length >= 2)
      ? choicesFromList
      : choicesFromText;

    const stem = stemBeforeChoices(linesText);
    const stats = extractAnswerStats();
    const correctLetter = stats.correct || extractCorrectLetterFromSpoiler();

    return {
      ok: true,
      url: location.href,
      title,
      layout: 'single',
      stem,
      choices,
      correct_answer: correctLetter,
      my_answer: stats.mine,
      answer_distribution: stats.distribution,
    };
  };
})();
