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

  window.gmatClubEnrichCurrentPage = function gmatClubEnrichCurrentPage() {
    const opBody = findOpBody();
    if (!opBody) return { ok: false, reason: 'no-op-body', url: location.href };

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
      title: extractTitle(),
      stem,
      choices,
      correct_answer: correctLetter,
      my_answer: stats.mine,
      answer_distribution: stats.distribution,
    };
  };
})();
