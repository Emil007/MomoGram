/** Quick sparse-vs-dense checks for PixELO v2. Run: node tools/rating-selftest.mjs (after esbuild bundle below). */
import * as esbuild from 'esbuild';
import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'tools', '_rating_bundle.mjs');
await esbuild.build({
  entryPoints: [join(root, 'src/game/rating.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: out,
  logLevel: 'silent',
});
const { puzzleRating, points, performance, RATING, clearRatingCache } = await import(pathToFileURL(out).href);

function grid(w, h, fillFn) {
  return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (fillFn(x, y) ? '#' : '.')).join(''));
}

clearRatingCache();
const sparse = grid(20, 16, (x, y) => (x + y * 3) % 19 === 0); // ~5%
const dense10 = grid(10, 10, (x, y) => (x + y) % 2 === 0);
const mid15 = grid(15, 15, (x, y) => x % 3 !== 0 && y % 3 !== 0);

const a = puzzleRating(sparse, false);
const b = puzzleRating(dense10, false);
const c = puzzleRating(mid15, false);
console.log('start', RATING.start, 'version', RATING.version);
console.log('sparse20x16', a);
console.log('dense10', b);
console.log('mid15', c);
console.log('sparse pr should be well below old ~1100 farm; dense10 midband');

const fail = [];
if (a.pr > 900) fail.push(`sparse pr too high: ${a.pr}`);
if (a.par > 90) fail.push(`sparse par too long: ${a.par}`);
if (b.pr < 400 || b.pr > 1200) fail.push(`dense10 pr out of band: ${b.pr}`);
if (c.par < b.par) fail.push(`15x15 par should usually exceed 10x10 (${c.par} vs ${b.par})`);
if (RATING.start !== 500) fail.push('start !== 500');
const ptsSparse = points(sparse, false, 'platinum', 2000, a.par);
const ptsDense = points(dense10, false, 'platinum', 2000, b.par);
console.log('pts sparse@2s', ptsSparse, 'dense@2s', ptsDense);
if (ptsSparse > ptsDense * 1.5) fail.push('sparse platinum points still crush dense');

try { unlinkSync(out); } catch { /* */ }
if (fail.length) {
  console.error('FAIL', fail);
  process.exit(1);
}
console.log('OK');
