// src/scrapers/gmat_club_cat_question_scraper.js
/* global document, window, location */
// GMAT Club CAT Phase-2 enrichment — runs in the browser via CDP. The Node-side
// runner navigates the same gmatclub.com tab to each /gmat-focus-tests/view-{id}.html
// page; this module exposes window.gmatClubCatEnrichCurrentPage().
//
// DOM contract (verified 2026-06-21): the Test Center view page renders choices
// as `.option` elements. The CORRECT option carries the `valid` class; the
// USER'S pick is the `.option` whose `input[type=radio]` is :checked. The stem
// precedes the options; the explanation toggles via "HIDE/SHOW EXPLANATION".

(function () {
  'use strict';

  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  function letterForIndex(i) { return LETTERS[i] || String(i + 1); }

  function deriveAnswerLetters(choices) {
    const labeled = (Array.isArray(choices) ? choices : []).map((c, i) => ({
      label: letterForIndex(i),
      text: c.text || '',
      isCorrect: !!c.isCorrect,
      isUserSelected: !!c.isUserSelected,
    }));
    const correct = labeled.find((c) => c.isCorrect);
    const mine = labeled.find((c) => c.isUserSelected);
    return { labeled, correct_answer: correct ? correct.label : null, my_answer: mine ? mine.label : null };
  }

  function tidy(text) { return String(text || '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(); }

  function extractCurrentPage() {
    const optionEls = Array.from(document.querySelectorAll('.option'));
    if (!optionEls.length) return { ok: false, reason: 'no-options', url: location.href };

    const rawChoices = optionEls.map((el) => ({
      text: tidy(el.textContent).replace(/\n/g, ' '),
      isCorrect: /\bvalid\b/.test(el.className || ''),
      isUserSelected: !!el.querySelector('input[type=radio]:checked'),
    }));
    const { labeled, correct_answer, my_answer } = deriveAnswerLetters(rawChoices);

    // Stem: text content of the question block up to the first option. The view
    // page renders the stem inside a question container; fall back to body text
    // sliced before the first option's text.
    const container = optionEls[0].closest('.question, .questionBox, .item, form') || document.body;
    let stem = '';
    const firstOptText = rawChoices[0] ? rawChoices[0].text.slice(0, 24) : '';
    const full = tidy(container.innerText || '');
    if (firstOptText && full.includes(firstOptText)) {
      stem = full.slice(0, full.indexOf(firstOptText)).trim();
    } else {
      stem = full.slice(0, 1200);
    }
    // Trim the leading Test-Center header lines (section/type/category/qcode/Bookmark).
    stem = stem.replace(/^[\s\S]*?Bookmark\s*/i, '').trim() || stem;

    // Explanation: text after a "HIDE EXPLANATION" / "SHOW EXPLANATION" marker.
    const bodyText = tidy(document.body.innerText || '');
    let explanation = null;
    const expM = bodyText.match(/(?:HIDE|SHOW) EXPLANATION([\s\S]*)$/i);
    if (expM) explanation = expM[1].replace(/I like the solution[\s\S]*$/i, '').trim().slice(0, 8000) || null;

    return { ok: true, url: location.href, stem, choices: labeled, correct_answer, my_answer, explanation };
  }

  if (typeof window !== 'undefined') {
    window.gmatClubCatEnrichCurrentPage = extractCurrentPage;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { _internals: { letterForIndex, deriveAnswerLetters } };
  }
})();
