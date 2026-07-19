// Small circular progress indicator. Pure/presentational.
export default function ProgressRing({ value = 0, total = 0, size = 44, stroke = 5, className = '' }) {
  const pct = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct);
  const mid = size / 2;
  return (
    <svg className={`progress-ring ${className}`} width={size} height={size}
         viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${value} of ${total} done`}>
      <circle cx={mid} cy={mid} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
      <circle className="progress-ring-arc" cx={mid} cy={mid} r={r} fill="none"
              stroke="var(--primary)" strokeWidth={stroke} strokeLinecap="round"
              strokeDasharray={c} strokeDashoffset={offset}
              transform={`rotate(-90 ${mid} ${mid})`} />
    </svg>
  );
}
