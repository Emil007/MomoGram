// Builds the web app into dist/web. `node build.mjs --watch` for development.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const out = 'dist/web';
mkdirSync(out, { recursive: true });
cpSync('web', out, { recursive: true });
for (const f of ['worker-bundle.js', 'libarchive.wasm']) cpSync(`node_modules/libarchive.js/dist/${f}`, `${out}/${f}`);
const opts = {
  // worklet.js: the sound chip emulation running on the audio thread (pack music from GB / SNES games)
  entryPoints: { app: 'src/main.ts', worklet: 'src/audio/worklet.ts' },
  bundle: true, minify: true, sourcemap: true, target: ['es2020', 'safari15'],
  outdir: out, define: { '__VERSION__': JSON.stringify(pkg.version) }, logLevel: 'info',
};
if (process.argv.includes('--watch')) (await esbuild.context(opts)).watch();
else await esbuild.build(opts);
// service worker cache list (offline play / installable web app)
writeFileSync(`${out}/sw.js`, `const C='momogram-${pkg.version}';const F=['./','index.html','app.js','app.css','worklet.js','icon.svg','manifest.webmanifest'];
self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.addAll(F))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x))))));
self.addEventListener('fetch',e=>e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))));`);
