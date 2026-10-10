/**
 * Produce the README screenshots.
 *
 * Pipeline: drive the plugin's real client bundle into an element tree
 * (`render-shots.mjs`), write it as standalone HTML with DSH's real theme
 * tokens and the plugin's OWN stylesheet, then rasterize with headless Chrome
 * at the exact content size and crop the margin.
 *
 * Chrome is used rather than the system WebKit (`qlmanage`) because qlmanage
 * renders at a fixed ~1027px viewport and CLIPS anything taller, which silently
 * truncated the sidebar panel. Chrome's `--window-size` plus
 * `--screenshot` captures the full document.
 *
 * Usage: node scripts/make-screenshots.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execFileSync as run } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = path.join(ROOT, 'docs/assets');
const WORK = path.join(OUT, '.render');

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find((p) => fs.existsSync(p));

if (CHROME === undefined) {
  console.error('no Chromium-based browser found; install Google Chrome, Edge, or Chromium');
  process.exit(1);
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

// The render script writes the HTML pages; it owns the component driving.
execFileSync(process.execPath, [path.join(ROOT, 'scripts/render-shots.mjs'), WORK], { stdio: 'inherit' });

/**
 * Rasterize one HTML file with headless Chrome.
 *
 * `--user-data-dir` points at a throwaway profile on purpose. Without it, a
 * headless run attaches to the user's already-running Chrome (same default
 * profile) and never exits — the screenshot command hangs instead of
 * returning. An isolated profile also keeps this from touching their session.
 * `--window-size` sets the viewport; with `--hide-scrollbars` the capture is
 * exactly that box, so the caller sizes it ahead of time.
 */
function rasterize(name, width, height) {
  const out = path.join(WORK, `${name}.png`);
  const profile = path.join(WORK, 'chrome-profile');
  run(CHROME, [
    '--headless',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--window-size=${width},${height}`,
    `--screenshot=${out}`,
    `file://${path.join(WORK, `${name}.html`)}`,
  ], { stdio: 'ignore', timeout: 60_000 });
  return out;
}

/** Crop a PNG to its non-background content box, adding a small margin. */
function crop(input, output, pad = 18) {
  const script = `
import sys
from PIL import Image, ImageChops
src, dst, pad = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src).convert('RGB')
bg = Image.new('RGB', im.size, im.getpixel((im.width - 3, im.height - 3)))
box = ImageChops.difference(im, bg).getbbox()
if box is None:
    im.save(dst); print(dst, im.size); sys.exit(0)
l, t, r, b = box
l = max(0, l - pad); t = max(0, t - pad)
r = min(im.width, r + pad); b = min(im.height, b + pad)
out = im.crop((l, t, r, b))
out.save(dst)
print(f'{dst}  {out.width}x{out.height}')
`;
  run('python3', ['-c', script, input, output, String(pad)], { stdio: 'inherit' });
}

// Document sizes follow the page layout: the sidebar pane is 670 CSS px wide
// (matching the app), and the dock shots need room for the 380px floating card
// beside the trigger. Each page is rendered taller than needed, then cropped.
const shots = [
  { name: 'panel-dark', file: 'panel-dark.png', w: 670, h: 2600 },
  { name: 'panel-light', file: 'panel-light.png', w: 670, h: 2600 },
  { name: 'dock-collapsed', file: 'dock-collapsed.png', w: 460, h: 200 },
  { name: 'dock-expanded', file: 'dock-expanded.png', w: 720, h: 1600 },
];

console.log('');
for (const shot of shots) {
  const png = rasterize(shot.name, shot.w, shot.h);
  crop(png, path.join(OUT, shot.file));
}

fs.rmSync(WORK, { recursive: true, force: true });
console.log('\nscreenshots:');
for (const shot of shots) {
  const p = path.join(OUT, shot.file);
  console.log('  ', path.relative(ROOT, p), fs.statSync(p).size, 'bytes');
}
