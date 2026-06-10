#!/usr/bin/env node
/*
 * One-off backfill: re-derive my_answer / correct_answer for OPE matrix (TPA, MSR)
 * and dropdown (GI) question_attempts using the per-choice flags already stored
 * in answer_choices JSON. No browser interaction required.
 *
 * Run:
 *   node scripts/backfill-ope-matrix-format.js            # all OPE sessions
 *   node scripts/backfill-ope-matrix-format.js --session 250
 *   node scripts/backfill-ope-matrix-format.js --dry-run  # show changes, don't write
 *
 * Identification:
 *   - matrix rows: answer_choices entries have value matching /^\d+:\d+$/
 *   - dropdown rows: answer_choices entries have value matching /^\d+:.+/
 *     (dropdown values aren't always numeric)
 */
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.GMAT_DB_PATH
  || path.join(__dirname, '..', 'data', 'gmat-error-log.db');

const args = process.argv.slice(2);
const sessionFilter = (() => {
  const i = args.indexOf('--session');
  return i >= 0 ? Number(args[i + 1]) : null;
})();
const dryRun = args.includes('--dry-run');

const db = new sqlite3.Database(DB_PATH);
const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});
const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function cb(err) { return err ? reject(err) : resolve(this); });
});

function deriveFromMatrixChoices(choices) {
  // Two paths:
  //   - value field present (new scrapes): "rowIdx+1:colIdx+1"
  //   - value missing (existing DB rows): parse label "rowLabel=colHeader"
  //     and assign indices by first-seen order.
  const cells = [];
  let maxRow = 0;
  let maxCol = 0;
  const rowLabelToIdx = new Map();
  const colHeaderToIdx = new Map();
  for (const c of choices) {
    const parts = String(c.label || '').split('=');
    if (parts.length < 2) return null;
    const rowLabel = parts[0].trim();
    const colHeader = parts.slice(1).join('=').trim();
    if (!rowLabel || !colHeader) return null;
    let rowIdx;
    let colIdx;
    const m = String(c.value || '').match(/^(\d+):(\d+)$/);
    if (m) {
      rowIdx = Number(m[1]) - 1;
      colIdx = Number(m[2]) - 1;
    } else {
      if (!rowLabelToIdx.has(rowLabel)) rowLabelToIdx.set(rowLabel, rowLabelToIdx.size);
      if (!colHeaderToIdx.has(colHeader)) colHeaderToIdx.set(colHeader, colHeaderToIdx.size);
      rowIdx = rowLabelToIdx.get(rowLabel);
      colIdx = colHeaderToIdx.get(colHeader);
    }
    maxRow = Math.max(maxRow, rowIdx);
    maxCol = Math.max(maxCol, colIdx);
    cells.push({
      rowIdx, colIdx,
      rowLabel,
      colHeader,
      isCorrect: !!c.isCorrect,
      isUserSelected: !!c.isUserSelected,
    });
  }
  const rowCount = maxRow + 1;
  const colCount = maxCol + 1;
  const rowLabels = Array(rowCount).fill('').map((_, i) => `row${i + 1}`);
  const headers = Array(colCount).fill('').map((_, i) => `col${i + 1}`);
  const grid = Array(rowCount).fill(null).map(() => Array(colCount).fill(null));
  for (const c of cells) {
    rowLabels[c.rowIdx] = c.rowLabel;
    headers[c.colIdx] = c.colHeader;
    grid[c.rowIdx][c.colIdx] = { isCorrect: c.isCorrect, isUserSelected: c.isUserSelected };
  }
  const correctPerRow = grid.map((row) => row.filter((cell) => cell && cell.isCorrect).length);
  const correctPerCol = headers.map((_, colIdx) => grid.reduce((acc, row) => acc + (row[colIdx]?.isCorrect ? 1 : 0), 0));
  const rowsWithOne = correctPerRow.filter((n) => n === 1).length;
  const colsWithOne = correctPerCol.filter((n) => n === 1).length;
  const axis = (colsWithOne >= rowsWithOne) ? 'col' : 'row';

  const formatAlongAxis = (predicate) => {
    if (axis === 'col') {
      return headers.map((colHeader, colIdx) => {
        const rowIdx = grid.findIndex((row) => predicate(row[colIdx]));
        return `${colHeader}: ${rowIdx >= 0 ? rowLabels[rowIdx] : '—'}`;
      }).join(' | ');
    }
    return rowLabels.map((rowLabel, rowIdx) => {
      const colIdx = (grid[rowIdx] || []).findIndex(predicate);
      return `${rowLabel}: ${colIdx >= 0 ? headers[colIdx] : '—'}`;
    }).join(' | ');
  };

  const anyUser = grid.some((row) => row.some((c) => c && c.isUserSelected));
  const anyCorrect = grid.some((row) => row.some((c) => c && c.isCorrect));
  return {
    type: 'matrix',
    axis,
    my_answer: anyUser ? formatAlongAxis((c) => c && c.isUserSelected) : null,
    correct_answer: anyCorrect ? formatAlongAxis((c) => c && c.isCorrect) : null,
  };
}

function deriveFromDropdownChoices(choices) {
  const groups = {};
  for (const c of choices) {
    const m = String(c.value || '').match(/^(\d+):(.+)$/);
    if (!m) return null;
    const ddIdx = Number(m[1]);
    if (!groups[ddIdx]) groups[ddIdx] = [];
    const text = String(c.label || '').split('=').slice(1).join('=').trim() || String(c.text || '');
    groups[ddIdx].push({ optValue: m[2], text, isCorrect: !!c.isCorrect, isUserSelected: !!c.isUserSelected });
  }
  const indices = Object.keys(groups).map(Number).sort((a, b) => a - b);
  if (!indices.length) return null;
  const userPicks = [];
  const correctPicks = [];
  let anyCorrect = false;
  for (const idx of indices) {
    const opts = groups[idx];
    const user = opts.find((o) => o.isUserSelected);
    const correct = opts.find((o) => o.isCorrect);
    if (correct) anyCorrect = true;
    userPicks.push(user ? user.text : '—');
    correctPicks.push(correct ? correct.text : '—');
  }
  return {
    type: 'dropdown',
    my_answer: userPicks.some((s) => s && s !== '—') ? userPicks.join(' | ') : null,
    correct_answer: anyCorrect ? correctPicks.join(' | ') : null,
  };
}

function classifyChoices(choices) {
  if (!Array.isArray(choices) || !choices.length) return null;
  // Prefer value-field signal (present on new scrapes); fall back to label shape.
  const valuesPresent = choices.some((c) => String(c.value || '').length > 0);
  if (valuesPresent) {
    const allMatrix = choices.every((c) => /^\d+:\d+$/.test(String(c.value || '')));
    if (allMatrix) return 'matrix';
    const allDropdown = choices.every((c) => /^\d+:.+/.test(String(c.value || '')));
    if (allDropdown) return 'dropdown';
    return null;
  }
  // Existing rows lack value. Use label patterns:
  //   - matrix: "rowLabel=colHeader" (no leading "dd<N>")
  //   - dropdown: "dd<N>=..."
  const allDropdownLabel = choices.every((c) => /^dd\d+=/.test(String(c.label || '')));
  if (allDropdownLabel) return 'dropdown';
  const allMatrixLabel = choices.every((c) => /=/.test(String(c.label || '')) && !/^dd\d+=/.test(String(c.label || '')));
  if (allMatrixLabel) return 'matrix';
  return null;
}

(async () => {
  try {
    const params = [];
    let where = "q.q_id LIKE 'ope-%' AND q.answer_choices IS NOT NULL AND q.answer_choices != ''";
    if (sessionFilter) { where += ' AND q.session_id = ?'; params.push(sessionFilter); }
    const rows = await all(
      `SELECT q.id, q.session_id, q.q_id, q.my_answer, q.correct_answer, q.answer_choices
       FROM question_attempts q WHERE ${where} ORDER BY q.session_id, q.q_id`,
      params,
    );

    let scanned = 0;
    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      scanned += 1;
      let choices;
      try { choices = JSON.parse(row.answer_choices); } catch { skipped += 1; continue; }
      const kind = classifyChoices(choices);
      if (!kind) { skipped += 1; continue; }
      const derived = kind === 'matrix'
        ? deriveFromMatrixChoices(choices)
        : deriveFromDropdownChoices(choices);
      if (!derived) { skipped += 1; continue; }
      const newMy = derived.my_answer;
      const newCorrect = derived.correct_answer;
      if (newMy === row.my_answer && newCorrect === row.correct_answer) continue;
      console.log(
        `[${row.q_id}] (${kind}${derived.axis ? '/' + derived.axis : ''})\n`
        + `   my:    ${JSON.stringify(row.my_answer)} -> ${JSON.stringify(newMy)}\n`
        + `   right: ${JSON.stringify(row.correct_answer)} -> ${JSON.stringify(newCorrect)}`,
      );
      if (!dryRun) {
        await run(
          'UPDATE question_attempts SET my_answer = ?, correct_answer = ? WHERE id = ?',
          [newMy, newCorrect, row.id],
        );
        updated += 1;
      }
    }
    console.log(`\nScanned ${scanned}, ${dryRun ? 'would update' : 'updated'} ${updated}, skipped ${skipped}`);
  } catch (err) {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  } finally {
    db.close();
  }
})();
