import React from 'react';

// Render an LSAT-style reading passage.
//
// When `lines` is present — the structured [{ n, marker, text, para }] array the
// PDF-geometry extractor writes (scripts/extract-lsat-passages.py) — we reproduce the
// real test booklet's left-gutter line numbering: every fifth source line shows its
// marker (5, 10, 15…) in a reserved gutter, and the passage keeps the source's hard
// line breaks so a question reference like "lines 15-20" maps to exactly the lines
// shown. Otherwise we fall back to paragraph-split flowing text (older data, extraction
// gaps, or non-LSAT passages that only carry a flat string).
//
// Layout-only and skin-neutral: the gutter number color comes from the inherited
// `--passage-gutter-color` CSS var, so the teal LSAT player and the warm-paper main
// review modal each style it from their own palette without this component carrying one.

// Mirror of splitPassageParagraphs in App.jsx: split on blank lines, drop a leading
// "Passage:" label, collapse intra-paragraph whitespace so each <p> wraps cleanly.
function splitParagraphs(value) {
  return String(value || '')
    .replace(/^\s*passage\s*:\s*/i, '')
    .split(/\n{2,}/)
    .map((para) => para.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export default function PassageLines({ lines, text, className = '' }) {
  if (Array.isArray(lines) && lines.length) {
    return (
      <div className={`passage-lines ${className}`.trim()}>
        {lines.map((ln, i) => (
          <div
            key={ln?.n ?? i}
            className={`passage-line${ln?.para ? ' is-para' : ''}`}
          >
            {/* aria-hidden: the gutter number is a visual lookup aid, not prose — keep
                the passage reading as continuous text for screen readers. */}
            <span className="passage-line-num" aria-hidden="true">
              {ln?.marker != null ? ln.marker : ''}
            </span>
            <span className="passage-line-text">{ln?.text ?? ''}</span>
          </div>
        ))}
      </div>
    );
  }

  const paras = splitParagraphs(text);
  if (!paras.length) return null;
  return (
    <div className={`passage-lines passage-lines-flow ${className}`.trim()}>
      {paras.map((para, idx) => (
        <p key={`p-${idx}`}>{para}</p>
      ))}
    </div>
  );
}
