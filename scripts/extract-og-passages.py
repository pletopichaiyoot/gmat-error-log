#!/usr/bin/env python3
"""Attach RC passages and CR boldface markup to data/gmat-og-questions.json.

The questions, choices and answer keys are produced by scripts/parse-og-pdf.js
from the text layer. Passages need page geometry instead: the books print them
in a two-column layout with LSAT-style line numbers in the gutter, which a flat
text extraction destroys. This reads that geometry with pdfplumber and rewrites
ONLY the passage fields, leaving every question byte-identical.

The page to read is known: the answer explanations print "Questions 1-3 refer
to the passage on page 358." for every group, and parse-og-pdf.js already
carries those references through. Only the printed-to-PDF page offset has to be
discovered, and that is one integer per book.

The same geometry answers a second question the text layer cannot. Roughly two
dozen CR questions ask what "the portion in boldface" plays in the argument,
and a flat extraction drops the emphasis, leaving the stem unanswerable. Font
weight is on the page, so the bold runs are read here and written back as a
`stemHtml`.

Usage:
    python3 scripts/extract-og-passages.py            # dry-run report
    python3 scripts/extract-og-passages.py --merge    # rewrite the pool
"""

import datetime
import json
import os
import re
import shutil
import sys
from collections import Counter

try:
    import pdfplumber
except ImportError:
    sys.exit("pdfplumber is required: pip install --user pdfplumber")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POOL = os.path.join(ROOT, "data", "gmat-og-questions.json")

PDFS = {
    "OG12": "The official guide for gmat review, 12th edition.pdf",
    "OG13": "OG13.pdf",
    "VR2": "The Official Guide for GMAT Verbal Review, 2nd edition.pdf",
}

MARKER = re.compile(r"^\((\d{1,2})\)$")          # gutter line number
LINE_WORD = re.compile(r"^Line$")                 # the column's "Line" caption
Q_STEM = re.compile(r"^\d{1,3}\.\s+\S")
CHOICE = re.compile(r"^\([A-E]\)")
PASSAGE_REF = re.compile(r"^Questions\s+\d{1,3}\s*[-–—]\s*\d{1,3}\s+refer", re.I)
NOISE = [re.compile(p, re.I) for p in [
    r"^\s*\d{1,4}\s*$",                           # bare page number
    r"The Official Guide for GMAT",
    r"Review \d+th Edition",
    r"Verbal Review 2nd Edition",
    r"QQ:\d{6,}",                                  # OG13 scan watermark
    r"^\d+\.\d+\s",                               # running head like "7.4 ..."
    # The directions block reprinted at the top of every passage page.
    r"reading comprehension questions is based",
    r"answer all questions pertaining to it",
    r"select the best answer of the choices",
    r"questions in this group are based on",
    r"^Line$",
]]

# pdfplumber emits a ligature glyph as its own word, so "Official" arrives as
# "Offi cial" and "Ecoefficiency" as "Ecoeffi ciency". Rejoin a word ending in
# a ligature cluster with a lowercase continuation.
LIGATURE_SPLIT = re.compile(r"\b([A-Za-z]*(?:ffi|ffl|fi|fl|ff)) ([a-z]+)\b")

# The split always lands mid-word, so the continuation is a fragment. A real
# word after "stuff", "off" or "cliff" means the space belongs there.
# ponytail: a stopword list, not a dictionary — it covers the words that
# actually follow those few English words ending in ff/fi/fl. Swap in a real
# wordlist if a false join ever shows up in the passages.
NOT_A_CONTINUATION = {
    "a", "all", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by",
    "can", "could", "do", "does", "for", "from", "had", "has", "have", "he", "her",
    "him", "his", "how", "in", "into", "is", "it", "its", "may", "might", "more",
    "most", "must", "no", "not", "of", "on", "one", "only", "or", "other", "our",
    "out", "over", "own", "same", "she", "should", "so", "some", "such", "than",
    "that", "the", "their", "them", "then", "there", "these", "they", "this",
    "those", "through", "to", "under", "up", "was", "were", "what", "when",
    "where", "which", "while", "who", "why", "will", "with", "would", "you",
}


LIGATURES = {"ffi", "ffl", "fi", "fl", "ff"}


def _join(m):
    # A token that is ONLY a ligature cluster is never an English word, so it
    # is always a split word ("fl at" -> "flat"). Otherwise the continuation
    # has to look like a fragment rather than a word of its own.
    if m.group(1).lower() not in LIGATURES and m.group(2) in NOT_A_CONTINUATION:
        return m.group(0)
    return m.group(1) + m.group(2)


def fix_ligatures(t):
    prev = None
    while prev != t:
        prev = t
        t = LIGATURE_SPLIT.sub(_join, t)
    return t


def is_noise(t):
    return any(p.search(t) for p in NOISE)


def squish(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def detect_split(words, width):
    """Column gutter x = sparsest vertical band near page centre. Robust to the
    page-size differences between these three books."""
    xs = [w["x0"] for w in words]
    best_x, best_n, x = width / 2, 10 ** 9, width * 0.42
    while x <= width * 0.62:
        n = sum(1 for v in xs if abs(v - x) < 8)
        if n < best_n:
            best_n, best_x = n, x
        x += 2
    return best_x


def col_mode(xs):
    return Counter(round(x) for x in xs).most_common(1)[0][0] if xs else None


def page_lines(page):
    """Rebuild the page as ordered lines, carrying each line's gutter marker,
    left edge and column margin."""
    words = page.extract_words(x_tolerance=1.2, extra_attrs=["fontname", "size"])
    if not words:
        return []
    split = detect_split(words, page.width)
    margin = {"L": col_mode([w["x0"] for w in words if w["x0"] < split]),
              "R": col_mode([w["x0"] for w in words if w["x0"] >= split])}

    markers, prose = [], []
    for w in words:
        col = "L" if w["x0"] < split else "R"
        m = margin[col]
        text = w["text"].strip()
        # A gutter marker sits left of its column's text margin.
        if m is not None and w["x0"] < m - 5 and (MARKER.match(text) or LINE_WORD.match(text)):
            if MARKER.match(text):
                markers.append((int(text.strip("()")), w["top"], col))
            continue
        prose.append((w, col))

    rows = {}
    for w, col in prose:
        rows.setdefault((col, round(w["top"] / 2.5)), []).append(w)

    built = []
    for (col, _), ws in rows.items():
        ws.sort(key=lambda w: w["x0"])
        built.append({
            "col": col,
            "top": min(w["top"] for w in ws),
            "x0": ws[0]["x0"],
            "text": " ".join(w["text"] for w in ws).strip(),
            "margin": margin[col],
            "marker": None,
        })

    for num, mtop, mcol in markers:
        cands = [b for b in built if b["col"] == mcol]
        if cands:
            near = min(cands, key=lambda b: abs(b["top"] - mtop))
            if abs(near["top"] - mtop) < 7:
                near["marker"] = num

    out = []
    for col in ("L", "R"):
        out.extend(sorted([b for b in built if b["col"] == col], key=lambda b: b["top"]))
    return out


def build_passage(page, passage_id, printed_page):
    """The passage is the prose on its printed page, up to the point where the
    questions begin. Paragraphs are recovered from first-line indentation."""
    lines = []
    for ln in page_lines(page):
        ln["text"] = fix_ligatures(ln["text"])
        if ln["text"] and not is_noise(ln["text"]):
            lines.append(ln)
    body = []
    for ln in lines:
        t = ln["text"]
        if PASSAGE_REF.match(t) or Q_STEM.match(t) or CHOICE.match(t):
            break
        body.append(ln)
    if not body:
        return None

    paras, cur, numbered = [], [], []
    for ln in body:
        indented = ln["margin"] is not None and ln["x0"] > ln["margin"] + 4
        if indented and cur:
            paras.append(" ".join(cur))
            cur = []
        cur.append(ln["text"])
        numbered.append({"n": len(numbered) + 1, "marker": ln["marker"],
                         "para": len(paras), "text": ln["text"]})
    if cur:
        paras.append(" ".join(cur))

    text = "\n\n".join(p.strip() for p in paras if p.strip())
    if len(text) < 200:          # a real RC passage runs to hundreds of words
        return None
    return {"id": passage_id, "page": printed_page, "text": text,
            "lines": numbered, "highlights": []}


# ---------------------------------------------------------------- boldface CR

# "In the argument given, the two portions in boldface play which of the
# following roles?" — matched the same way scripts/og/assemble.js matches it, so
# the two ends of the pipeline agree on which questions need this.
BOLDFACE_STEM = re.compile(r"\bbold\s?face\b|\bportions?\s+in\s+bold\b|\bboldfaced\b", re.I)

# A bold run has to be long enough to identify a span of the argument. Shorter
# runs are the page's own furniture: the running head, a question number, the
# "Argument Evaluation" label above an explanation.
BOLD_RUN_MIN = 20

# The PDF spells "field" as the two words "fi eld" where the text layer carries
# the ligature. Expanding the ligature before stripping punctuation is what lets
# the two renderings compare equal.
LIGATURES = {"\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi", "\ufb04": "ffl"}


def norm_map(text):
    """Normalized text plus, for each normalized character, its index in `text`."""
    out, idx = [], []
    for i, ch in enumerate(text):
        for lig, plain in LIGATURES.items():
            if ch == lig:
                ch = plain
                break
        for c in ch.lower():
            if c.isalnum():
                out.append(c)
                idx.append(i)
    return "".join(out), idx


def norm(text):
    return norm_map(text)[0]


def bold_runs(page):
    """Every maximal run of consecutive bold words on the page, normalized."""
    try:
        words = page.extract_words(extra_attrs=["fontname"])
    except Exception:
        return []
    runs, cur = [], []
    for w in words:
        if "bold" in w.get("fontname", "").lower():
            cur.append(w["text"])
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    out = []
    for r in runs:
        n = norm("".join(r))
        if len(n) >= BOLD_RUN_MIN:
            out.append(n)
    return out


def escape_html(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def mark_bold(stem, spans):
    """Wrap each (start, end) span of `stem` in <b>, escaping the rest."""
    out, at = [], 0
    for start, end in sorted(spans):
        if start < at:
            continue
        out.append(escape_html(stem[at:start]))
        out.append("<b>" + escape_html(stem[start:end]) + "</b>")
        at = end
    out.append(escape_html(stem[at:]))
    return "".join(out)


def boldface_html(pdf, questions):
    """qid -> stemHtml, for the CR questions whose stem talks about boldface.

    The question is NOT located first and read second. Every page is scanned for
    bold runs and each run is tested against each stem: a run of twenty or more
    characters that occurs exactly once in a stem identifies both the page and
    the span, and needs no page offset, no column ordering and no question
    number — none of which survive reliably in the scanned books. The page
    yielding the most spans wins, which prefers the practice section's printing
    over the explanations' reprint of the same question, where the type label is
    also set bold.
    """
    stems = {q["id"]: norm_map(q["stem"]) for q in questions}
    best = {}
    for page in pdf.pages:
        runs = bold_runs(page)
        if not runs:
            continue
        for qid, (sn, idx) in stems.items():
            spans = []
            for run in runs:
                if sn.count(run) != 1:
                    continue
                at = sn.index(run)
                spans.append((idx[at], idx[at + len(run) - 1] + 1))
            if spans and len(spans) > len(best.get(qid, [])):
                best[qid] = spans
    by_id = {q["id"]: q for q in questions}
    return {qid: mark_bold(by_id[qid]["stem"], spans) for qid, spans in best.items()}


def find_page_offset(pdf, refs, probe_text):
    """Printed page numbers are not PDF page indices. Find the one offset where
    the passages actually land on the pages the book says they do."""
    best, best_hits = None, 0
    for off in range(-40, 41):
        hits = 0
        for ref in refs:
            idx = ref["page"] + off - 1
            if not (0 <= idx < len(pdf.pages)):
                continue
            built = build_passage(pdf.pages[idx], "probe", ref["page"])
            if built:
                hits += 1
        if hits > best_hits:
            best, best_hits = off, hits
        if best_hits == len(refs):
            break
    return best, best_hits


def rc_passages(pdf, book, rc, report):
    """Rewrite rc["passages"] from page geometry. Returns the number built."""
    refs = [r for r in rc.get("passageRefs", []) if r.get("page")]
    if not refs:
        report.append(f"{book['code']} RC: no page-bearing passage references")
        return 0

    offset, hits = find_page_offset(pdf, refs, None)
    if offset is None:
        report.append(f"{book['code']} RC: could not resolve the page offset")
        return 0

    passages, missing = [], []
    for ref in refs:
        idx = ref["page"] + offset - 1
        pid = f"{book['code']}-RC-p{ref['page']}"
        built = (build_passage(pdf.pages[idx], pid, ref["page"])
                 if 0 <= idx < len(pdf.pages) else None)
        if built:
            passages.append(built)
        else:
            missing.append(ref["page"])

    rc["passages"] = passages
    linked = {p["id"] for p in passages}
    served = sum(1 for q in rc["questions"] if q.get("passageId") in linked)
    report.append(
        f"{book['code']} RC: offset {offset:+d} ({hits}/{len(refs)} probes), "
        f"{len(passages)}/{len(refs)} passages, {served}/{len(rc['questions'])} "
        f"questions served" + (f", missing pages {missing}" if missing else ""))
    return len(passages)


def cr_boldface(pdf, book, cr, report):
    """Write stemHtml for the CR questions that ask about a boldface portion.

    A question excluded ONLY for the missing markup becomes usable again the
    moment it is recovered. That check is the last one scripts/og/assemble.js
    applies, so 'boldface-unmarked' means the question is otherwise sound and
    the flag can be flipped here rather than by another parse.
    """
    wanted = [q for q in cr["questions"] if BOLDFACE_STEM.search(q.get("stem") or "")]
    if not wanted:
        return 0

    html = boldface_html(pdf, wanted)
    recovered = 0
    for q in wanted:
        got = html.get(q["id"])
        if not got:
            q.pop("stemHtml", None)
            continue
        q["stemHtml"] = got
        recovered += 1
        if q.get("unusable") == "boldface-unmarked":
            q["usable"] = True
            q.pop("unusable", None)

    report.append(
        f"{book['code']} CR: {recovered}/{len(wanted)} boldface stems marked up"
        + (f", still unmarked {[q['id'] for q in wanted if not html.get(q['id'])]}"
           if recovered < len(wanted) else ""))
    return recovered


def main():
    merge = "--merge" in sys.argv
    only_book = None
    if "--book" in sys.argv:
        only_book = sys.argv[sys.argv.index("--book") + 1]
    pool = json.load(open(POOL))
    report = []
    total_built = 0
    total_bold = 0

    for book in pool["books"]:
        if only_book and book["code"] != only_book:
            continue
        rc = next((s for s in book["sections"] if s["kind"] == "RC"), None)
        cr = next((s for s in book["sections"] if s["kind"] == "CR"), None)
        if not rc and not cr:
            continue

        path = os.path.join(ROOT, "docs", PDFS[book["code"]])
        if not os.path.exists(path):
            report.append(f"{book['code']}: missing PDF {path}")
            continue

        with pdfplumber.open(path) as pdf:
            if rc:
                total_built += rc_passages(pdf, book, rc, report)
            if cr:
                total_bold += cr_boldface(pdf, book, cr, report)

    print("\n".join(report))
    print(f"\n{total_built} passages built, {total_bold} boldface stems marked up.")

    if merge:
        stamp = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
        shutil.copyfile(POOL, f"{POOL}.bak-prepassages-{stamp}")
        with open(POOL, "w") as fh:
            json.dump(pool, fh, indent=1)
        print(f"merged into {POOL}")
    else:
        print("dry run; pass --merge to write")


if __name__ == "__main__":
    main()
