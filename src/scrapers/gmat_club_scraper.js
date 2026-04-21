(function () {
  'use strict';

  const PAGE_SIZE = 20;
  const PAGE_LOAD_POLL_MS = 300;
  const PAGE_LOAD_TIMEOUT_MS = 15000;

  const FORUM_TO_SUBJECT = {
    PS: 'Quant',
    DS: 'Quant',
    CR: 'Verbal',
    RC: 'Verbal',
    SC: 'Verbal',
    DI: 'DI',
    GI: 'DI',
    TA: 'DI',
    MSR: 'DI',
    TPA: 'DI',
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function parseDateRaw(raw) {
    // "7 Mar 2026" → Date
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
    return null;
  }

  function formatDateISO(d) {
    if (!d) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseSinceDate(since) {
    // YYYYMMDDHHmmss → Date
    if (!since || since.length < 8) return new Date(0);
    const y = parseInt(since.slice(0, 4));
    const m = parseInt(since.slice(4, 6)) - 1;
    const d = parseInt(since.slice(6, 8));
    const h = since.length >= 10 ? parseInt(since.slice(8, 10)) : 0;
    const min = since.length >= 12 ? parseInt(since.slice(10, 12)) : 0;
    const s = since.length >= 14 ? parseInt(since.slice(12, 14)) : 0;
    return new Date(y, m, d, h, min, s);
  }

  function parseTimeSec(raw) {
    // "03:10" → 190
    if (!raw) return null;
    const parts = raw.split(':');
    if (parts.length === 2) {
      return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    }
    if (parts.length === 3) {
      return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
    }
    return null;
  }

  function mapDifficulty(raw) {
    if (!raw) return null;
    const num = parseInt(raw.replace(/[^0-9]/g, ''));
    if (isNaN(num)) return null;
    if (num >= 805) return 'HARD';
    if (num >= 655) return 'MEDIUM';
    return 'EASY';
  }

  function extractTopicId(url) {
    if (!url) return null;
    const m = url.match(/topic(\d+)/);
    return m ? `gc-${m[1]}` : null;
  }

  function hashSessionId(dateStr) {
    // Simple numeric hash from date string for session_id
    let hash = 0;
    const s = `gmat-club-${dateStr}`;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  function scrapeCurrentPage() {
    const table = document.querySelector('.analytics-table');
    if (!table) return [];

    const rows = table.querySelectorAll('tbody tr');
    return Array.from(rows).map((row) => {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 8) return null;

      const questionLink = row.querySelector('a[href]');
      const resultCell = cells[7];
      const resultSvg = resultCell ? resultCell.querySelector('svg') : null;
      const svgClass = resultSvg ? (resultSvg.getAttribute('class') || '') : '';
      const isCorrect = svgClass.includes('text-green');

      return {
        question_stem: (cells[1] ? cells[1].textContent.trim() : ''),
        question_url: questionLink ? questionLink.href : '',
        forum: (cells[2] ? cells[2].textContent.trim() : ''),
        category: (cells[3] ? cells[3].textContent.trim() : ''),
        date_raw: (cells[4] ? cells[4].textContent.trim() : ''),
        difficulty_raw: (cells[5] ? cells[5].textContent.trim() : ''),
        time_raw: (cells[6] ? cells[6].textContent.trim() : ''),
        correct: isCorrect,
        attempts: parseInt(resultCell ? resultCell.textContent.trim() : '1') || 1,
        notes: (cells[8] ? cells[8].textContent.trim() : ''),
      };
    }).filter(Boolean);
  }

  function getShowingText() {
    const m = document.body.innerText.match(/Showing\s+([\d]+)-([\d]+)\s+of\s+(\d+)/i);
    if (!m) return null;
    return { start: parseInt(m[1]), end: parseInt(m[2]), total: parseInt(m[3]) };
  }

  async function waitForPageChange(prevShowing) {
    const deadline = Date.now() + PAGE_LOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const current = getShowingText();
      if (current && prevShowing && current.start !== prevShowing.start) {
        return current;
      }
      await sleep(PAGE_LOAD_POLL_MS);
    }
    return getShowingText();
  }

  function findNextPageButton(currentPage) {
    // Find pagination buttons — look for the next page number
    const allButtons = Array.from(document.querySelectorAll('button'));
    const nextPage = currentPage + 1;

    // First try to find a button with exactly the next page number
    const exactMatch = allButtons.find((b) => {
      const text = b.textContent.trim();
      return text === String(nextPage) && !b.disabled;
    });
    if (exactMatch) return exactMatch;

    // Look for a "Next" or ">" button
    const nextBtn = allButtons.find((b) => {
      const text = b.textContent.trim().toLowerCase();
      return (text === 'next' || text === '›' || text === '>') && !b.disabled;
    });
    return nextBtn || null;
  }

  window.runScraper = async function runScraper(cfg) {
    const sinceDate = parseSinceDate(cfg.since);
    const source = cfg.source || 'GMAT Club Error Log';

    console.log(`[gmat-club-scraper] Starting scrape, since=${cfg.since}, source=${source}`);

    const allQuestions = [];
    const showing = getShowingText();
    const total = showing ? showing.total : 0;
    const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

    console.log(`[gmat-club-scraper] Total questions: ${total}, pages: ${totalPages}`);

    let reachedEnd = false;

    for (let page = 1; page <= totalPages; page++) {
      console.log(`[gmat-club-scraper] Scraping page ${page}/${totalPages}`);

      const questions = scrapeCurrentPage();
      if (questions.length === 0) {
        console.log(`[gmat-club-scraper] No questions on page ${page}, stopping`);
        break;
      }

      // Check date filter: stop if oldest question on this page is before since
      for (const q of questions) {
        const qDate = parseDateRaw(q.date_raw);
        if (qDate && qDate < sinceDate) {
          reachedEnd = true;
          continue; // skip this question
        }
        allQuestions.push(q);
      }

      if (reachedEnd) {
        console.log(`[gmat-club-scraper] Reached since date cutoff on page ${page}`);
        break;
      }

      // Navigate to next page
      if (page < totalPages) {
        const prevShowing = getShowingText();
        const nextBtn = findNextPageButton(page);
        if (!nextBtn) {
          console.warn(`[gmat-club-scraper] No next page button found after page ${page}`);
          break;
        }
        nextBtn.click();
        await waitForPageChange(prevShowing);
        await sleep(500); // extra settle time
      }
    }

    console.log(`[gmat-club-scraper] Scraped ${allQuestions.length} questions total`);

    // Group questions by date → sessions
    const byDate = {};
    for (const q of allQuestions) {
      const d = parseDateRaw(q.date_raw);
      const dateKey = d ? formatDateISO(d) : 'unknown';
      if (!byDate[dateKey]) byDate[dateKey] = [];
      byDate[dateKey].push(q);
    }

    const sessions = Object.entries(byDate)
      .sort((a, b) => b[0].localeCompare(a[0])) // newest first
      .map(([dateKey, questions]) => {
        const correctCount = questions.filter((q) => q.correct).length;
        const errorCount = questions.length - correctCount;
        const times = questions.map((q) => parseTimeSec(q.time_raw)).filter((t) => t !== null);
        const avgTime = times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
        const correctTimes = questions.filter((q) => q.correct).map((q) => parseTimeSec(q.time_raw)).filter((t) => t !== null);
        const incorrectTimes = questions.filter((q) => !q.correct).map((q) => parseTimeSec(q.time_raw)).filter((t) => t !== null);
        const avgCorrectTime = correctTimes.length > 0 ? Math.round(correctTimes.reduce((a, b) => a + b, 0) / correctTimes.length) : 0;
        const avgIncorrectTime = incorrectTimes.length > 0 ? Math.round(incorrectTimes.reduce((a, b) => a + b, 0) / incorrectTimes.length) : 0;

        // Determine dominant subject
        const subjectCounts = {};
        for (const q of questions) {
          const subj = FORUM_TO_SUBJECT[q.forum] || 'Mixed';
          subjectCounts[subj] = (subjectCounts[subj] || 0) + 1;
        }
        const subject = Object.entries(subjectCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Mixed';

        return {
          session_id: hashSessionId(dateKey),
          date: dateKey,
          source,
          subject,
          review_category_id: null,
          stats: {
            total_q_api: questions.length,
            total_q_categories: questions.length,
            correct: correctCount,
            errors: errorCount,
            accuracy_pct: questions.length > 0 ? Math.round((correctCount / questions.length) * 1000) / 10 : 0,
            avg_time_sec: avgTime,
            avg_correct_time_sec: avgCorrectTime,
            avg_incorrect_time_sec: avgIncorrectTime,
          },
          questions: questions.map((q) => ({
            q_code: extractTopicId(q.question_url),
            q_id: extractTopicId(q.question_url),
            cat_id: null,
            correct: q.correct,
            difficulty: mapDifficulty(q.difficulty_raw),
            confidence: null,
            time_sec: parseTimeSec(q.time_raw),
            my_answer: null,
            correct_answer: null,
            topic: q.category || null,
            topic_source: q.category ? 'gmat_club' : null,
            question_url: q.question_url || null,
            question_stem: q.question_stem || null,
            answer_choices: null,
            subject_sub: q.forum || null,
            subject_sub_raw: q.forum || null,
            content_domain: null,
            response_format: null,
            response_details: null,
            notes: q.notes || null,
            mistake_type: null,
          })),
          wrong_q_ids: questions
            .filter((q) => !q.correct)
            .map((q) => ({
              q_id: extractTopicId(q.question_url),
              cat_id: null,
            })),
        };
      });

    return {
      extracted_at: new Date().toISOString(),
      config: {
        since: cfg.since,
        source,
        clientId: null,
        sinceTimezone: 'Asia/Bangkok',
        sessionDateTimezone: 'Asia/Bangkok',
        gmatTimestampTimezone: 'UTC (Z)',
        gmatTimestampField: 'created_at',
      },
      sessions,
    };
  };
})();
