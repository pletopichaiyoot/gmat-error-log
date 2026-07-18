// OPE (GMAT Official Practice Exam) stem post-processing.
//
// Why this exists: OPE renders inline math — fractions, radicals, complex
// expressions, symbol tables — as inline raster <img> elements (base64 `data:`
// URIs) with NO alt text, plus simple exponents/subscripts as <sup>/<sub>, plus
// figure graphs as auth-only `itdmedia.aspx?...GID*.gif` images. There is no
// MathML and no alt text, so `document.body.innerText` silently drops the math —
// gutting Quant/DS stems ("If x2 > y2, then ", "...rate of  gallon per hour").
//
// The OPE scraper grabs `.ITSStemText` innerHTML (after removing the status icon
// and UI chrome page-side) and hands the raw HTML here. These pure string->string
// transforms (no DOM, unit-tested) then produce TWO outputs:
//   - sanitizeStemHtml(raw): a tight, render-safe HTML subset that KEEPS inline
//     `data:` equation images (they're self-contained and render anywhere) so the
//     review modal shows the actual math. Non-data figure images (itdmedia GID)
//     become a "[figure]" marker (they need the logged-in session to load).
//   - stemHtmlToText(html): a clean readable TEXT rendering for the LLM coach /
//     search / list previews — <sup>x</sup> -> ^x, <sub> -> _, equation images
//     -> "[math]". This is what lands in question_stem; the HTML goes in
//     question_stem_html.

const { decodeEntities } = require('./mathml-text');

// Tags we keep in the render-safe HTML. Everything else is unwrapped (children
// kept, tag dropped) — including the ACT XML-namespace wrappers OPE emits
// (<x_act_v1p2:format_flow>, <materialfont>, …) and the .ITSStemText chrome.
const ALLOWED_TAGS = new Set(['sup', 'sub', 'i', 'em', 'b', 'strong', 'br', 'p']);

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// raw: the cloned .ITSStemText innerHTML (status icon + chrome already removed
// page-side). Returns a tight HTML subset safe to render with the inline
// equation images preserved.
function sanitizeStemHtml(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw;

  // 1) Images: keep self-contained data: equation images (only their src);
  //    replace auth-only figure images (itdmedia GID etc.) with a [figure]
  //    marker; drop any leftover status/icon images (svg, CATALYST, the
  //    ReplacementUI chrome) entirely.
  s = s.replace(/<img\b([^>]*)\/?>/gi, (_m, attrs) => {
    const srcMatch = attrs.match(/\bsrc\s*=\s*"([^"]*)"/i) || attrs.match(/\bsrc\s*=\s*'([^']*)'/i);
    const src = srcMatch ? srcMatch[1] : '';
    if (/^data:image\//i.test(src)) return `<img src="${escapeAttr(src)}">`;
    if (/CATALYST|ReplacementUI|\.svg(?:\?|$|")/i.test(src)) return '';
    return ' [figure] ';
  });

  // 2) Tags: keep the allow-list (stripped of all attributes), unwrap the rest.
  s = s.replace(/<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g, (_m, slash, tag, selfClose) => {
    const t = tag.toLowerCase();
    if (t === 'img') return _m; // already normalized in step 1
    if (!ALLOWED_TAGS.has(t)) return '';
    if (t === 'br') return '<br>';
    if (selfClose) return `<${t}></${t}>`;
    return `<${slash}${t}>`;
  });

  // 3) Collapse runs of <br> and surrounding whitespace.
  s = s
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/(?:\s*<br>\s*){3,}/gi, '<br><br>')
    .replace(/\[figure\](?:\s*\[figure\])+/gi, '[figure]')
    .trim();
  return s;
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '');
}

// html: the output of sanitizeStemHtml. Produces a clean readable text stem.
function stemHtmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  let s = html;
  // Inline equation images -> [math] (sanitize guarantees any surviving <img>
  // is a self-contained data: equation image).
  s = s.replace(/<img\b[^>]*>/gi, ' [math] ');
  // Superscript / subscript -> ^x / _x (parenthesize multi-char payloads).
  s = s.replace(/<sup>([\s\S]*?)<\/sup>/gi, (_m, x) => { const t = decodeEntities(stripTags(x)).replace(/\s+/g, '').trim(); return t.length > 1 ? `^(${t})` : `^${t}`; });
  s = s.replace(/<sub>([\s\S]*?)<\/sub>/gi, (_m, x) => { const t = decodeEntities(stripTags(x)).replace(/\s+/g, '').trim(); return t.length > 1 ? `_(${t})` : `_${t}`; });
  // Line / paragraph breaks.
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p\s*>/gi, '\n');
  // Drop any remaining tags, decode entities.
  s = stripTags(s);
  s = decodeEntities(s);
  // Whitespace cleanup.
  s = s
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Drop trailing solution annotations if the container ever includes them.
  s = s.replace(/\n\s*(?:Comments?|Rationale|Key Point):[\s\S]*$/i, '').trim();
  return s;
}

// Allowlist for DI stimulus: prose + tables + inline SVG shapes + data: images.
const STIMULUS_ALLOWED_TAGS = new Set([
  'p', 'br', 'b', 'strong', 'i', 'em', 'sup', 'sub', 'span', 'div', 'h1', 'h2', 'h3', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'title', 'desc',
  'img',
]);
// SVG geometry/label attributes worth keeping; anything else is dropped.
const STIMULUS_ALLOWED_ATTRS = new Set([
  'class', 'colspan', 'rowspan', 'scope', 'aria-rowcount', 'border', 'style',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height',
  'd', 'points', 'transform', 'viewBox', 'fill', 'stroke', 'stroke-width', 'text-anchor', 'font-size', 'dominant-baseline',
]);

function sanitizeStimulusHtml(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let html = raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  // Drop <img> whose src is not a data: image entirely.
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = (tag.match(/\bsrc\s*=\s*"([^"]*)"/i) || [])[1] || '';
    return /^data:image\//i.test(src) ? `<img src="${escapeAttr(src)}">` : '';
  });
  // Walk every remaining tag: drop disallowed tags; on allowed tags, keep only
  // allowed attributes and never keep on*-handlers or javascript: urls.
  html = html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^">]|"[^"]*")*)>/g, (m, slash, tagRaw, attrs) => {
    const tag = tagRaw.toLowerCase();
    if (!STIMULUS_ALLOWED_TAGS.has(tag)) return '';
    if (slash) return `</${tag}>`;
    if (tag === 'img') return m; // already normalized above
    const kept = [];
    const re = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = re.exec(attrs)) !== null) {
      const name = a[1].toLowerCase();
      const val = a[2];
      if (name.startsWith('on')) continue;
      if (!STIMULUS_ALLOWED_ATTRS.has(name)) continue;
      if (/javascript:/i.test(val)) continue;
      if (name === 'style' && /url\s*\(|expression\s*\(/i.test(val)) continue;
      kept.push(`${name}="${escapeAttr(val)}"`);
    }
    return kept.length ? `<${tag} ${kept.join(' ')}>` : `<${tag}>`;
  });
  return html.trim();
}

module.exports = { sanitizeStemHtml, stemHtmlToText, ALLOWED_TAGS, sanitizeStimulusHtml };
