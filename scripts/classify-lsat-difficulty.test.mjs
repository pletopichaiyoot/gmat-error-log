import assert from 'node:assert/strict';
import {
  parseArgs, collectTargets, buildBatches, parseModelResponse,
  applyLabels, extractText, resolvePassage, VALID_LABELS,
} from './classify-lsat-difficulty.core.mjs';

const fixture = () => ({
  tests: [
    {
      num: 1,
      sections: [
        {
          roman: 'I', kind: 'RC', passage: 'PASSAGE TEXT', passages: [],
          questions: [
            { number: 1, stem: 'rc q1', choices: [{ label: 'A', text: 'a' }], correct: 'A' },
            { number: 2, stem: 'rc q2', choices: [{ label: 'A', text: 'a' }], correct: 'A', difficulty: 'Hard' },
          ],
        },
        {
          roman: 'III', kind: 'LR', passage: null, passages: [],
          questions: Array.from({ length: 18 }, (_, i) => ({
            number: i + 1, stem: 'lr ' + (i + 1), choices: [{ label: 'A', text: 'a' }], correct: 'A',
          })),
        },
      ],
    },
    {
      num: 2,
      sections: [{ roman: 'I', kind: 'AR', passages: [], questions: [{ number: 1, stem: 'ar', choices: [], correct: 'A' }] }],
    },
  ],
});

// parseArgs
{
  const a = parseArgs(['--test', '1', '--limit', '5', '--force', '--dry-run', '--model', 'gpt-x']);
  assert.equal(a.test, 1);
  assert.equal(a.limit, 5);
  assert.equal(a.force, true);
  assert.equal(a.dryRun, true);
  assert.equal(a.model, 'gpt-x');
  const b = parseArgs([]);
  assert.equal(b.test, null);
  assert.equal(b.force, false);
  assert.equal(b.dryRun, false);
}

// collectTargets: skips already-labeled (q2) and AR section
{
  const t = collectTargets(fixture(), {});
  assert.equal(t.length, 19); // RC q1 + 18 LR; RC q2 skipped (labeled); AR excluded
  assert.ok(t.every((x) => x.kind === 'RC' || x.kind === 'LR'));
  assert.equal(t.find((x) => x.kind === 'RC').passageText, 'PASSAGE TEXT');
}
// collectTargets force re-includes labeled
{
  assert.equal(collectTargets(fixture(), { force: true }).length, 20);
}
// collectTargets test filter + limit
{
  assert.equal(collectTargets(fixture(), { test: 2 }).length, 0); // test 2 is AR-only
  assert.equal(collectTargets(fixture(), { limit: 3 }).length, 3);
}

// buildBatches: RC grouped to 1 batch; LR 18 -> 2 batches (15 + 3)
{
  const t = collectTargets(fixture(), { force: true });
  const b = buildBatches(t, { lrBatchSize: 15 });
  const rc = b.filter((x) => x.kind === 'RC');
  const lr = b.filter((x) => x.kind === 'LR');
  assert.equal(rc.length, 1);
  assert.equal(rc[0].entries.length, 2);
  assert.equal(rc[0].passageText, 'PASSAGE TEXT');
  assert.equal(lr.length, 2);
  assert.equal(lr[0].entries.length, 15);
  assert.equal(lr[1].entries.length, 3);
}

// parseModelResponse: normalizes case, rejects bad label + unknown number, handles fences
{
  const r = parseModelResponse(
    '```json\n[{"number":1,"difficulty":"hard","reason":"x"},{"number":2,"difficulty":"Nope"},{"number":9,"difficulty":"Easy"}]\n```',
    [1, 2],
  );
  assert.equal(r.labels.get(1).difficulty, 'Hard');
  assert.ok(!r.labels.has(2));
  assert.ok(!r.labels.has(9));
  assert.ok(r.errors.length >= 2);
}
{
  const r = parseModelResponse('total garbage', [1]);
  assert.equal(r.labels.size, 0);
  assert.ok(r.errors.length >= 1);
}

// applyLabels mutates the live question object + reports missing
{
  const t = collectTargets(fixture(), { force: true });
  const batch = buildBatches(t)[0];
  const labels = new Map([[batch.entries[0].number, { difficulty: 'Medium', reason: 'r' }]]);
  const res = applyLabels(batch, labels, 'gpt-5-nano');
  assert.equal(batch.entries[0].q.difficulty, 'Medium');
  assert.equal(batch.entries[0].q.difficulty_source, 'gpt-5-nano');
  assert.equal(res.applied, 1);
  assert.ok(res.missing.length >= 1);
}

// extractText: string and content-part array
{
  assert.equal(extractText({ content: 'hi' }), 'hi');
  assert.equal(extractText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab');
  assert.equal(extractText({}), '');
}

// resolvePassage: largest firstQuestion <= number
{
  const sec = { passages: [{ firstQuestion: 1, text: 'P1' }, { firstQuestion: 5, text: 'P2' }] };
  assert.equal(resolvePassage(sec, 3), 'P1');
  assert.equal(resolvePassage(sec, 6), 'P2');
  assert.equal(resolvePassage({ passage: 'SOLO', passages: [] }, 1), 'SOLO');
}

assert.deepEqual(VALID_LABELS, ['Easy', 'Medium', 'Hard']);
console.log('All LSAT difficulty core tests passed.');
