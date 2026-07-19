import Sparkline from './Sparkline';

// At-a-glance overview header. Sanctioned scoreboard moment (Display type).
// delta: rising = green, declining = brass-ink (Two-Voice Rule) — never red.
export default function HeroBand({ overall = 0, delta = null, series = [], weakest = null, onDrill }) {
  const pct = Math.max(0, Math.min(100, Number(overall) || 0));
  const rising = delta != null && delta > 0;
  const deltaClass = delta == null ? '' : rising ? 'hero-delta--up' : delta < 0 ? 'hero-delta--down' : 'hero-delta--flat';
  const deltaText = delta == null ? '' : `${rising ? '▲' : delta < 0 ? '▼' : '='} ${Math.abs(delta).toFixed(1)}`;
  return (
    <div className="hero-band">
      <div className="hero-metric">
        <span className="hero-eyebrow">Overall accuracy</span>
        <div className="hero-metric-row">
          <strong className="hero-value">{pct.toFixed(1)}%</strong>
          {delta != null && <span className={`hero-delta ${deltaClass}`}>{deltaText}</span>}
        </div>
      </div>
      <div className="hero-trend">
        <span className="hero-eyebrow">Recent trend</span>
        <Sparkline points={series} width={140} height={34} ariaLabel="recent accuracy trend" />
      </div>
      {weakest && (
        <div className="hero-weakness">
          <span className="hero-eyebrow">Weakest area</span>
          <div className="hero-weakness-body">
            <span className="hero-weakness-label">{weakest.subject} · {weakest.category}</span>
            <span className="hero-weakness-pct">{Number(weakest.accuracy).toFixed(1)}%</span>
          </div>
          <button type="button" className="hero-drill" onClick={onDrill}>Drill this →</button>
        </div>
      )}
    </div>
  );
}
