#!/usr/bin/env node
/**
 * PixELO v2 calibration harness (uses the real rating.ts via esbuild).
 * Usage: node tools/calibrate-rating.mjs [sqlitePath]
 */
import * as esbuild from 'esbuild';
import { existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'tools', '_rating_bundle.mjs');
const sqlitePath = process.argv[2] || 'D:\\Dokumente\\Downloads\\momogram (4).sqlite';

await esbuild.build({
  entryPoints: [join(root, 'src/game/rating.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: out,
  logLevel: 'silent',
});
const { puzzleRating, points, performance, replay, RATING, clearRatingCache } = await import(pathToFileURL(out).href);

function grid(w, h, fillFn) {
  return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (fillFn(x, y) ? '#' : '.')).join(''));
}

clearRatingCache();
const fixtures = [
  { name: 'sparse~5% 20x16', rows: grid(20, 16, (x, y) => (x + y * 3) % 19 === 0) },
  { name: 'dense 10x10', rows: grid(10, 10, (x, y) => (x + y) % 2 === 0) },
  { name: 'mid 15x15', rows: grid(15, 15, (x, y) => x % 3 !== 0 && y % 3 !== 0) },
  { name: 'easy 5x5', rows: grid(5, 5, (x, y) => x === 2 || y === 2) },
];

console.log(`RATING v${RATING.version} start=${RATING.start}`);
const bands = { '5': [], '10': [], '15': [], sparse: [] };
for (const f of fixtures) {
  const r = puzzleRating(f.rows, false);
  const s2 = performance(2000, r.par, 'free');
  console.log(`${f.name}: pr=${r.pr} par=${r.par}s  s@2s=${s2.toFixed(3)}  pts@plat/2s=${points(f.rows, false, 'platinum', 2000, r.par)}`);
  if (f.name.startsWith('sparse')) bands.sparse.push(s2);
  else if (f.name.includes('5x5')) bands['5'].push(s2);
  else if (f.name.includes('10')) bands['10'].push(s2);
  else if (f.name.includes('15')) bands['15'].push(s2);
}

const fail = [];
if (RATING.start !== 500) fail.push('start !== 500');
const sparse = puzzleRating(fixtures[0].rows, false);
const dense = puzzleRating(fixtures[1].rows, false);
if (sparse.pr > 950) fail.push(`sparse pr still high: ${sparse.pr}`);
if (sparse.par > 100) fail.push(`sparse par still long: ${sparse.par}`);
if (points(fixtures[0].rows, false, 'platinum', 2000, sparse.par) > points(fixtures[1].rows, false, 'platinum', 2000, dense.par) * 1.6)
  fail.push('sparse platinum points crush dense');

// climb from 500 should not rocket past ~900 on only easy 5×5s
const easy = puzzleRating(fixtures[3].rows, false);
const solves = Array.from({ length: 12 }, (_, i) => ({
  at: `2020-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
  pr: easy.pr,
  s: performance(3000, easy.par, 'easy'),
}));
const climb = replay(solves);
console.log(`starter climb after 12 easy 5×5: elo=${climb.elo}`);
if (climb.elo > 900) fail.push(`climbed past 900 on only 5×5s: ${climb.elo}`);

console.log('sqlite:', sqlitePath, existsSync(sqlitePath) ? '(present — wire player bands offline if needed)' : 'MISSING');

try { unlinkSync(out); } catch { /* */ }
if (fail.length) {
  console.error('FAIL', fail);
  process.exit(1);
}
console.log('OK — fixture pass criteria met');
