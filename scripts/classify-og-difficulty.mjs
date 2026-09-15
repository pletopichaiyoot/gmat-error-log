#!/usr/bin/env node
// Rate the difficulty of the usable OG questions with one offline LLM pass.
//
//   node scripts/classify-og-difficulty.mjs --limit 30    # a slice first
//   node scripts/classify-og-difficulty.mjs               # everything unrated
//   node scripts/classify-og-difficulty.mjs --force       # re-rate
//   node scripts/classify-og-difficulty.mjs --effort high # more reasoning
//   node scripts/classify-og-difficulty.mjs --relabel     # re-bucket, no API
//
// Uses the OpenAI Responses API directly rather than through LangChain: this
// needs reasoning.effort and a strict JSON schema, both of which the endpoint
// exposes plainly, and a guaranteed response shape removes the repair code the
// previous free-text version needed. Progress is flushed as it goes, so an
// interrupted run keeps what it rated.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectTargets, buildBatches, buildUserMessage, parseRatings, applyRatings,
  relabelPool, OG_SYSTEM_PROMPT, RESPONSE_SCHEMA,
} from './classify-og-difficulty.core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POOL = path.join(__dirname, '..', 'data', 'gmat-og-questions.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const opts = {
  book: arg('--book'), kind: arg('--kind'), limit: arg('--limit'),
  force: process.argv.includes('--force'),
};
const dryRun = process.argv.includes('--dry-run');
const MODEL = arg('--model') || process.env.OG_DIFFICULTY_MODEL || 'gpt-5.6-luna';
const EFFORT = arg('--effort') || 'medium';

const pool = JSON.parse(fs.readFileSync(POOL, 'utf-8'));

if (process.argv.includes('--relabel')) {
  const { labelled, cuts } = relabelPool(pool);
  fs.writeFileSync(POOL, JSON.stringify(pool, null, 1));
  console.log(`re-bucketed ${labelled} questions; tertile cuts ${JSON.stringify(cuts)}`);
  process.exit(0);
}

const API_KEY = (process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '').trim();
const BASE = (process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
  .replace(/\/+$/, '');

async function rateBatch(batch) {
  const body = {
    model: MODEL,
    reasoning: { effort: EFFORT },
    input: [
      { role: 'system', content: OG_SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(batch) },
    ],
    text: {
      format: {
        type: 'json_schema', name: 'og_difficulty', strict: true, schema: RESPONSE_SCHEMA,
      },
    },
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text();
        if (attempt === 3) return { ratings: new Map(), errors: [`HTTP ${res.status}: ${detail.slice(0, 160)}`] };
        await sleep(1500 * attempt);
        continue;
      }
      const json = await res.json();
      const text = (json.output || [])
        .flatMap(o => o.content || []).map(c => c.text).filter(Boolean).join('');
      return parseRatings(JSON.parse(text), batch.entries.map(e => e.number));
    } catch (err) {
      if (attempt === 3) return { ratings: new Map(), errors: [`request failed: ${err.message}`] };
      await sleep(1500 * attempt);
    }
  }
  return { ratings: new Map(), errors: ['unreachable'] };
}

const targets = collectTargets(pool, opts);
const batches = buildBatches(targets);
console.log(`${targets.length} questions in ${batches.length} batches (${MODEL}, effort ${EFFORT}).`);
if (dryRun || targets.length === 0) {
  if (!targets.length) console.log('Nothing to do.');
  process.exit(0);
}
if (!API_KEY) {
  console.error('ERROR: missing OPENAI_API_KEY (or LLM_API_KEY) in .env');
  process.exit(1);
}

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

// A few batches in flight at once; the pass is otherwise latency-bound.
const CONCURRENCY = 4;
for (let i = 0; i < batches.length; i += CONCURRENCY) {
  const slice = batches.slice(i, i + CONCURRENCY);
  const results = await Promise.all(slice.map(b => rateBatch(b)));
  results.forEach((r, j) => {
    if (r.errors.length) console.warn(`\n  batch ${i + j + 1}: ${r.errors.slice(0, 2).join('; ')}`);
    const res = applyRatings(slice[j], r.ratings, MODEL);
    applied += res.applied;
    failures.push(...res.missing);
  });
  flush();
  process.stdout.write(`\r  ${Math.min(i + CONCURRENCY, batches.length)}/${batches.length} batches, ${applied} rated`);
}
// Labels are tertiles within a subject, so they can only be assigned once the
// whole pass is in.
const { cuts } = relabelPool(pool);
flush();
console.log(`\n  tertile cuts ${JSON.stringify(cuts)}`);

const spread = {};
const pcts = [];
for (const b of pool.books) {
  for (const s of b.sections) {
    for (const q of s.questions) {
      if (q.usable && q.difficulty) spread[q.difficulty] = (spread[q.difficulty] || 0) + 1;
      if (Number.isFinite(q.difficulty_pct)) pcts.push(q.difficulty_pct);
    }
  }
}
pcts.sort((a, b) => a - b);
console.log(`\n\nrated ${applied}; spread ${JSON.stringify(spread)}`);
if (pcts.length) {
  console.log(`pctCorrect: min ${pcts[0]}, median ${pcts[Math.floor(pcts.length / 2)]}, max ${pcts[pcts.length - 1]}`);
}
if (failures.length) console.log(`unrated: ${failures.length} (${failures.slice(0, 6).join(', ')})`);
