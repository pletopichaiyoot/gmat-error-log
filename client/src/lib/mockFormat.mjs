// Format a mock's date (scraped = full ISO, manual = YYYY-MM-DD) as date-only.
export function formatMockDate(value) {
  const s = String(value ?? '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  const [, y, mo, d] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(dt.getTime())) return s;
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
