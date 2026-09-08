#!/usr/bin/env node
'use strict';

// Harvest StartTest's searchable Item IDs for one (or every) practice book and
// cache them on question_attempts.search_item_id.
//
//   node scripts/harvest-starttest-item-ids.js                 # every book
//   node scripts/harvest-starttest-item-ids.js og-main-2024-2025 [more ids...]
//
// Needs the user's logged-in starttest.com tab in the CDP Chrome (port 9222) —
// same prerequisite as a scrape. Drives the book's own Search panel only; it
// never takes items or closes the browser.

require('dotenv').config();

const { STARTTEST_SOURCE_PRODUCTS, runStartTestSearchHarvestFromOpenBrowser } = require('../src/scraper-runner');
const { applyStartTestSearchItemIds, closePool } = require('../src/db');

async function main() {
  const flags = process.argv.slice(2).filter((a) => a.startsWith('-'));
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  // --seeds-only: two keyword searches, no id sweep. Run this first after a
  // fresh sign-in to confirm the session works before spending ~15 searches.
  const seedsOnly = flags.includes('--seeds-only');
  const sourceIds = requested.length ? requested : Object.keys(STARTTEST_SOURCE_PRODUCTS);

  const unknown = sourceIds.filter((id) => !STARTTEST_SOURCE_PRODUCTS[id]);
  if (unknown.length) {
    console.error(`Unknown source id(s): ${unknown.join(', ')}`);
    console.error(`Known: ${Object.keys(STARTTEST_SOURCE_PRODUCTS).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  for (const sourceId of sourceIds) {
    const preset = STARTTEST_SOURCE_PRODUCTS[sourceId];
    console.log(`\n=== ${sourceId} — ${preset.label}`);
    try {
      const harvest = await runStartTestSearchHarvestFromOpenBrowser({
        sourceId,
        seedsOnly,
        onProgress: (evt) => console.log(
          `  ${evt.event}${evt.word ? ` "${evt.word}"` : ''}${evt.start ? ` @${evt.start}` : ''}`
          + (evt.event === 'searching' ? '' : ` rows=${evt.rows} new=${evt.added} total=${evt.total}`)
        ),
      });
      const applied = await applyStartTestSearchItemIds({
        source: preset.label,
        searchRows: harvest.rows,
      });
      console.log(
        `  harvested ${harvest.stats.items} item ids in ${harvest.stats.searches} searches`
        + ` → matched ${applied.matched}/${applied.attempts} attempts`
        + ` (updated ${applied.updated}, ambiguous ${applied.ambiguous})`
      );
    } catch (error) {
      console.error(`  FAILED: ${error?.message || error}`);
      process.exitCode = 1;
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
