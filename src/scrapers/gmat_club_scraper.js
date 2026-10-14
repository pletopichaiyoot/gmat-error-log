(function () {
  'use strict';

  // GMAT Club Error Log scraper — runs in the browser context, injected by
  // scraper-runner.js as `window.runScraper(cfg)`.
  //
  // Target page: https://gmatclub.com/forum/analytics.php#error_log
  //
  // The table on that page is a render of a JSON API, and the render drops the
  // one field that decides the subject: `forum`, the question FORMAT (PS, DS,
  // TPA, MSR, G&T, CR, RC). The Category column it does show is a content
  // topic, and topics are shared across formats — "Word Problems" sits under
  // both Data Sufficiency and Problem Solving — so scraping the table could only
  // guess, and it filed every DS and TPA question under Quant. This reads the
  // API instead, which also returns the whole log in one request rather than a
  // walk through the pager.
  //
  //   POST /api/errorlog/v1/answers  {filters…, sort_by, limit, page} -> {data[], total}
  //
  // Same-origin and authorised by the session cookie the tab already holds.

  const ERROR_LOG_API = '/api/errorlog/v1/answers';
  const PAGE_LIMIT = 1000;
  // ponytail: stops after 20 pages (20k attempts); raise it if a log ever grows past that.
  const MAX_PAGES = 20;

  // Forum tag -> category code. The tag is the parenthesised abbreviation in
  // the forum's title ("Two-part Analysis (TPA)"), except for retired DS
  // questions, whose forum has no abbreviation.
  const FORUM_TO_CODE = {
    PS: 'PS',
    DS: 'DS',
    // GMAT Club files this forum under its GRE section, but the questions are
    // GMAT Data Sufficiency — 157 of 995 rows when this was written, so
    // trusting the section would drop a sixth of the log.
    'DS Retired Questions': 'DS',
    TPA: 'TPA',
    MSR: 'MSR',
    CR: 'CR',
    RC: 'RC',
  };

  // Fallback only: a row whose forum is missing or unrecognised (SC, the GRE
  // forums, a G&T row with no Graphs/Tables chip) is guessed from its topic
  // chips, as every row used to be. The guess goes in subject_sub_raw alone,
  // never category_code, so question-metadata's Data Sufficiency stem check
  // and the classifier can still overrule it.
  const GMATCLUB_CATEGORY_TO_CODE = {
    // Quant — PS
    'probability': 'PS', 'combinations': 'PS', 'permutations': 'PS',
    'counting': 'PS', 'counting methods': 'PS',
    'number properties': 'PS', 'remainders': 'PS',
    'multiples and factors': 'PS', 'divisibility': 'PS', 'divisors': 'PS',
    'exponents': 'PS', 'roots': 'PS', 'powers and roots': 'PS',
    'algebra': 'PS', 'inequalities': 'PS', 'absolute values': 'PS',
    'absolute value': 'PS', 'functions': 'PS', 'sequences': 'PS',
    'min-max problems': 'PS', 'min/max problems': 'PS',
    'arithmetic': 'PS', 'fractions': 'PS', 'decimals': 'PS',
    'percent': 'PS', 'percents': 'PS', 'percentages': 'PS',
    'ratios': 'PS', 'ratio and proportion': 'PS', 'ratio & proportion': 'PS',
    'mixture problems': 'PS', 'word problems': 'PS', 'arithmetic word problems': 'PS',
    'distance and speed problems': 'PS', 'distance/rate problems': 'PS',
    'work rate problems': 'PS', 'work/rate problems': 'PS', 'rates': 'PS',
    'statistics': 'PS', 'standard deviation': 'PS',
    'geometry': 'PS', 'coordinate geometry': 'PS', 'solid geometry': 'PS',
    'overlapping sets': 'PS', 'sets': 'PS', 'venn diagrams': 'PS',
    // Verbal — CR
    'strengthen': 'CR', 'weaken': 'CR', 'logical flaw': 'CR', 'flaw': 'CR',
    'assumption': 'CR', 'evaluate': 'CR', 'resolve': 'CR', 'explain': 'CR',
    'inference': 'CR',
    // "Must or Could be True" is a QUANT tag on GMAT Club — its own CAT score
    // report files it under Quant / PS — so it is deliberately absent here and
    // from the keyword list. Compound categories resolve on their quant half
    // ("Inequalities,Must or Could be True" -> PS); a bare one gets no code and
    // falls through to the LLM classifier rather than being guessed at.
    'boldface': 'CR', 'method': 'CR', 'parallel': 'CR', 'complete': 'CR',
    'argument structure': 'CR', 'cr': 'CR',
    // Verbal — RC
    'main idea': 'RC', 'main idea / purpose': 'RC', 'purpose': 'RC',
    'detail': 'RC', 'structure / function': 'RC', 'author view': 'RC',
    'author attitude': 'RC', 'application': 'RC', 'organization': 'RC',
    'rc': 'RC',
    // DI
    'tables': 'TA', 'table analysis': 'TA',
    'graphs': 'GI', 'graphics interpretation': 'GI',
    'multi-source reasoning': 'MSR', 'msr': 'MSR',
    'two-part analysis': 'TPA', 'tpa': 'TPA',
    'di': 'DI',
  };
  // DS is Data Insights under GMAT Focus, not Quant — the same split
  // normalizeSubjectCode uses in src/question-metadata.js.
  const CODE_TO_SUBJECT = { PS: 'Q', DS: 'DI', CR: 'V', RC: 'V', GI: 'DI', TA: 'DI', MSR: 'DI', TPA: 'DI', DI: 'DI' };

  // Keyword fallback for compound GMAT Club categories like
  // "Statistics and Sets Problems" that aren't a direct entry in the table.
  // Order matters: more specific keywords first.
  // Drop trailing \b so plurals/suffixes (e.g., "statistics", "fractions",
  // "ratios", "rates", "sets") still match the stem.
  const KEYWORD_TO_CODE = [
    [/\b(inference|infer)/, 'CR'],
    [/\b(strengthen|weaken|flaw|assumption|evaluate|resolve|explain|boldface|argument|parallel)/, 'CR'],
    [/\b(main idea|purpose|author|detail|structure|application|organization)/, 'RC'],
    // GMAT Club tags RC passages by subject + length, e.g. "Science,Short Passage",
    // "Business,Long Passage" — none hit the keywords above, so match the passage tag.
    [/\b(short|long)?\s*passages?\b/, 'RC'],
    [/\b(table analysis|tables?)\b/, 'TA'],
    [/\b(graphs?|graphics)/, 'GI'],
    [/\b(multi.?source|msr)\b/, 'MSR'],
    [/\b(two.?part|tpa)\b/, 'TPA'],
    [/\b(probability|combination|permutation|counting)/, 'PS'],
    [/\b(geometry|coordinate)/, 'PS'],
    [/\b(algebra|inequalit|absolute value|function|sequence|exponent|root)/, 'PS'],
    [/\b(arithmetic|fraction|decimal|percent|ratio)/, 'PS'],
    [/\b(rate|work|distance|speed|motion|mixture)/, 'PS'],
    [/\b(statistic|stats|standard deviation|deviation|mean|median|average)/, 'PS'],
    [/\b(set|venn|overlapping)/, 'PS'],
    [/\b(number propert|divisor|factor|multiple|remainder|prime|integer)/, 'PS'],
    [/\b(min.?max|word problem)/, 'PS'],
  ];

  function mapGmatClubCategory(raw) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) return { code: null, subject: null };
    let code = GMATCLUB_CATEGORY_TO_CODE[key] || null;
    if (!code) {
      for (const [pattern, mappedCode] of KEYWORD_TO_CODE) {
        if (pattern.test(key)) { code = mappedCode; break; }
      }
    }
    return { code, subject: code ? CODE_TO_SUBJECT[code] || null : null };
  }

  function parseSinceDateKey(since) {
    // YYYYMMDDHHmmss → "YYYY-MM-DD" (day granularity — the table only shows date)
    const s = String(since || '');
    if (s.length < 8) return '';
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }

  function mapDifficulty(raw) {
    // GMAT Club's own Focus-scale band → tier mapping, taken verbatim from
    // their Difficulty filter UI. Seven bands, bucketed on the lower bound:
    //   Easy:   "Sub 505", "505-555"           (low < 555)
    //   Medium: "555-605", "605-655"           (555 <= low < 655)
    //   Hard:   "655-705", "705-805", "805+"   (low >= 655)
    // Title-cased to match the StartTest/OPE difficulty labels (downstream
    // aggregation is case-insensitive, but raw display elsewhere is not).
    if (!raw) return null;
    const m = String(raw).match(/(\d+)/);
    if (!m) return null;
    const low = parseInt(m[1], 10);
    if (!Number.isFinite(low)) return null;
    if (low < 555) return 'Easy';
    if (low < 655) return 'Medium';
    return 'Hard';
  }

  function extractTopicId(url) {
    const m = String(url || '').match(/topic(\d+)/);
    return m ? m[1] : null;
  }

  function hashSessionId(input) {
    let hash = 0;
    const s = String(input);
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  function forumToCode(forum, topics) {
    const key = String(forum || '').trim();
    if (FORUM_TO_CODE[key]) return FORUM_TO_CODE[key];
    // "Graphs and Tables" is one forum covering two Focus formats; the topic
    // chips say which.
    if (key === 'G&T') {
      const chips = (topics || []).join(',').toLowerCase();
      if (/\bgraphs?\b/.test(chips)) return 'GI';
      if (/\btables?\b/.test(chips)) return 'TA';
    }
    return null;
  }

  // The day a row belongs to, as YYYY-MM-DD in `timeZone`. Session ids hash
  // this key, so it has to match the day the old table scraper read off the
  // page — which GMAT Club renders in the BROWSER's zone, not the API's
  // -08:00. Verified against every stored attempt: 910 of 910 land on their
  // existing session this way, where keying on the timestamp's own date would
  // have moved 345 of them to the previous day and duplicated their sessions.
  function dayKey(iso, timeZone) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  }

  function toQuestion(r) {
    const topics = Array.isArray(r.category) ? r.category.filter(Boolean) : [];
    const topic = topics.join(',') || null;
    const tagged = forumToCode(r.forum, topics);
    const code = tagged || mapGmatClubCategory(topic).code;
    // The id names its table — phpbb_topics_timer_{,di_,rc_}history-N — and
    // only N is kept, which is what every stored gc-att- id was built from.
    // ponytail: assumes N never repeats across those tables (none did in 995
    // rows); namespace the q_id by table if one ever does.
    const attemptId = (String(r.id || '').match(/(\d+)$/) || [])[1] || null;
    const questionId = r.question_id ? String(r.question_id) : extractTopicId(r.question_url);
    // Same text the table's Mistakes/Notes cell rendered: the mistake chips,
    // then the note.
    const notes = [...(Array.isArray(r.mistakes) ? r.mistakes : []), r.note]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return {
      // q_id = stable per-attempt id (timer history). q_code = per-question
      // topic id. Both prefixed for cross-source uniqueness.
      q_id: attemptId ? `gc-att-${attemptId}` : null,
      q_code: questionId ? `gc-q-${questionId}` : null,
      cat_id: null,
      correct: r.is_correct === true,
      difficulty: mapDifficulty(r.difficulty),
      confidence: null,
      time_sec: Number.isFinite(r.spent_time) ? r.spent_time : null,
      my_answer: null,
      correct_answer: null,
      topic,
      subcategory: topic,
      topic_source: code ? 'gmatclub-canonical' : null,
      question_url: r.question_url ? new URL(r.question_url, 'https://gmatclub.com').href : null,
      // RC rows carry the passage position here ("… epidemi (№6)"), which
      // Phase 2 pins sub-questions on — keep the API's text verbatim.
      question_stem: r.question || null,
      answer_choices: null,
      // The forum tag is authoritative, so it is written as category_code and
      // subject_code. saveScrapeResult prefers an incoming category_code over
      // the stored one, which is what lets a re-scrape correct rows the old
      // guess filed wrongly — left in subject_sub_raw alone, the stale stored
      // category would win.
      category_code: tagged,
      subject_code: tagged ? CODE_TO_SUBJECT[tagged] : null,
      subject_sub: null,
      subject_sub_raw: code,
      content_domain: null,
      response_format: null,
      response_details: null,
      notes: notes || null,
      mistake_type: null,
    };
  }

  // GMAT Club Error Log is not session-based, so each calendar day becomes one
  // synthetic session, id hashed from `${source}|${dateKey}`.
  function buildSessions(rows, { source, sinceKey = '', timeZone } = {}) {
    const byDate = new Map();
    for (const r of rows) {
      // Whole practice tests and quizzes appear in the log as one row with no
      // question; they are not attempts (the CAT has its own scraper).
      if (r.type !== 'answer') continue;
      const dateKey = dayKey(r.date, timeZone);
      if (sinceKey && dateKey && dateKey < sinceKey) continue;
      const key = dateKey || 'unknown';
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(toQuestion(r));
    }

    const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
    const timesOf = (qs) => qs.map((q) => q.time_sec).filter((t) => t !== null);
    return Array.from(byDate.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([dateKey, questions]) => {
        const correct = questions.filter((q) => q.correct);
        const wrong = questions.filter((q) => !q.correct);
        return {
          session_id: hashSessionId(`${source}|${dateKey}`),
          date: dateKey,
          source,
          // A day mixes all three sections; downstream derives the session
          // subject from its questions.
          subject: null,
          review_category_id: null,
          stats: {
            total_q_api: questions.length,
            total_q_categories: questions.length,
            correct: correct.length,
            errors: wrong.length,
            accuracy_pct: questions.length > 0 ? Math.round((correct.length / questions.length) * 1000) / 10 : 0,
            avg_time_sec: avg(timesOf(questions)),
            avg_correct_time_sec: avg(timesOf(correct)),
            avg_incorrect_time_sec: avg(timesOf(wrong)),
          },
          questions,
          wrong_q_ids: wrong.map((q) => ({ q_id: q.q_id, cat_id: null })),
        };
      });
  }

  async function fetchErrorLogRows() {
    const rows = [];
    const seen = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(ERROR_LOG_API, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category_ids: [], topic_ids: [], sources: [], difficulties: [],
          time_preset: '', time_from: '', time_to: '',
          groups_only: false, hide_groups: false, mistakes: [],
          sort_by: 'date', sort_asc: false, limit: PAGE_LIMIT, page,
        }),
      });
      // A signed-out tab gets an HTML page back; say so rather than failing on
      // the JSON parse.
      if (!res.ok || !/json/i.test(res.headers.get('content-type') || '')) {
        throw new Error(`GMAT Club error-log API answered HTTP ${res.status} (${res.headers.get('content-type') || 'no type'}) — is the gmatclub.com tab signed in?`);
      }
      const body = await res.json();
      const data = Array.isArray(body && body.data) ? body.data : [];
      for (const r of data) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        rows.push(r);
      }
      if (!data.length || rows.length >= (Number(body && body.total) || 0)) break;
    }
    return rows;
  }

  async function runScraper(cfg) {
    const sinceKey = parseSinceDateKey(cfg && cfg.since);
    const source = (cfg && cfg.source) || 'GMAT Club Error Log';
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    console.log(`[gmat-club-scraper] start since=${cfg && cfg.since} (key=${sinceKey}) source=${source} tz=${timeZone}`);

    const rows = await fetchErrorLogRows();
    const sessions = buildSessions(rows, { source, sinceKey, timeZone });
    console.log(`[gmat-club-scraper] ${rows.length} log rows -> ${sessions.length} sessions`);

    return {
      extracted_at: new Date().toISOString(),
      config: {
        since: cfg && cfg.since,
        source,
        clientId: null,
        sinceTimezone: 'Asia/Bangkok',
        sessionDateTimezone: 'browser-local',
      },
      sessions,
    };
  }

  if (typeof window !== 'undefined') window.runScraper = runScraper;

  // Node-side unit tests reach the pure helpers here; in the browser `module`
  // is undefined and this is a no-op.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      _internals: { forumToCode, mapGmatClubCategory, dayKey, toQuestion, buildSessions, hashSessionId },
    };
  }
})();
