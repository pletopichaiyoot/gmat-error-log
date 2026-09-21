// Table Analysis on the real exam sorts its data table from a "Sort by"
// dropdown — one entry per column, ascending only — not by clicking the
// headers the way GMAT Club's own page does. Reproducing that is the point:
// sorting IS the work on a TA question, so a review that shows the table
// frozen in its printed order is not showing the question.
//
// This module holds only the ordering rule, which is where the judgement is.
// A column is sorted numerically when EVERY cell in it reads as a number, and
// alphabetically otherwise — a single "n/a" in a column of figures would
// otherwise put 100 before 2. The comparison is stable on the original row
// order, so equal cells keep the order the table was printed in.

// Cells arrive as printed: "1,200", "€4,500", "-3.5%", "0.82". Strip the
// thousands separators and the unit, then read what is left as a number.
// Returns null when the cell has no digits at all, which is what makes a
// column with one "n/a" sort as text.
export function stimulusCellNumber(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const cleaned = text.replace(/[\s,]/g, '').replace(/[^0-9.eE+-]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

// Given one column's cells as printed, return the row indices in sorted order.
// Callers reorder their own rows by the returned indices.
export function stimulusSortOrder(values) {
  const cells = Array.isArray(values) ? values : [];
  const numbers = cells.map(stimulusCellNumber);
  const numeric = cells.length > 0 && numbers.every((n) => n !== null);
  return cells
    .map((text, index) => index)
    .sort((a, b) => {
      const diff = numeric
        ? numbers[a] - numbers[b]
        : String(cells[a] ?? '').localeCompare(String(cells[b] ?? ''), undefined, { numeric: true, sensitivity: 'base' });
      return diff || a - b;
    });
}
