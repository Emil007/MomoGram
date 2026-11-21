// Run MomoGram's importers on game files from the command line, for working on an importer:
//   node tools/import.mjs <game file or game folder>... [--json <folder>]
// Prints what each file became; with --json, writes each pack's pack.json (assets left out) to <folder>.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const args = process.argv.slice(2);
const j = args.indexOf('--json');
const out = j >= 0 ? args.splice(j, 2)[1] : null;
if (!args.length) { console.log('usage: node tools/import.mjs <game file>... [--json <folder>]'); process.exit(1); }

// the importers, bundled for Node (build.mjs keeps all.ts up to date; run it once after adding a file)
const entry = `import './src/packs/importers/all'; export { importGameFile, importFileSet } from './src/packs/importers/index';`;
const res = await build({ stdin: { contents: entry, resolveDir: join(dirname(fileURLToPath(import.meta.url)), '..'), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error' });
const tmp = join(process.env.TMPDIR || '/tmp', `momogram-import-${process.pid}.mjs`);
writeFileSync(tmp, res.outputFiles[0].text);
const { importGameFile, importFileSet } = await import(pathToFileURL(tmp).href);

if (out) mkdirSync(out, { recursive: true });
const walk = (d, pre = '') => readdirSync(d).flatMap(n => statSync(join(d, n)).isDirectory() ? walk(join(d, n), pre + n + '/') : [pre + n]);
for (const f of args) {
  let results;
  if (statSync(f).isDirectory()) {
    // a game that is a folder (Switch RomFS)
    const names = walk(f);
    results = (await importFileSet({ names, get: async n => new Uint8Array(readFileSync(join(f, n))) })).results;
  } else results = [await importGameFile(basename(f), new Uint8Array(readFileSync(f)))];
  for (const r of results) {
  console.log(`${basename(f)}${r.file && r.file !== basename(f) ? ' (' + r.file + ')' : ''}: ${r.ok ? r.message : 'not imported (' + r.message + ')'}`);
  for (const p of r.packs) {
    const puzzles = p.levels.reduce((n, l) => n + l.puzzles.length, 0);
    const named = p.levels.reduce((n, l) => n + l.puzzles.filter(z => z.name).length, 0);
    console.log(`  ${p.id}  "${Object.values(p.title)[0]}"  ${p.levels.length} levels, ${puzzles} puzzles, ${named} named, ${(p.assets ?? []).length} assets`);
    if (out) {
      const { assets, ...rest } = p;
      writeFileSync(join(out, p.id + '.json'), JSON.stringify({ ...rest, assets: (assets ?? []).map(a => ({ name: a.name, bytes: a.data?.length })) }, null, 1));
      for (const a of assets ?? []) if (/\.ogg$/.test(a.name)) writeFileSync(join(out, p.id + '-' + a.name), a.data);
    }
  }
  }
}
