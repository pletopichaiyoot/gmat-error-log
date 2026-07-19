// src/scrapers/scraper-utils.js
// Shared Node-side helpers for the multi-navigation scrapers (StartTest, OPE
// mock, GMAT Club CAT, TTP). Consolidated 2026-07-19 from four byte-identical
// (sleep, hashSessionExternalId) / near-identical (jitter) local copies.
//
// These run Node-side only — never inside page.evaluate(). Page-injected
// scrapers keep their own inline copies because the browser context has no
// require().

'use strict';

// Uniform random delay in [minMs, maxMs], rounded to whole milliseconds. Always
// consumed as `await sleep(jitter(a, b))`, so the rounding is cosmetic (sleep
// truncates with `ms | 0`); kept for tidy values.
function jitter(minMs, maxMs) {
  const lo = Math.max(0, Number(minMs) || 0);
  const hi = Math.max(lo, Number(maxMs) || lo);
  return Math.round(lo + Math.random() * (hi - lo));
}

// Promise-based sleep. Coerces ms to a non-negative integer.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));
}

// Deterministic 53-bit hash (cyrb53), used to mint a stable session_external_id
// from a string tuple. Output fits in a JS Number and a SQLite/Postgres
// INTEGER/BIGINT (up to 2^53 - 1). NOTE: src/db.js keeps an intentional mirror
// copy of this algorithm — any change here must be mirrored there.
function hashSessionExternalId(input) {
  const text = String(input || '');
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

module.exports = { jitter, sleep, hashSessionExternalId };
