/**
 * Extract DSH's theme token layers for the screenshot render.
 *
 * The screenshots must show what the app actually renders, which means every
 * `--dsw-*` token has to resolve to its real value. The served stylesheet only
 * *consumes* those tokens; their definitions are injected at runtime by
 * `@deepseek-ai/dsh-client-ui-theme`, so they have to be read out of that
 * plugin's bundle.
 *
 * The result is DSH's own design-system source, so it is generated on demand
 * and git-ignored rather than committed: shipping it in this MIT repository
 * would redistribute a DeepSeek asset. It is derived from the DSH copy already
 * installed on this machine, purely to render documentation images.
 *
 * Traps this handles (each broke a simpler attempt):
 *  - the stylesheet lives inside JS string chunks, so a capture can start mid-JS;
 *  - the file opens with `window.__ModuleLoader__.load({ ... })`, whose object
 *    literal brace-balances across the WHOLE file, so advancing by `indexOf`
 *    skips past everything;
 *  - a token block's selector run often continues off its `var name = ":root`
 *    prefix, so the selector must be the TAIL of that run;
 *  - the `:root` base layer is one long escaped-quote string that defeats the
 *    balanced walk, so its geometry tokens are taken by direct pattern.
 *
 * Usage: node scripts/extract-theme-tokens.mjs [outfile]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = process.argv[2] ?? path.join(ROOT, 'scripts/theme-tokens.css');

/** Locate the theme plugin's bundled client inside the installed DSH. */
function findThemeBundle() {
  const candidates = [
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
    process.env.DSH_APP_ASAR,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { asar: candidate };
  }
  throw new Error('could not find the DSH app bundle; set DSH_APP_ASAR to its app.asar');
}

/** Read one file out of an asar archive by its in-archive path. */
function readFromAsar(asar, suffix) {
  const fd = fs.openSync(asar, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const jsonLength = head.readUInt32LE(12);
    const jsonBuffer = Buffer.alloc(jsonLength);
    fs.readSync(fd, jsonBuffer, 0, jsonLength, 16);
    const manifest = JSON.parse(jsonBuffer.toString('utf8'));
    const base = 8 + jsonLength;
    const files = [];
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const full = `${prefix}/${name}`;
        if (entry.files) walk(entry, full);
        else if (Number.isInteger(Number(entry.offset))) {
          files.push({ path: full, offset: Number(entry.offset), size: Number(entry.size) });
        }
      }
    };
    walk(manifest, '');
    const hit = files.find((f) => f.path.endsWith(suffix));
    if (hit === undefined) throw new Error(`${suffix} not found in ${asar}`);
    const buffer = Buffer.alloc(hit.size);
    fs.readSync(fd, buffer, 0, hit.size, base + hit.offset);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const { asar } = findThemeBundle();
const bundle = readFromAsar(asar, 'dsh-client-ui-theme/lib/client.js');
// JS line comments are stripped first: a `//#region ... :root` marker contains a
// colon and an absolute path, which made the selector look non-CSS.
const source = bundle.replace(/\/\/[^\n]*/g, '');

const blocks = [];
const seen = new Set();
for (let brace = source.indexOf('{'); brace >= 0; brace = source.indexOf('{', brace + 1)) {
  let start = brace - 1;
  while (start >= 0 && !';}\n`'.includes(source[start]) && brace - start < 400) start -= 1;
  let run = source.slice(start + 1, brace);
  // The selector is the tail after the last JS string-literal opener or `=`.
  const quoteAt = Math.max(run.lastIndexOf('"'), run.lastIndexOf("'"));
  if (quoteAt >= 0) run = run.slice(quoteAt + 1);
  const eqAt = run.lastIndexOf('=');
  if (eqAt >= 0) run = run.slice(eqAt + 1);
  const selector = run.trim();
  if (selector.length === 0 || selector.length > 120) continue;
  if (!/^[\s,:>\[\]a-zA-Z0-9().=*+#~"'-]*$/.test(selector)) continue;

  let end = brace + 1;
  let depth = 1;
  let quote = null;
  while (end < source.length && depth > 0) {
    const c = source[end];
    if (quote !== null) {
      if (c === '\\') { end += 2; continue; }
      if (c === quote) quote = null;
      end += 1;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; end += 1; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    end += 1;
  }
  if (depth !== 0) continue;
  const body = source.slice(brace + 1, end - 1);
  if (!/--dsw-[a-z0-9-]+\s*:/.test(body)) continue;
  const block = `${selector}{${body}}`;
  if (!seen.has(block)) { seen.add(block); blocks.push(block); }
}

// The `:root` base layer carries the geometry tokens (radii, backdrop filter)
// and is stored as one long escaped-quote string that the walk above cannot
// balance. Those few values are taken by direct pattern instead.
const direct = [
  ['--dsw-radius-xs', /--dsw-radius-xs:([^;}]+)/],
  ['--dsw-radius-sm', /--dsw-radius-sm:([^;}]+)/],
  ['--dsw-radius-md', /--dsw-radius-md:([^;}]+)/],
  ['--dsw-radius-lg', /--dsw-radius-lg:([^;}]+)/],
  ['--dsw-menu-backdrop-filter', /--dsw-menu-backdrop-filter:([^;}]+)/],
];
const geometry = direct
  .map(([name, pattern]) => {
    const m = pattern.exec(bundle);
    return m === null ? null : `${name}:${m[1]}`;
  })
  .filter((entry) => entry !== null);

const css = blocks
  .join('\n')
  .replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\\//g, '/')
  + `\n:root{${geometry.join(';')}}\n`;

const open = (css.match(/\{/g) ?? []).length;
const close = (css.match(/\}/g) ?? []).length;
if (open !== close) throw new Error(`extracted CSS is unbalanced (${open} open / ${close} close)`);

const header = `/*
 * DSH's theme token layers — GENERATED, do not edit, not committed.
 *
 * Produced by scripts/extract-theme-tokens.mjs from the DSH copy installed on
 * this machine, so \`npm run shots\` can render the plugin against the real theme.
 * It is DSH's own design-system source, so it is kept out of the repository to
 * avoid redistributing it; regenerate after a DSH theme change.
 */

`;
fs.writeFileSync(OUT, header + css);
console.log(`wrote ${OUT} (${css.length} bytes, ${blocks.length} blocks, balanced)`);
