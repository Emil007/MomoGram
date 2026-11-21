// Builds the web app into dist/web. `node build.mjs --watch` for development.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const out = 'dist/web';
mkdirSync(out, { recursive: true });
cpSync('web', out, { recursive: true });
for (const f of ['worker-bundle.js', 'libarchive.wasm']) cpSync(`node_modules/libarchive.js/dist/${f}`, `${out}/${f}`);
// every import method is one file in src/packs/importers: register them all (new files need no other change)
const importerFiles = readdirSync('src/packs/importers').filter(f => f.endsWith('.ts') && !['index.ts', 'all.ts'].includes(f)).sort();
const allTs = '// Written by build.mjs: loads every import method in this folder. Do not edit.\n' + importerFiles.map(f => `import './${f.replace(/\.ts$/, '')}';`).join('\n') + '\n';
if (readFileSync('src/packs/importers/all.ts', 'utf8') !== allTs) writeFileSync('src/packs/importers/all.ts', allTs);
const opts = {
  // worklet.js: the sound chip emulation running on the audio thread (pack music from GB / SNES games)
  entryPoints: { app: 'src/main.ts', worklet: 'src/audio/worklet.ts' },
  bundle: true, minify: true, sourcemap: true, target: ['es2020', 'safari15'],
  outdir: out, define: { '__VERSION__': JSON.stringify(pkg.version) }, logLevel: 'info',
};
if (process.argv.includes('--watch')) (await esbuild.context(opts)).watch();
else await esbuild.build(opts);
// service worker (offline play / installable web app). The cache name carries a hash of the build, so every
// deploy replaces the old cache; pages and app files are fetched network-first, so updates show up on the next
// start and the cache is only the offline fallback.
// what the running app compares itself with to offer an update (home screen)
writeFileSync(`${out}/version.json`, JSON.stringify({ version: pkg.version }));
const files = ['./', 'index.html', 'app.js', 'app.css', 'worklet.js', 'icon.svg', 'manifest.webmanifest'];
const hash = createHash('sha1');
for (const f of ['app.js', 'app.css', 'worklet.js', 'index.html']) { try { hash.update(readFileSync(`${out}/${f}`)); } catch { /* not built */ } }
writeFileSync(`${out}/sw.js`, `const C='momogram-${pkg.version}-${hash.digest('hex').slice(0, 10)}';const F=${JSON.stringify(files)};
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(F)))});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return;
e.respondWith(fetch(r.url,{cache:'no-cache',credentials:'same-origin'}).then(res=>{if(res.ok){const c=res.clone();caches.open(C).then(x=>x.put(r,c))}return res}).catch(()=>caches.match(r).then(m=>m||caches.match('index.html'))))});`);
