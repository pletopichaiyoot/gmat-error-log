import MiniBar from './MiniBar';

const BAND_COLOR = { hard: 'var(--danger)', medium: 'var(--accent-ink)', easy: 'var(--primary)' };
const BAND_LABEL = { hard: 'Hard', medium: 'Medium', easy: 'Easy' };

// Subject × difficulty accuracy grid. data = [{ subject, cells: [{band,total,accuracy|null}] }].
export default function DifficultyMatrix({ data = [] }) {
  const hasAny = data.some((r) => r.cells.some((c) => c.accuracy != null));
  if (!hasAny) {
    return <p className="muted diffmatrix-empty">Sync practice sessions to see accuracy by difficulty.</p>;
  }
  return (
    <div className="diffmatrix" role="table" aria-label="Accuracy by difficulty per subject">
      <div className="diffmatrix-row diffmatrix-head" role="row">
        <span className="diffmatrix-corner" role="columnheader" />
        {['hard', 'medium', 'easy'].map((b) => (
          <span key={b} className="diffmatrix-colhead" role="columnheader">{BAND_LABEL[b]}</span>
        ))}
      </div>
      {data.map((row) => (
        <div key={row.subject} className="diffmatrix-row" role="row">
          <span className="diffmatrix-subject" role="rowheader">{row.subject}</span>
          {row.cells.map((cell) => (
            <div key={cell.band} className="diffmatrix-cell" role="cell">
              {cell.accuracy == null ? (
                <span className="diffmatrix-na">—</span>
              ) : (
                <>
                  <span className="diffmatrix-pct">{cell.accuracy.toFixed(1)}%</span>
                  <MiniBar value={cell.accuracy} color={BAND_COLOR[cell.band]} />
                </>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
