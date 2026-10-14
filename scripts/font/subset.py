"""Instance Alexandria at one weight and subset it to a woff2. Called by scripts/build-font.mjs; not run by hand.

    python3 -I scripts/font/subset.py <source.ttf> <out.woff2> --wght 600 --unicodes "U+0020-007E,..." --features "init,medi,..."

The source is the variable TTF (read as data: fontTools parses it and nothing in it is executed). The steps are
the ones the spec names and nothing else:

  1. fontTools.varLib.instancer pins the wght axis, so one static font with no fvar/gvar/avar/HVAR/STAT is left.
  2. fontTools.subset keeps the code points asked for and the glyphs reachable from them through the layout features
     asked for. Hinting is dropped (the face is unhinted outlines and `prep` only sets smoothing), and the name table
     keeps ids 0-6 plus 13 and 14, so the copyright and the licence notice travel inside the file as the OFL asks.
  3. The result is written as woff2 (brotli).

Nothing here reads the clock: `recalcTimestamp=False` keeps the source's head.modified, so the same inputs and the
same fontTools and brotli give the same bytes. The last line printed is a JSON report the build script records.
"""
import argparse
import io
import json
import sys

import brotli
import fontTools
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer


def parse_unicodes(spec):
    """'U+0020-007E,U+00A0' -> sorted list of code points."""
    out = set()
    for part in spec.split(","):
        part = part.strip().upper().replace("U+", "")
        if not part:
            continue
        if "-" in part:
            lo, hi = part.split("-")
            out.update(range(int(lo, 16), int(hi, 16) + 1))
        else:
            out.add(int(part, 16))
    return sorted(out)


def ranges(codepoints):
    """Sorted code points -> 'U+0020-007E,U+00A0-00FF' (the same notation the spec uses)."""
    out, start, prev = [], None, None
    for cp in sorted(codepoints):
        if start is None:
            start = prev = cp
        elif cp == prev + 1:
            prev = cp
        else:
            out.append((start, prev))
            start = prev = cp
    if start is not None:
        out.append((start, prev))
    fmt = lambda n: format(n, "04X")
    return ",".join(f"U+{fmt(a)}" if a == b else f"U+{fmt(a)}-{fmt(b)}" for a, b in out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("out")
    ap.add_argument("--wght", type=float, required=True)
    ap.add_argument("--unicodes", required=True)
    ap.add_argument("--features", required=True)
    args = ap.parse_args()

    font = TTFont(args.source, recalcTimestamp=False)
    instancer.instantiateVariableFont(font, {"wght": args.wght}, inplace=True, updateFontNames=True)
    # STAT describes the axes that no longer exist. The instancer keeps it so it can rename the instance from it.
    if "STAT" in font:
        del font["STAT"]
    for table in ("fvar", "gvar", "avar", "HVAR", "MVAR", "cvar"):
        if table in font:
            sys.exit(f"instancing left a variable table behind: {table}")

    opts = subset.Options()
    opts.layout_features = [f.strip() for f in args.features.split(",") if f.strip()]
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    opts.notdef_outline = True
    opts.hinting = False
    opts.glyph_names = False
    opts.recalc_timestamp = False
    opts.flavor = "woff2"
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=parse_unicodes(args.unicodes))
    sub.subset(font)

    font.flavor = "woff2"
    buf = io.BytesIO()
    font.save(buf)
    data = buf.getvalue()
    with open(args.out, "wb") as fh:
        fh.write(data)

    cmap = font.getBestCmap()
    gsub = font["GSUB"].table.FeatureList.FeatureRecord if "GSUB" in font else []
    gpos = font["GPOS"].table.FeatureList.FeatureRecord if "GPOS" in font else []
    glyf, hhea, os2, head = font["glyf"], font["hhea"], font["OS/2"], font["head"]
    ymax = max((glyf[n].yMax for n in font.getGlyphOrder() if glyf[n].numberOfContours != 0), default=0)
    ymin = min((glyf[n].yMin for n in font.getGlyphOrder() if glyf[n].numberOfContours != 0), default=0)
    report = {
        "bytes": len(data),
        "glyphs": len(font.getGlyphOrder()),
        "codepoints": len(cmap),
        "coverage": ranges(cmap.keys()),
        "features": sorted({r.FeatureTag for r in gsub} | {r.FeatureTag for r in gpos}),
        "metrics": {
            "unitsPerEm": head.unitsPerEm,
            "ascent": hhea.ascent,
            "descent": hhea.descent,
            "lineGap": hhea.lineGap,
            "xAvgCharWidth": os2.xAvgCharWidth,
            # "0" decides what 1ch is: the pages size heading measures in em because of it (see landing.html h1).
            "zeroAdvance": font["hmtx"][cmap[0x30]][0],
            "glyphYMax": ymax,
            "glyphYMin": ymin,
        },
        "usWeightClass": os2.usWeightClass,
        "family": font["name"].getDebugName(1),
        "subfamily": font["name"].getDebugName(2),
        "tools": {"fontTools": fontTools.version, "brotli": getattr(brotli, "__version__", "unknown")},
    }
    print(json.dumps(report, ensure_ascii=True, sort_keys=True))


if __name__ == "__main__":
    main()
