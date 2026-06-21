#!/usr/bin/env python3
"""Re-extract LSAT Reading Comprehension passages with correct paragraph
structure, LSAT line numbers, and emphasis ("highlight") spans, then splice
them into data/lsat-questions.json.

WHY THIS EXISTS
---------------
The original `scripts/parse-lsat-pdf.js` extracts from `pdftotext -raw`, which
flattens the 2-column page layout and gives no paragraph signal. It therefore
DISCARDED real paragraph breaks and re-chopped passages every ~350 chars, and
leaked section boilerplate ("IF YOU FINISH BEFORE TIME IS CALLED...") into the
text. This script reads page GEOMETRY (via pdfplumber) instead, recovering the
true structure. It only rewrites RC `passage` / `passages[]`; questions, choices
and answer keys produced by the JS parser are left untouched.

REQUIREMENTS
------------
  - poppler `pdftotext` on PATH (for the fast per-page text index)
  - python `pdfplumber`  (pip install --user pdfplumber)
  - the source PDF (default: "LSAT PrepTest 1_89.pdf" in the repo root)

USAGE
-----
  python3 scripts/extract-lsat-passages.py            # dry run: report only
  python3 scripts/extract-lsat-passages.py --merge    # write data/lsat-questions.json (+ .bak)
  python3 scripts/extract-lsat-passages.py --only 1,2 # restrict to test numbers

KNOWN LIMITS
------------
  - Line NUMBERS can drift by a few near a passage's end, and in paired
    "comparative reading" sets (PT52+) the "Passage A/B" headers are unnumbered;
    paragraph TEXT is unaffected. Line numbers are best-effort for resolving
    "lines 6-13" style question references.
"""
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.join(ROOT, "LSAT PrepTest 1_89.pdf")
JSON = os.path.join(ROOT, "data", "lsat-questions.json")
RAW = os.path.join(ROOT, "tmp", "lsat-full-raw.txt")

NOISE = [re.compile(p, re.I) for p in [
    r'^[\d ]+$', r'^-\s*\d+\s*-$', r'^SECTION\b', r'^Time\s*[—–-]',
    r'^\d+\s+Questions', r'^Directions:', r'^GO ON TO THE NEXT', r'^STOP$',
    r'^[IVX]{1,4}$',
    r'the best answer; that is', r'^corresponding space on',
    r'in the passage\. For some', r'^and completely answers',
    r'to be answered on the basis', r'could conceivably answer',
    r'However, you are', r'a group of questions',
    r'^to choose the best answer', r'on your answer sheet',
    r'IF YOU FINISH BEFORE', r'DO NOT WORK ON ANY OTHER',
    r'CHECK YOUR WORK ON THIS', r'Law School Admission', r'copyright owner',
    r'^\d{1,2}\s*-\s*\d+\s*-',
    r'\d{1,2}/\d{1,2}/\d{2,4}', r'\d{1,2}:\d{2}\s*[AaPp]\.?[Mm]',
    r'Page\s+\d+\b', r'PrepTest\s+\d+',
]]
MARKER = re.compile(r'^\(\d{1,2}\)$')
Q_STEM = re.compile(r'^(\d{1,2})\.\s+\S')
CHOICE = re.compile(r'^\([A-E]\)')
PASSAGE_AB = re.compile(r'^Passage\s+[AB]\b')


def is_noise(t):
    return any(p.search(t) for p in NOISE)


def squish(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


# ---------- per-page text index (fast, via pdftotext) ----------
def ensure_raw():
    if not os.path.exists(RAW):
        os.makedirs(os.path.dirname(RAW), exist_ok=True)
        subprocess.run(["pdftotext", "-raw", PDF, RAW], check=True,
                       stderr=subprocess.DEVNULL)


def build_index():
    pages = open(RAW, encoding="utf-8", errors="replace").read().split("\f")
    return [{"page": i + 1, "squish": squish(t),
             "stop": bool(re.search(r'(?m)^\s*S\s*T\s*O\s*P\s*$', t))}
            for i, t in enumerate(pages)]


def find_section_pages(idx, probe):
    """(start, end) page range of the section containing `probe`, via STOP bounds."""
    hit = next((p["page"] for p in idx if probe and probe in p["squish"]), None)
    if hit is None:
        return None
    end = next((p["page"] for p in idx if p["page"] >= hit and p["stop"]), hit)
    prev = [p["page"] for p in idx if p["page"] < hit and p["stop"]]
    start = (max(prev) + 1) if prev else max(1, hit - 12)
    return start, end


# ---------- geometry extraction (adaptive per page) ----------
def detect_split(words, width):
    """Column gutter x = sparsest vertical band near page center. Robust to
    page-size changes across eras and to line-markers sitting in the gutter."""
    xs = [w["x0"] for w in words]
    lo, hi, center = width * 0.44, width * 0.60, width / 2
    best_x, best_n, x = center, 10 ** 9, width * 0.44
    while x <= hi:
        n = sum(1 for v in xs if abs(v - x) < 8)
        if n < best_n:
            best_n, best_x = n, x
        x += 2
    return best_x


def col_mode(xs):
    return Counter(round(x) for x in xs).most_common(1)[0][0] if xs else None


def reading_order(pdf, start, end):
    lines = []
    for pi in range(start - 1, end):
        page = pdf.pages[pi]
        words = page.extract_words(x_tolerance=1.2, extra_attrs=["fontname", "size"])
        if not words:
            continue
        split = detect_split(words, page.width)
        margin = {"L": col_mode([w["x0"] for w in words if w["x0"] < split]),
                  "R": col_mode([w["x0"] for w in words if w["x0"] >= split])}
        markers, prose = [], []
        for w in words:
            col = "L" if w["x0"] < split else "R"
            m = margin[col]
            if m is not None and w["x0"] < m - 5 and MARKER.match(w["text"]):
                markers.append((int(w["text"].strip("()")), w["top"], col))
            else:
                prose.append((w, col))
        rows = {}
        for w, col in prose:
            rows.setdefault((col, round(w["top"] / 2.5)), []).append(w)
        built = []
        for (col, _), ws in rows.items():
            ws.sort(key=lambda w: w["x0"])
            built.append({"col": col, "top": min(w["top"] for w in ws),
                          "x0": ws[0]["x0"], "text": " ".join(w["text"] for w in ws),
                          "words": ws, "marker": None, "margin": margin[col]})
        for num, mtop, mcol in markers:
            cands = [b for b in built if b["col"] == mcol]
            if cands:
                near = min(cands, key=lambda b: abs(b["top"] - mtop))
                if abs(near["top"] - mtop) < 7:
                    near["marker"] = num
        for col in ("L", "R"):
            for b in sorted([b for b in built if b["col"] == col], key=lambda b: b["top"]):
                lines.append(b)
    return lines


def extract_passages(pdf, start, end):
    lines = reading_order(pdf, start, end)
    fc = Counter()
    for ln in lines:
        for w in ln["words"]:
            fc[w.get("fontname", "").split("+")[-1]] += len(w["text"])
    body_font = fc.most_common(1)[0][0] if fc else ""

    blocks, cur = [], []
    for ln in lines:
        t = ln["text"].strip()
        if not t or is_noise(t):
            continue
        qm = Q_STEM.match(t)
        if qm or CHOICE.match(t):
            if cur:
                blocks.append({"lines": cur, "next_q": int(qm.group(1)) if qm else None})
                cur = []
            continue
        cur.append(ln)
    if cur:
        blocks.append({"lines": cur, "next_q": None})

    def is_para(ln):
        return ln["margin"] is not None and ln["x0"] > ln["margin"] + 8

    out = []
    for blk in blocks:
        bl = blk["lines"]
        if not any(ln["marker"] for ln in bl):
            continue
        while bl and not is_para(bl[0]) and not bl[0]["marker"]:
            bl = bl[1:]
        for seq, ln in enumerate(bl, start=1):
            if ln["marker"]:
                off = seq - ln["marker"]
                if off > 0:
                    bl = bl[off:]
                break
        numbered, paragraphs, buf, hi_all, n = [], [], [], [], 0
        for ln in bl:
            prose = ln["text"].strip()
            if not prose:
                continue
            if PASSAGE_AB.match(prose):           # comparative-reading header (unnumbered)
                if buf:
                    paragraphs.append(" ".join(buf)); buf = []
                paragraphs.append(prose)
                numbered.append({"n": None, "marker": None, "para": True, "text": prose})
                continue
            n += 1
            para = is_para(ln)
            if para and buf:
                paragraphs.append(" ".join(buf)); buf = []
            buf.append(prose)
            numbered.append({"n": n, "marker": ln["marker"], "para": para, "text": prose})
            for w in ln["words"]:
                fn = w.get("fontname", "").split("+")[-1]
                if fn != body_font and any(k in fn for k in ("Bold", "Italic", "Oblique")) \
                        and not w["text"].strip().isdigit():
                    hi_all.append({"line": n, "text": w["text"], "style": fn})
        if buf:
            paragraphs.append(" ".join(buf))
        if len([x for x in numbered if x["n"]]) < 4:
            continue
        out.append({"firstQuestion": blk["next_q"], "text": "\n\n".join(paragraphs),
                    "lines": numbered, "highlights": hi_all})
    return out


# ---------- driver ----------
def main():
    import pdfplumber
    only = None
    if "--only" in sys.argv:
        only = set(int(x) for x in sys.argv[sys.argv.index("--only") + 1].split(","))
    do_merge = "--merge" in sys.argv

    ensure_raw()
    idx = build_index()
    data = json.load(open(JSON, encoding="utf-8"))
    pdf = pdfplumber.open(PDF)

    pmap, report = {}, []
    for t in data["tests"]:
        if only and t["num"] not in only:
            continue
        for s in t["sections"]:
            if s["kind"] != "RC":
                continue
            concat = (s.get("passage") or "") + " " + \
                " ".join(p.get("text", "") for p in s.get("passages", []))
            sq = squish(concat)
            probe = sq[len(sq) // 2: len(sq) // 2 + 60] if len(sq) > 160 else sq[:60]
            span = find_section_pages(idx, probe)
            if not span:
                report.append((t["num"], s["roman"], "NO MATCH", 0))
                continue
            passages = extract_passages(pdf, span[0], span[1])
            pmap[f"{t['num']}:{s['roman']}"] = passages
            report.append((t["num"], s["roman"], f"pp{span[0]}-{span[1]}", len(passages)))

    for r in report:
        print(f"  test {r[0]:>3} {r[1]:>4} {r[2]:>12}  {r[3]} passages")
    four = sum(1 for r in report if r[3] == 4)
    print(f"\n{four}/{len(report)} sections -> exactly 4 passages")

    if not do_merge:
        print("\n(dry run — pass --merge to write data/lsat-questions.json)")
        return

    bak = f"{JSON}.bak-prepass"
    shutil.copy2(JSON, bak)
    replaced = 0
    for t in data["tests"]:
        for s in t["sections"]:
            if s["kind"] != "RC":
                continue
            new = pmap.get(f"{t['num']}:{s['roman']}")
            if not new:
                continue
            qn = [q["number"] for q in s.get("questions", [])]
            floor = min(qn) if qn else 1
            ps = []
            for i, p in enumerate(new):
                fq = p.get("firstQuestion")
                if fq is None:
                    fq = floor if i == 0 else None
                ps.append({"firstQuestion": fq, "text": p["text"],
                           "lines": p["lines"], "highlights": p.get("highlights", [])})
            for i, p in enumerate(ps):
                if p["firstQuestion"] is None:
                    p["firstQuestion"] = (ps[i - 1]["firstQuestion"] + 1) if i else floor
            s["passages"] = ps
            s["passage"] = ps[0]["text"]
            replaced += 1
    json.dump(data, open(JSON, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"\nbackup: {bak}\nreplaced RC sections: {replaced}")


if __name__ == "__main__":
    main()
