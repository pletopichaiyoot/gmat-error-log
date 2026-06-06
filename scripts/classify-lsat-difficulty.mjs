import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import {
  parseArgs, collectTargets, buildBatches, buildPromptPayload,
  extractText, parseModelResponse, applyLabels,
} from './classify-lsat-difficulty.core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANK_PATH = path.join(__dirname, '..', 'data', 'lsat-questions.json');
const TMP_DIR = path.join(__dirname, '..', 'tmp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildModel(model) {
  const apiKey = (process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '').trim();
  if (!apiKey) {
    console.error('ERROR: missing OPENAI_API_KEY (or LLM_API_KEY) in .env');
    process.exit(1);
  }
  const base = (process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL || '').trim();
  return new ChatOpenAI({
    model,
    apiKey,
    maxRetries: 2,
    useResponsesApi: false,
    ...(base ? { configuration: { baseURL: base } } : {}),
  });
}

async function classifyBatch(client, batch) {
  const { system, user } = buildPromptPayload(batch);
  const expected = batch.entries.map((e) => e.number);
  for (let attempt = 1; attempt <= 2; attempt++) {
    let text = '';
    try {
      const resp = await client.invoke([new SystemMessage(system), new HumanMessage(user)]);
      text = extractText(resp);
    } catch (e) {
      if (attempt === 2) return { labels: new Map(), errors: [`model error: ${e.message}`] };
      await sleep(1500);
      continue;
    }
    const parsed = parseModelResponse(text, expected);
    if (parsed.labels.size > 0) return parsed;
    if (attempt === 2) return { labels: parsed.labels, errors: parsed.errors.length ? parsed.errors : ['empty result'] };
    await sleep(1500);
  }
  return { labels: new Map(), errors: ['unreachable'] };
}

function backupOnce(state) {
  if (state.backedUp) return;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dest = `${BANK_PATH}.bak-difficulty-${stamp}`;
  fs.copyFileSync(BANK_PATH, dest);
  state.backedUp = dest;
  console.log(`\nBacked up bank -> ${path.basename(dest)}`);
}

function flush(bank) {
  fs.writeFileSync(BANK_PATH, JSON.stringify(bank, null, 2));
}

function writeReview(scope, rows) {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const out = path.join(TMP_DIR, `lsat-difficulty-review-${scope}.md`);
  const lines = ['| test | sec | kind | # | difficulty | reason | stem |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const stem = String(r.stem || '').replace(/\s+/g, ' ').slice(0, 60).replace(/\|/g, '/');
    const reason = String(r.reason || '').replace(/\s+/g, ' ').replace(/\|/g, '/');
    lines.push(`| ${r.testNum} | ${r.roman} | ${r.kind} | ${r.number} | ${r.difficulty} | ${reason} | ${stem} |`);
  }
  fs.writeFileSync(out, lines.join('\n'));
  console.log(`Review report -> ${out}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = args.model || process.env.LSAT_DIFFICULTY_MODEL || 'gpt-5-nano';
  const bank = JSON.parse(fs.readFileSync(BANK_PATH, 'utf8'));

  const targets = collectTargets(bank, { test: args.test, force: args.force, limit: args.limit });
  if (targets.length === 0) {
    console.log('Nothing to classify (already labeled? pass --force, or check --test).');
    return;
  }
  const batches = buildBatches(targets, { lrBatchSize: 15 });
  console.log(`Model: ${model} | targets: ${targets.length} | batches: ${batches.length}${args.dryRun ? ' | DRY RUN (no write)' : ''}`);

  const client = buildModel(model);
  const state = { backedUp: null };
  const reviewRows = [];
  let applied = 0, missing = 0, done = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const { labels, errors } = await classifyBatch(client, batch);
    const res = applyLabels(batch, labels, model);
    applied += res.applied;
    missing += res.missing.length;
    for (const e of batch.entries) {
      const lab = labels.get(e.number);
      reviewRows.push({
        testNum: batch.testNum, roman: batch.roman, kind: batch.kind, number: e.number,
        difficulty: lab ? lab.difficulty : 'MISSING', reason: lab ? lab.reason : (errors[0] || ''), stem: e.stem,
      });
    }
    if (errors.length) {
      console.warn(`\n  batch ${i + 1}/${batches.length} (${batch.kind} t${batch.testNum} ${batch.roman}) issues: ${errors.slice(0, 3).join('; ')}`);
    }
    if (!args.dryRun && res.applied > 0) {
      backupOnce(state);
      flush(bank);
    }
    done++;
    process.stdout.write(`\r  progress: ${done}/${batches.length} batches | labeled ${applied} | missing ${missing}   `);
    await sleep(400);
  }
  process.stdout.write('\n');

  const scope = args.test != null ? `test-${args.test}` : 'all';
  writeReview(scope, reviewRows);
  console.log(`Done. labeled=${applied}, missing=${missing}${args.dryRun ? ' (DRY RUN — bank NOT written)' : `, bank written${state.backedUp ? `, backup=${path.basename(state.backedUp)}` : ''}`}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
