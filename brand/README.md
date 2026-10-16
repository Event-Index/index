# brand

The Event Index mark and wordmark: a grid of days with one day ringed. The
grid is every public calendar the index reads; the ring is the day people
gather. The ring is the only colored element.

The mark and wordmark are dedicated to the public domain under CC0 1.0
([`LICENSE`](LICENSE)). The wordmark is set in Public Sans, under the SIL Open
Font License 1.1, with its letters embedded as outlines.

## Colors

The same tokens as the site (`api/src/pages.ts`):

| Name | Hex | Role |
|---|---|---|
| Ink | `#1d1d1f` | dots and wordmark on light backgrounds |
| Paper | `#fcfcfa` | site background; ring and (favicon) dots on the blue tile |
| Index blue | `#1f5fbf` | the ring on light backgrounds; the tile; links; `theme_color` |
| Sky | `#8ab4ff` | the ring on dark backgrounds; dots on the blue tile |
| Ink, dark | `#ececee` | dots and wordmark on dark backgrounds |

## Typeface

Public Sans, weight 600, for the wordmark. The SVGs carry the letters as
paths, so nothing needs the font installed. The site sets its text in the
reader's system font.

## Files

Files are transparent unless their name says `tile`.

**`mark/`**: the mark, a 4 × 3 grid, for 24 px and above.

| File | Use |
|---|---|
| `mark.svg`, `mark-{1024…32}.png` | light backgrounds (ink dots, blue ring) |
| `mark-dark.svg`, `mark-dark-{1024…32}.png` | dark backgrounds (light dots, sky ring) |
| `mark-adaptive.svg` | both, switched by `prefers-color-scheme` |
| `mark-mono.svg` | one color, `currentColor`, to inline where the mark takes the text color |
| `mark-tile.svg`, `mark-tile-{1024,512,256}.png` | the blue tile, square and full bleed: the Event Index key's nostr profile picture, and anywhere the background is unknown. The mark stays inside the central 80%, so a circle crop never cuts it. |
| `mark-tile-rounded.svg`, `mark-tile-rounded-512.png` | the tile with rounded corners, where a square is shown uncropped |

**`favicon/`**: a 3 × 2 cut with a bigger ring, so the ring reads at 16 px.
Only for tab and home-screen icons. Served at the site root.

| File | Use |
|---|---|
| `favicon.svg` | the tab icon, adaptive |
| `favicon.ico` | 16, 32 and 48 px frames, built from `favicon-{16,32,48}.png` |
| `favicon-{16,32,48,64}.png`, `favicon-dark-{16,32}.png` | PNG cuts |
| `apple-touch-icon.png` | iOS home screen (180 px, on the tile) |
| `android-chrome-{192x192,512x512}.png` | Android and installed-app icons, on the tile |
| `site.webmanifest` | the two Android icons, `theme_color` `#1f5fbf`, `background_color` `#fcfcfa` |
| `favicon-light.svg`, `favicon-dark.svg`, `favicon-tile.svg` | the sources of the PNGs |

**`wordmark/`**: the mark beside "Event Index".

| File | Use |
|---|---|
| `wordmark-light.svg`, `wordmark-dark.svg` | horizontal, 311.59 × 64 units; the site header uses both through `<picture>` |
| `wordmark-mono.svg` | one color, `currentColor` |
| `wordmark-stacked-light.svg`, `wordmark-stacked-dark.svg` | the mark above the name, for square spaces |
| `wordmark-light@2x.png`, `wordmark-dark@2x.png` | 623 × 128 px, where an SVG cannot go |
| `geometry.json` | the lockup's measurements, to rebuild it elsewhere |

The site serves `favicon/` at its root and `mark/` and `wordmark/` under
`/brand/` (for example `https://eventindex.space/brand/mark-tile-512.png`).

## Rules of use

- **Clear space**: one dot spacing on every side (20% of the mark's width).
- **Minimum size**: the mark at 24 px, below that the favicon cut; the
  wordmark at 24 px tall, below that the mark alone.
- **Color**: dots in Ink (or Ink dark), the ring in Index blue (or Sky); or
  the whole mark in one color (`mark-mono.svg`). The ring is never recolored
  to a platform's or a community's color.
- **Geometry**: never rotated, never a second ring, never the ring moved,
  never set inside another shape; the tile files are the only containers.
- **One accent**: on a page, Index blue is for links and the ring only.
- **Calendars keep their own pictures.** The mark stands for the directory:
  it is the Event Index key's profile picture and never a mirrored
  calendar's. A calendar without a picture of its own has none.

## Regenerating

The SVGs are generated from the geometry in `tools/build_svgs.py` and the PNGs
rendered from the SVGs by `tools/raster.mjs`; change the geometry there, never
an SVG by hand, so the files cannot drift apart. In a scratch directory (the
scripts find the font and Playwright in its `node_modules`):

```sh
cp <repo>/brand/tools/* .
npm install @fontsource/public-sans playwright
npx playwright install chromium
pip install fonttools uharfbuzz
python3 build_svgs.py <repo>/brand
node raster.mjs <repo>/brand
```

`favicon.ico` is then rebuilt from `favicon-16.png`, `favicon-32.png` and
`favicon-48.png`, for example with ImageMagick
(`magick favicon-16.png favicon-32.png favicon-48.png favicon.ico`).
