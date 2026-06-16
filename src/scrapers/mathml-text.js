// Convert MathML (and small HTML fragments containing it) into readable inline text.
//
// StartTest (GMAT Official Practice) renders math — fractions, exponents, roots —
// as native MathML, not images. Reading it with innerText/textContent collapses
// `<mfrac><mn>1</mn><mn>24</mn></mfrac>` to "124" (no fraction bar exists as text).
// This converts the structure to a readable form: 1/24, 1/(n(n + 1)), x^2, √3.
//
// Pure string -> string (no DOM), so it runs in Node and is unit-tested directly.
// The StartTest scraper returns math-bearing innerHTML from the page and converts
// it here (Node-side), to avoid injecting eval/new Function into the page (CSP).

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&#x2212;|&minus;/gi, '-')
    .replace(/&times;|&#xd7;|&#215;/gi, '×')
    .replace(/&divide;|&#xf7;|&#247;/gi, '÷')
    .replace(/&middot;|&#xb7;/gi, '·')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_e) { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (_e) { return ''; } });
}

function mathmlToText(markup) {
  if (!markup || typeof markup !== 'string') return '';

  // --- tokenize markup into a lightweight tree ---
  const root = { tag: null, children: [] };
  const stack = [root];
  const SELF_CLOSING = /^(mspace|none|mprescripts)$/i;
  const re = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(markup))) {
    const closing = m[1];
    const tagRaw = m[2];
    const selfClose = m[4];
    const textRaw = m[5];
    if (textRaw != null) {
      stack[stack.length - 1].children.push({ text: textRaw });
      continue;
    }
    const tag = tagRaw.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
    } else {
      const node = { tag, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClose && !SELF_CLOSING.test(tag)) stack.push(node);
    }
  }

  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const isAtom = (s) => /^[A-Za-z0-9.]+$/.test(s);
  const wrap = (s) => { const t = norm(s); return isAtom(t) ? t : `(${t})`; };
  const elems = (node) => node.children.filter((c) => c.tag);
  const R = (node) => render(node || { children: [] });
  const renderChildren = (node) => node.children.map(render).join('');

  function render(node) {
    if (node.text != null) return decodeEntities(node.text);
    const e = elems(node);
    switch (node.tag) {
      case 'mfrac': return `${wrap(R(e[0]))}/${wrap(R(e[1]))}`;
      case 'msup': return `${wrap(R(e[0]))}^${wrap(R(e[1]))}`;
      case 'msub': return `${wrap(R(e[0]))}_${wrap(R(e[1]))}`;
      case 'msubsup': return `${wrap(R(e[0]))}_${wrap(R(e[1]))}^${wrap(R(e[2]))}`;
      case 'msqrt': {
        const r = norm(renderChildren(node));
        return isAtom(r) ? `√${r}` : `√(${r})`;
      }
      case 'mroot': return `(${norm(R(e[0]))})^(1/${norm(R(e[1]))})`;
      case 'mfenced': return `(${norm(renderChildren(node))})`;
      default: return renderChildren(node);
    }
  }

  return norm(render(root));
}

// Convert a small HTML fragment (e.g. a choice's or stem's innerHTML) to readable
// text: each <math> becomes its inline form, <br>/block tags become newlines, all
// other tags are stripped, entities decoded. Whitespace collapsed.
function htmlToReadableText(html) {
  if (!html || typeof html !== 'string') return '';
  let s = html.replace(/<math\b[^>]*>[\s\S]*?<\/math>/gi, (mm) => ` ${mathmlToText(mm)} `);
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')        // drop space before sentence punctuation
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { mathmlToText, htmlToReadableText, decodeEntities };
