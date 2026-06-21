// src/scrapers/gmat_club_cat_scraper.js
// GMAT Club CAT (GMAT Focus full-length practice tests) scraper — Phase 1.
// Node-side, multi-navigation (mirrors ttp_scraper.js). Called with an
// already-navigated Playwright `page` connected to the user's logged-in Chrome
// via CDP. Walks My Tests -> score report -> results grid and emits one session
// per completed test. Phase 2 enrichment lives in gmat_club_cat_question_scraper.js.
//
// DOM contract (verified 2026-06-21) — see
// docs/superpowers/specs/2026-06-21-gmatclub-cat-scraper-design.md.

'use strict';

const GMATCLUB_HOST_RE = /gmatclub\.com/i;
const TESTS_URL = 'https://gmatclub.com/gmat-focus-tests/?page=tests';

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

class ScrapeAnomalyError extends Error {
  constructor(message, { url, snippet } = {}) {
    super(message);
    this.name = 'ScrapeAnomalyError';
    this.url = url || null;
    this.snippet = snippet || null;
  }
}

function jitter(minMs, maxMs) {
  const lo = Math.max(0, Number(minMs) || 0);
  const hi = Math.max(lo, Number(maxMs) || lo);
  return Math.round(lo + Math.random() * (hi - lo));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, ms | 0))); }

function mapSectionToSubject(section) {
  const s = String(section || '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('quant')) return 'Q';
  if (s.startsWith('verbal')) return 'V';
  if (s.startsWith('data insight') || s === 'di') return 'DI';
  return null;
}

function parseTypeCell(text) {
  const parts = String(text || '').split('/').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!parts.length) return { subjectCode: null, categoryCode: null, topic: null };
  const subjectCode = mapSectionToSubject(parts[0]);
  const categoryCode = parts[1] ? parts[1].toUpperCase() : null;
  const topic = parts[2] || null;
  return { subjectCode, categoryCode, topic };
}

function parseTimeSec(raw) {
  if (!raw) return null;
  const parts = String(raw).trim().split(':').map((x) => parseInt(x, 10));
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function parseGridTimestamp(raw) {
  // "Jun 21, 2026 12:05 AM" -> { dateKey:'2026-06-21', iso }
  const m = String(raw || '').match(/([A-Za-z]{3,})\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return { dateKey: null, iso: null };
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (month === undefined || !Number.isFinite(day) || !Number.isFinite(year)) return { dateKey: null, iso: null };
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return { dateKey: `${year}-${mm}-${dd}`, iso: new Date(year, month, day).toISOString() };
}

function firstIntInRange(str, lo, hi) {
  const nums = String(str || '').match(/\d+(?:\.\d+)?/g) || [];
  for (const n of nums) {
    const v = Math.round(parseFloat(n));
    if (v >= lo && v <= hi) return v;
  }
  return null;
}

function parseScoreReport(rows) {
  // rows: array of [sectionLabel, percentileText, valuesText]. The valuesText is
  // "min mean score max" (e.g. "205 554.67 565 805" or "60 78.06 81 90").
  const out = { total: { score: null, percentile: null }, quant: { score: null, percentile: null },
    verbal: { score: null, percentile: null }, di: { score: null, percentile: null } };
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const label = String(row?.[0] || '').toLowerCase();
    const pctText = String(row?.[1] || '');
    const valsText = String(row?.[2] || '');
    const percentile = firstIntInRange(pctText.match(/\d+/)?.[0] || pctText, 0, 100);
    let bucket = null; let lo; let hi;
    if (/total/.test(label)) { bucket = 'total'; lo = 205; hi = 805; }
    else if (/quant/.test(label)) { bucket = 'quant'; lo = 60; hi = 90; }
    else if (/verbal/.test(label)) { bucket = 'verbal'; lo = 60; hi = 90; }
    else if (/data insight/.test(label)) { bucket = 'di'; lo = 60; hi = 90; }
    if (!bucket) continue;
    // The score is the last in-range integer that is NOT the min/max bound.
    const nums = (valsText.match(/\d+(?:\.\d+)?/g) || []).map((n) => parseFloat(n));
    const candidates = nums.filter((n) => Number.isInteger(n) && n >= lo && n <= hi && n !== lo && n !== hi);
    out[bucket] = { score: candidates.length ? candidates[candidates.length - 1] : firstIntInRange(valsText, lo, hi), percentile };
  }
  return out;
}

function parseSinceDateKey(since) {
  const s = String(since || '');
  if (s.length < 8) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

module.exports = {
  ScrapeAnomalyError,
  GMATCLUB_HOST_RE,
  TESTS_URL,
  _internals: {
    parseTypeCell, mapSectionToSubject, parseTimeSec, parseGridTimestamp,
    parseScoreReport, parseSinceDateKey, firstIntInRange, jitter, sleep,
  },
};
