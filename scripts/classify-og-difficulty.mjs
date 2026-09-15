#!/usr/bin/env node
// Rate the difficulty of the usable OG questions with one offline LLM pass.
//
//   node scripts/classify-og-difficulty.mjs --limit 30   # a slice first
//   node scripts/classify-og-difficulty.mjs              # everything unrated
//   node scripts/classify-og-difficulty.mjs --force      # re-rate
//
// Progress is flushed as it goes, so an interrupted run keeps what it rated.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import {
  collectTargets, buildBatches, buildPromptPayload,
  extractText, parseModelResponse, applyLabels,
} from './classify-og-difficulty.core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POOL = path.join(__dirname, '..', 'data', 'gmat-og-questions.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const opts = {
  book: arg('--book'),
  kind: arg('--kind'),
  limit: arg('--limit'),
  force: process.argv.includes('--force'),
};
const dryRun = process.argv.includes('--dry-run');
// Same default as the LSAT rater, so both tracks are calibrated alike.
const MODEL = arg('--model') || process.env.OG_DIFFICULTY_MODEL || 'gpt-5-mini';

function buildModel() {
  const apiKey = (process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '').trim();
  if (!apiKey) {
    console.error('ERROR: missing OPENAI_API_KEY (or LLM_API_KEY) in .env');
    process.exit(1);
  }
  const base = (process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL || '').trim();
  return new ChatOpenAI({
    model: MODEL, apiKey, maxRetries: 2, useResponsesApi: false,
    ...(base ? { configuration: { baseURL: base } } : {}),
  });
}

async function classifyBatch(client, batch) {
  const { system, user } = buildPromptPayload(batch);
  const expected = batch.entries.map(e => e.number);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await client.invoke([new SystemMessage(system), new HumanMessage(user)]);
      const parsed = parseModelResponse(extractText(resp), expected);
      if (parsed.labels.size > 0) return parsed;
      if (attempt === 2) return parsed;
    } catch (err) {
      if (attempt === 2) return { labels: new Map(), errors: [`model error: ${err.message}`] };
    }
    await sleep(1500);
  }
  return { labels: new Map(), errors: ['unreachable'] };
}

const pool = JSON.parse(fs.readFileSync(POOL, 'utf-8'));
const targets = collectTargets(pool, opts);
const batches = buildBatches(targets);
console.log(`${targets.length} questions to rate in ${batches.length} batches (model ${MODEL}).`);
if (dryRun || targets.length === 0) {
  if (!targets.length) console.log('Nothing to do.');
  process.exit(0);
}

const client = buildModel();
let backedUp = false;
let applied = 0;
const failures = [];

const flush = () => {
  if (!backedUp) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    fs.copyFileSync(POOL, `${POOL}.bak-difficulty-${stamp}`);
    backedUp = true;
  }
  fs.writeFileSync(POOL, JSON.stringify(pool, null, 1));
};

for (const [i, batch] of batches.entries()) {
  const { labels, errors } = await classifyBatch(client, batch);
  const res = applyLabels(batch, labels, MODEL);
  applied += res.applied;
  if (res.missing.length) failures.push(...res.missing);
  if (errors.length) console.warn(`  batch ${i + 1}: ${errors.slice(0, 2).join('; ')}`);
  process.stdout.write(`\r  ${i + 1}/${batches.length} batches, ${applied} rated`);
  if ((i + 1) % 5 === 0) flush();
}
flush();

const spread = {};
for (const b of pool.books) {
  for (const s of b.sections) {
    for (const q of s.questions) {
      if (q.usable && q.difficulty) spread[q.difficulty] = (spread[q.difficulty] || 0) + 1;
    }
  }
}
console.log(`\n\nrated ${applied}; spread ${JSON.stringify(spread)}`);
if (failures.length) console.log(`unrated: ${failures.length} (${failures.slice(0, 6).join(', ')})`);
