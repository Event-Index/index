// Rasterize the SVGs with Chromium at exact pixel sizes. Transparent unless the SVG paints a tile.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
const jobs = [
  // [svg, png, width, height]
  ...[1024, 512, 256, 128, 64, 48, 32].map(s => [`mark/mark.svg`, `mark/mark-${s}.png`, s, s]),
  ...[1024, 512, 256, 64, 32].map(s => [`mark/mark-dark.svg`, `mark/mark-dark-${s}.png`, s, s]),
  ...[1024, 512, 256].map(s => [`mark/mark-tile.svg`, `mark/mark-tile-${s}.png`, s, s]),
  [`mark/mark-tile-rounded.svg`, `mark/mark-tile-rounded-512.png`, 512, 512],
  ...[16, 32, 48, 64].map(s => [`favicon/favicon-light.svg`, `favicon/favicon-${s}.png`, s, s]),
  ...[16, 32].map(s => [`favicon/favicon-dark.svg`, `favicon/favicon-dark-${s}.png`, s, s]),
  [`favicon/favicon-tile.svg`, `favicon/apple-touch-icon.png`, 180, 180],
  [`favicon/favicon-tile.svg`, `favicon/android-chrome-192x192.png`, 192, 192],
  [`favicon/favicon-tile.svg`, `favicon/android-chrome-512x512.png`, 512, 512],
  [`wordmark/wordmark-light.svg`, `wordmark/wordmark-light@2x.png`, 2 * 311.59, 128],
  [`wordmark/wordmark-dark.svg`, `wordmark/wordmark-dark@2x.png`, 2 * 311.59, 128],
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.emulateMedia({ colorScheme: 'light' });
for (const [src, dst, w, h] of jobs) {
  const svg = readFileSync(path.join(OUT, src), 'utf8');
  const W = Math.round(w), H = Math.round(h);
  await page.setViewportSize({ width: W, height: H });
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block;width:${W}px;height:${H}px}</style></head><body><img src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}"></body></html>`);
  await page.locator('img').screenshot({ path: path.join(OUT, dst), omitBackground: true, type: 'png' });
  console.log('wrote', dst, `${W}x${H}`);
}
await browser.close();
