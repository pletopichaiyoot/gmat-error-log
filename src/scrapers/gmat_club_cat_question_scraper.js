// src/scrapers/gmat_club_cat_question_scraper.js
/* global document, window, location */
// GMAT Club CAT Phase-2 enrichment — runs in the browser via CDP. The Node-side
// runner navigates the same gmatclub.com tab to each /gmat-focus-tests/view-{id}.html
// page; this module exposes window.gmatClubCatEnrichCurrentPage().
//
// DOM contract (verified live 2026-06-21 on a freshly-navigated view page):
//   - Choices live in `.options > .option`, each `<div class="option">` holding
//     `<input type="radio" name="answer" id="A" value="A">` + `<label for="A">…</label>`.
//     The choice LETTER is the input's `value` (or `id`); the choice TEXT is the
//     label text.
//   - The CORRECT answer is a `<span class="correctAnswer">` whose text is the
//     letter (e.g. "A"). This is the reliable correct-answer source.
//   - The USER'S pick is NOT in the static DOM on a direct navigation — the
//     radios are unchecked and `.wrongAnswer` is only a red-X icon. (It is only
//     present on a tab the user walked through the review UI, where the matching
//     radio is `:checked`.) So `my_answer` is captured opportunistically from a
//     `:checked` radio when present; otherwise the Phase-2 DB writer infers it
//     for questions Phase 1 already marked correct (my_answer === correct_answer).
//   - The stem precedes the options; the explanation follows a
//     "HIDE/SHOW EXPLANATION" marker.

(function () {
  'use strict';

  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  function letterForIndex(i) { return LETTERS[i] || String(i + 1); }

  function normLetter(raw) {
    const m = String(raw || '').trim().toUpperCase().match(/[A-H]/);
    return m ? m[0] : null;
  }

  // Pure, unit-testable: given the raw options (label+text already resolved from
  // the DOM) and the correct/selected letters, flag each choice.
  function markChoices(rawOptions, correctLetter, mineLetter) {
    const correct = normLetter(correctLetter);
    const mine = normLetter(mineLetter);
    const choices = (Array.isArray(rawOptions) ? rawOptions : []).map((o, i) => {
      const label = normLetter(o.label) || letterForIndex(i);
      return {
        label,
        text: o.text || '',
        isCorrect: !!correct && label === correct,
        isUserSelected: !!mine && label === mine,
      };
    });
    return { choices, correct_answer: correct, my_answer: mine };
  }

  function tidy(text) { return String(text || '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(); }

  function extractCurrentPage() {
    const optionEls = Array.from(document.querySelectorAll('.options .option, .option'));
    if (!optionEls.length) return { ok: false, reason: 'no-options', url: location.href };

    // Resolve label (input value/id) + text (label element) per option.
    const rawOptions = optionEls.map((el, i) => {
      const input = el.querySelector('input[type=radio]');
      const labelEl = el.querySelector('label');
      const label = input ? (input.value || input.id) : letterForIndex(i);
      const text = tidy((labelEl ? labelEl.textContent : el.textContent) || '').replace(/\n/g, ' ');
      return { label, text };
    });

    // Correct answer = the `.correctAnswer` span's letter. The page renders two
    // `.correctAnswer` nodes; only one carries the letter, and only once the
    // explanation is expanded (the Node runner expands it first). Scan all of
    // them for the first bare A-H letter.
    const correctLetter = Array.from(document.querySelectorAll('.correctAnswer'))
      .map((el) => (el.textContent || '').trim())
      .find((t) => /^[A-H]$/.test(t)) || '';
    // User pick = a `:checked` radio if the page happens to carry the answered
    // state (only on tabs walked through the review UI). Usually absent on a
    // direct navigation; the DB writer backfills correct questions.
    const checked = document.querySelector('.options input[type=radio]:checked, input[name="answer"]:checked');
    const mineLetter = checked ? (checked.value || checked.id) : null;

    const { choices, correct_answer, my_answer } = markChoices(rawOptions, correctLetter, mineLetter);

    // Stem: question text up to the first option. Fall back to the body text.
    const container = optionEls[0].closest('.question, .questionBox, .item, form') || document.body;
    const full = tidy(container.innerText || '');
    const firstOptText = rawOptions[0] && rawOptions[0].text ? rawOptions[0].text.slice(0, 24) : '';
    let stem = (firstOptText && full.includes(firstOptText)) ? full.slice(0, full.indexOf(firstOptText)).trim() : full.slice(0, 1200);
    // Trim the leading Test-Center header lines (section/type/category/qcode/Bookmark).
    stem = stem.replace(/^[\s\S]*?Bookmark\s*/i, '').trim() || stem;

    // Explanation: text after a "HIDE EXPLANATION" / "SHOW EXPLANATION" marker.
    const bodyText = tidy(document.body.innerText || '');
    let explanation = null;
    const expM = bodyText.match(/(?:HIDE|SHOW) EXPLANATION([\s\S]*)$/i);
    if (expM) explanation = expM[1].replace(/I like the solution[\s\S]*$/i, '').trim().slice(0, 8000) || null;

    return { ok: true, url: location.href, stem, choices, correct_answer, my_answer, explanation };
  }

  if (typeof window !== 'undefined') {
    window.gmatClubCatEnrichCurrentPage = extractCurrentPage;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { _internals: { letterForIndex, normLetter, markChoices } };
  }
})();
