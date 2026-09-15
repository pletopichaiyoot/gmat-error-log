#!/usr/bin/env python3
"""Attach Reading Comprehension passages to data/gmat-og-questions.json.

The questions, choices and answer keys are produced by scripts/parse-og-pdf.js
from the text layer. Passages need page geometry instead: the books print them
in a two-column layout with LSAT-style line numbers in the gutter, which a flat
text extraction destroys. This reads that geometry with pdfplumber and rewrites
ONLY the passage fields, leaving every question byte-identical.

The page to read is known: the answer explanations print "Questions 1-3 refer
to the passage on page 358." for every group, and parse-og-pdf.js already
carries those references through. Only the printed-to-PDF page offset has to be
discovered, and that is one integer per book.

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


def main():
    merge = "--merge" in sys.argv
    only_book = None
    if "--book" in sys.argv:
        only_book = sys.argv[sys.argv.index("--book") + 1]
    pool = json.load(open(POOL))
    report = []
    total_built = 0

    for book in pool["books"]:
        if only_book and book["code"] != only_book:
            continue
        rc = next((s for s in book["sections"] if s["kind"] == "RC"), None)
        if not rc:
            continue
        refs = [r for r in rc.get("passageRefs", []) if r.get("page")]
        if not refs:
            report.append(f"{book['code']} RC: no page-bearing passage references")
            continue

        path = os.path.join(ROOT, "docs", PDFS[book["code"]])
        if not os.path.exists(path):
            report.append(f"{book['code']} RC: missing PDF {path}")
            continue

        with pdfplumber.open(path) as pdf:
            offset, hits = find_page_offset(pdf, refs, None)
            if offset is None:
                report.append(f"{book['code']} RC: could not resolve the page offset")
                continue

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
        total_built += len(passages)
        linked = {p["id"] for p in passages}
        served = sum(1 for q in rc["questions"] if q.get("passageId") in linked)
        report.append(
            f"{book['code']} RC: offset {offset:+d} ({hits}/{len(refs)} probes), "
            f"{len(passages)}/{len(refs)} passages, {served}/{len(rc['questions'])} "
            f"questions served" + (f", missing pages {missing}" if missing else ""))

    print("\n".join(report))
    print(f"\n{total_built} passages built.")

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
