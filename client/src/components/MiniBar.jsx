// Thin horizontal accuracy bar for dense table cells. Pure/presentational.
export default function MiniBar({ value = 0, color = 'var(--primary)', className = '' }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <span className={`minibar ${className}`} role="img" aria-label={`${pct.toFixed(0)} percent`}>
      <span className="minibar-fill" style={{ width: `${pct}%`, background: color }} />
    </span>
  );
}
