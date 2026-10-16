"""Build every SVG of the Event Index logo package.

Mark: a 4 x 3 grid of days, one ringed. Favicon: a 3 x 2 cut of the same idea.
Wordmark: the mark beside "Event Index" set in Public Sans 600, text converted to
paths (shaped with HarfBuzz so kerning is real) so the file needs no font installed.
"""
import os, sys, json
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import uharfbuzz as hb

OUT = sys.argv[1]
os.makedirs(f"{OUT}/mark", exist_ok=True)
os.makedirs(f"{OUT}/favicon", exist_ok=True)
os.makedirs(f"{OUT}/wordmark", exist_ok=True)

# Palette: the tokens eventindex.space already uses (deploy/site/offline.html).
INK = "#1d1d1f"      # dots on light
PAPER = "#fcfcfa"    # site background; dots and ring on the blue tile
BLUE = "#1f5fbf"     # the ring on light; the avatar tile
SKY = "#8ab4ff"      # the ring on dark; dots on the tile
INK_DARK = "#ececee" # dots on dark

# ---------- geometry ----------
MARK_DOTS = [(x, y) for y in (30, 50, 70) for x in (20, 40, 60, 80)]
MARK_R = 5
MARK_RING = (60, 50, 11.5, 4)          # cx, cy, r, stroke

FAV_DOTS = [(x, y) for y in (36, 64) for x in (22, 50, 78)]
FAV_R = 8
FAV_RING = (50, 64, 15, 5.5)

def dots_svg(dots, r, fill):
    return "".join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fill}"/>' for x, y in dots)

def ring_svg(ring, stroke):
    cx, cy, r, w = ring
    return f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{stroke}" stroke-width="{w}"/>'

def mark_body(dot_fill, ring_stroke, dots=MARK_DOTS, r=MARK_R, ring=MARK_RING):
    return dots_svg(dots, r, dot_fill) + ring_svg(ring, ring_stroke)

HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n'
def svg(w, h, body, extra_attrs="", title="Event Index"):
    return (HEAD + f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}"'
            f' role="img" aria-label="{title}"{extra_attrs}>{body}</svg>\n')

def write(path, text):
    with open(path, "w") as f:
        f.write(text)

# Mark on light (transparent), on dark (transparent), one colour, adaptive, tile.
write(f"{OUT}/mark/mark.svg", svg(100, 100, mark_body(INK, BLUE)))
write(f"{OUT}/mark/mark-dark.svg", svg(100, 100, mark_body(INK_DARK, SKY)))
write(f"{OUT}/mark/mark-mono.svg", svg(100, 100, mark_body("currentColor", "currentColor")))
adaptive = ('<style>.d{fill:' + INK + '}.r{stroke:' + BLUE + '}'
            '@media (prefers-color-scheme:dark){.d{fill:' + INK_DARK + '}.r{stroke:' + SKY + '}}</style>'
            + "".join(f'<circle class="d" cx="{x}" cy="{y}" r="{MARK_R}"/>' for x, y in MARK_DOTS)
            + f'<circle class="r" cx="{MARK_RING[0]}" cy="{MARK_RING[1]}" r="{MARK_RING[2]}" fill="none" stroke-width="{MARK_RING[3]}"/>')
write(f"{OUT}/mark/mark-adaptive.svg", svg(100, 100, adaptive))
write(f"{OUT}/mark/mark-tile.svg", svg(100, 100, f'<rect width="100" height="100" fill="{BLUE}"/>' + mark_body(SKY, PAPER)))
write(f"{OUT}/mark/mark-tile-rounded.svg", svg(100, 100, f'<rect width="100" height="100" rx="22" fill="{BLUE}"/>' + mark_body(SKY, PAPER)))

# Favicon: simplified cut, adaptive colours, transparent.
fav_adaptive = ('<style>.d{fill:' + INK + '}.r{stroke:' + BLUE + '}'
                '@media (prefers-color-scheme:dark){.d{fill:' + INK_DARK + '}.r{stroke:' + SKY + '}}</style>'
                + "".join(f'<circle class="d" cx="{x}" cy="{y}" r="{FAV_R}"/>' for x, y in FAV_DOTS)
                + f'<circle class="r" cx="{FAV_RING[0]}" cy="{FAV_RING[1]}" r="{FAV_RING[2]}" fill="none" stroke-width="{FAV_RING[3]}"/>')
write(f"{OUT}/favicon/favicon.svg", svg(100, 100, fav_adaptive))
write(f"{OUT}/favicon/favicon-light.svg", svg(100, 100, mark_body(INK, BLUE, FAV_DOTS, FAV_R, FAV_RING)))
write(f"{OUT}/favicon/favicon-dark.svg", svg(100, 100, mark_body(INK_DARK, SKY, FAV_DOTS, FAV_R, FAV_RING)))
write(f"{OUT}/favicon/favicon-tile.svg", svg(100, 100, f'<rect width="100" height="100" fill="{BLUE}"/>' + mark_body(SKY, PAPER, FAV_DOTS, FAV_R, FAV_RING)))

# ---------- wordmark ----------
WOFF = "node_modules/@fontsource/public-sans/files/public-sans-latin-600-normal.woff"
tt = TTFont(WOFF)
tt.flavor = None
tt.save("public-sans-600.ttf")
tt = TTFont("public-sans-600.ttf")
upem = tt["head"].unitsPerEm
cap = tt["OS/2"].sCapHeight
glyph_set = tt.getGlyphSet()
order = tt.getGlyphOrder()

with open("public-sans-600.ttf", "rb") as f:
    blob = hb.Blob(f.read())
face = hb.Face(blob)
font = hb.Font(face)
font.scale = (upem, upem)

TEXT = "Event Index"
buf = hb.Buffer()
buf.add_str(TEXT)
buf.guess_segment_properties()
hb.shape(font, buf, {"kern": True, "liga": True})

# Layout in a 1000-unit tall-ish space: mark box 64 high, cap height 30.
MARK_H = 64.0
CAP = 30.0
scale = CAP / cap                      # font units -> user units
font_px = scale * upem                 # the equivalent font-size in user units
baseline = MARK_H / 2 + CAP / 2        # grid centre is at MARK_H/2
GAP = 18.0
x = MARK_H + GAP
path_parts = []
pen_total = 0.0
for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
    gname = order[info.codepoint]
    gx = x + pos.x_offset * scale
    gy = baseline - pos.y_offset * scale
    pen = SVGPathPen(glyph_set)
    tpen = TransformPen(pen, (scale, 0, 0, -scale, gx, gy))
    glyph_set[gname].draw(tpen)
    d = pen.getCommands()
    if d:
        path_parts.append(d)
    x += pos.x_advance * scale
text_w = x - (MARK_H + GAP)
total_w = round(x + 2, 2)
text_path = " ".join(path_parts)

def mark_at(dot_fill, ring_stroke, box=MARK_H):
    s = box / 100.0
    return f'<g transform="scale({s})">' + mark_body(dot_fill, ring_stroke) + "</g>"

def wordmark(dot_fill, ring_stroke, text_fill):
    body = mark_at(dot_fill, ring_stroke) + f'<path d="{text_path}" fill="{text_fill}"/>'
    return svg(total_w, MARK_H, body, title="Event Index")

write(f"{OUT}/wordmark/wordmark-light.svg", wordmark(INK, BLUE, INK))
write(f"{OUT}/wordmark/wordmark-dark.svg", wordmark(INK_DARK, SKY, INK_DARK))
write(f"{OUT}/wordmark/wordmark-mono.svg", wordmark("currentColor", "currentColor", "currentColor"))
# Stacked: mark above the name, centred, for places that want a square-ish lockup.
STACK_MARK = 100.0
stack_scale = CAP * 1.2 / cap
buf2 = hb.Buffer(); buf2.add_str(TEXT); buf2.guess_segment_properties(); hb.shape(font, buf2, {"kern": True, "liga": True})
w2 = sum(p.x_advance for p in buf2.glyph_positions) * stack_scale
W2 = max(STACK_MARK, w2) + 24
x2 = (W2 - w2) / 2
base2 = STACK_MARK + 8 + CAP * 1.2
parts2 = []
for info, pos in zip(buf2.glyph_infos, buf2.glyph_positions):
    gname = order[info.codepoint]
    pen = SVGPathPen(glyph_set)
    tpen = TransformPen(pen, (stack_scale, 0, 0, -stack_scale, x2 + pos.x_offset * stack_scale, base2 - pos.y_offset * stack_scale))
    glyph_set[gname].draw(tpen)
    d = pen.getCommands()
    if d: parts2.append(d)
    x2 += pos.x_advance * stack_scale
H2 = round(base2 + 10, 2)
def stacked(dot_fill, ring_stroke, text_fill):
    mx = (W2 - STACK_MARK) / 2
    body = f'<g transform="translate({mx:.2f} 0)">' + mark_body(dot_fill, ring_stroke) + "</g>" + f'<path d="{" ".join(parts2)}" fill="{text_fill}"/>'
    return svg(round(W2, 2), H2, body)
write(f"{OUT}/wordmark/wordmark-stacked-light.svg", stacked(INK, BLUE, INK))
write(f"{OUT}/wordmark/wordmark-stacked-dark.svg", stacked(INK_DARK, SKY, INK_DARK))

json.dump({"wordmark_w": total_w, "wordmark_h": MARK_H, "font_size_user_units": round(font_px, 2),
           "cap_height_units": cap, "upem": upem, "text_width": round(text_w, 2),
           "stacked_w": round(W2, 2), "stacked_h": H2}, open(f"{OUT}/wordmark/geometry.json", "w"), indent=1)
print("svgs written; wordmark", total_w, "x", MARK_H, "font-size", round(font_px, 2))
