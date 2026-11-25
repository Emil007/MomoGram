// Cocos Creator 2.x asset bundles, as Android games built with it ship them: assets/assets/<bundle>/ holds
// config.<hash>.json, which lists the bundle's assets (uuids, their paths in the project, and per raw asset a
// version hash), and the raw ("native") files themselves at native/<first two of uuid>/<uuid>.<hash>.<ext>.
// The uuids in the config are often compressed, so a raw file is found by its bundle and version hash.

export interface CocosFiles { names: string[]; get(name: string): Uint8Array | undefined }

/** the bundles in the files: name → its folder */
export function cocosBundles(f: CocosFiles): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of f.names) {
    const m = /^(assets\/assets\/([^/]+)\/)config\.[0-9a-f]+\.json$/i.exec(n);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/** a bundle's raw files by their project path ("101/data"): the file name in the package */
export function cocosRaw(f: CocosFiles, dir: string): Map<string, string> {
  const cfgName = f.names.find(n => n.startsWith(dir) && /^config\.[0-9a-f]+\.json$/i.test(n.slice(dir.length)));
  const out = new Map<string, string>();
  if (!cfgName) return out;
  let cfg: any;
  try { cfg = JSON.parse(new TextDecoder().decode(f.get(cfgName))); } catch { return out; }
  const byHash = new Map<string, string>();
  for (const n of f.names) {
    const m = n.startsWith(dir + 'native/') && /\.([0-9a-f]+)\.[a-z0-9]+$/i.exec(n);
    if (m) byHash.set(m[1], n);
  }
  const uuids: string[] = cfg.uuids ?? [], native: Array<number | string> = cfg.versions?.native ?? [];
  for (let i = 0; i + 1 < native.length; i += 2) {
    const idx = typeof native[i] === 'number' ? native[i] as number : uuids.indexOf(native[i] as string);
    const path = cfg.paths?.[idx]?.[0], file = byHash.get(String(native[i + 1]));
    if (typeof path === 'string' && file) out.set(path, file);
  }
  return out;
}
