// Tiny inline SVG trend line. Pure/presentational. points: oldest→newest.
export default function Sparkline({
  points = [], width = 96, height = 28,
  stroke = 'var(--primary)', strokeWidth = 1.5,
  ariaLabel = 'trend', className = '',
}) {
  const clean = (points || []).filter((n) => Number.isFinite(n));
  if (clean.length < 2) {
    return <span className={`sparkline sparkline--empty ${className}`} aria-label={`${ariaLabel}: not enough data`}>—</span>;
  }
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;
  const pad = strokeWidth + 1;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const step = innerW / (clean.length - 1);
  const coords = clean.map((v, i) => [pad + i * step, pad + innerH - ((v - min) / range) * innerH]);
  const d = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = coords[coords.length - 1];
  return (
    <svg className={`sparkline ${className}`} width={width} height={height}
         viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} preserveAspectRatio="none">
      <path className="sparkline-path" d={d} fill="none" stroke={stroke}
            strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={strokeWidth + 0.5} fill={stroke} />
    </svg>
  );
}
