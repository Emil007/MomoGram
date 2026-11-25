// Android packages: the game an importer reads comes as an .apk, or as one of the wrappers app stores and backup
// tools put split installs in (.xapk from APKPure, .apkm from APKMirror, .apks from SAI): zips holding the base APK
// next to configuration splits (languages, screen densities, native code). All of them come down to the base APK,
// which holds the game's assets.
//
// Read here: the binary AndroidManifest.xml (package, version, the app's label and icon), resources.arsc (to look
// the label and icon up per language and screen density), and the launcher icon itself (PNG layers; WebP where the
// browser can decode it; adaptive icons are put together from their background and foreground).
// Written from the documented file formats (Android's ResourceTypes.h).
import { Text, PackIcon, makeIcon } from '../packs/format';
import { Zip, openZip } from './zip';
import { Rgba, decodePng, isPng, over, shrink } from './png';

// ---------------------------------------------------------------- string pools and binary XML

class StringPool {
  private cache = new Map<number, string>();
  readonly count: number;
  private utf8: boolean; private offs: number; private strs: number;
  constructor(private d: Uint8Array, private dv: DataView, private at: number) {
    this.count = dv.getUint32(at + 8, true);
    this.utf8 = (dv.getUint32(at + 16, true) & 0x100) !== 0;
    this.offs = at + dv.getUint16(at + 2, true);
    this.strs = at + dv.getUint32(at + 20, true);
  }
  get(i: number): string {
    if (i < 0 || i >= this.count) return '';
    let s = this.cache.get(i);
    if (s !== undefined) return s;
    const { d, dv } = this;
    let p = this.strs + dv.getUint32(this.offs + i * 4, true);
    if (this.utf8) {
      p += d[p] & 0x80 ? 2 : 1;                       // length in UTF-16 units
      let n = d[p++];
      if (n & 0x80) n = ((n & 0x7f) << 8) | d[p++];   // length in bytes
      s = new TextDecoder().decode(d.subarray(p, p + n));
    } else {
      let n = dv.getUint16(p, true); p += 2;
      if (n & 0x8000) { n = ((n & 0x7fff) << 16) | dv.getUint16(p, true); p += 2; }
      s = new TextDecoder('utf-16le').decode(d.subarray(p, p + n * 2));
    }
    this.cache.set(i, s);
    return s;
  }
}

/** an attribute value: Res_value's type and data, and its text when it is a string */
export interface ResValue { type: number; data: number; str?: string }
export interface XmlElement { name: string; depth: number; attrs: Map<string, ResValue> }

export const RES_REFERENCE = 0x01, RES_STRING = 0x03;
// attribute names by resource id, for files whose attribute names were stripped
const ATTR_IDS: Record<number, string> = {
  0x01010001: 'label', 0x01010002: 'icon', 0x0101021b: 'versionCode', 0x0101021c: 'versionName',
  0x0101052c: 'roundIcon', 0x01010199: 'drawable', 0x01010003: 'name',
};

/** the elements of a binary XML file (AndroidManifest.xml, compiled res/*.xml), in document order */
export function readBinaryXml(d: Uint8Array): XmlElement[] {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d.length < 8 || dv.getUint16(0, true) !== 0x0003) return [];
  const out: XmlElement[] = [];
  let pool: StringPool | null = null, resIds: number[] = [], depth = 0;
  for (let p = dv.getUint16(2, true); p + 8 <= d.length;) {
    const type = dv.getUint16(p, true), size = dv.getUint32(p + 4, true);
    if (size < 8) break;
    if (type === 0x0001) pool = new StringPool(d, dv, p);
    else if (type === 0x0180) { resIds = []; for (let i = p + 8; i < p + size; i += 4) resIds.push(dv.getUint32(i, true)); }
    else if (type === 0x0102 && pool) {
      const name = pool.get(dv.getUint32(p + 20, true));
      const aStart = dv.getUint16(p + 24, true), aSize = dv.getUint16(p + 26, true), aCount = dv.getUint16(p + 28, true);
      const attrs = new Map<string, ResValue>();
      for (let i = 0; i < aCount; i++) {
        const a = p + 16 + aStart + i * aSize;
        const ni = dv.getUint32(a + 4, true);
        const an = pool.get(ni) || ATTR_IDS[resIds[ni]] || '';
        const raw = dv.getUint32(a + 8, true), vt = d[a + 15], vd = dv.getUint32(a + 16, true);
        attrs.set(an, { type: vt, data: vd, str: vt === RES_STRING ? pool.get(vd) : raw !== 0xffffffff ? pool.get(raw) : undefined });
      }
      out.push({ name, depth: depth++, attrs });
    } else if (type === 0x0103) depth--;
    p += size;
  }
  return out;
}

// ---------------------------------------------------------------- resources.arsc

/** one value of a resource in one configuration */
export interface ResEntry extends ResValue { locale: string; density: number }

interface TypeChunk { at: number; locale: string; density: number }

export class Resources {
  private dv: DataView;
  private global: StringPool | null = null;
  /** per package id, per type id: the chunks (one per configuration) */
  private types = new Map<number, Map<number, TypeChunk[]>>();
  private typeNames = new Map<number, StringPool>();
  constructor(private d: Uint8Array) {
    const dv = this.dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (dv.getUint16(0, true) !== 0x0002) return;
    for (let p = dv.getUint16(2, true); p + 8 <= d.length;) {
      const type = dv.getUint16(p, true), size = dv.getUint32(p + 4, true);
      if (size < 8) break;
      if (type === 0x0001) this.global = new StringPool(d, dv, p);
      else if (type === 0x0200) this.readPackage(p, size);
      p += size;
    }
  }
  private readPackage(at: number, size: number) {
    const { d, dv } = this;
    const id = dv.getUint32(at + 8, true), byType = new Map<number, TypeChunk[]>();
    this.types.set(id, byType);
    this.typeNames.set(id, new StringPool(d, dv, at + dv.getUint32(at + 268, true)));
    for (let p = at + dv.getUint16(at + 2, true); p + 8 <= at + size;) {
      const type = dv.getUint16(p, true), sz = dv.getUint32(p + 4, true);
      if (sz < 8) break;
      if (type === 0x0201) {
        const c = p + 20, csize = dv.getUint32(c, true);
        const lang = csize >= 12 && d[c + 8] && !(d[c + 8] & 0x80) ? String.fromCharCode(d[c + 8], d[c + 9]) : '';
        const country = csize >= 12 && d[c + 10] && !(d[c + 10] & 0x80) ? String.fromCharCode(d[c + 10], d[c + 11]) : '';
        const chunk = { at: p, locale: lang + (country ? '-' + country : ''), density: csize >= 16 ? dv.getUint16(c + 14, true) : 0 };
        const tid = d[p + 8];
        byType.set(tid, [...(byType.get(tid) ?? []), chunk]);
      }
      p += sz;
    }
  }
  /** the type of a resource id ("mipmap", "drawable", "string", …) */
  typeName(id: number): string { return this.typeNames.get(id >>> 24)?.get(((id >> 16) & 0xff) - 1) ?? ''; }
  /** every configuration's value of a resource (references followed) */
  values(id: number, hops = 0): ResEntry[] {
    const chunks = this.types.get(id >>> 24)?.get((id >> 16) & 0xff) ?? [];
    const idx = id & 0xffff, out: ResEntry[] = [];
    for (const c of chunks) {
      const v = this.entry(c.at, idx);
      if (!v) continue;
      if (v.type === RES_REFERENCE && v.data && hops < 8) {
        for (const r of this.values(v.data, hops + 1)) out.push({ ...r, locale: c.locale || r.locale, density: c.density || r.density });
      } else out.push({ ...v, locale: c.locale, density: c.density });
    }
    return out;
  }
  private entry(at: number, idx: number): ResValue | null {
    const { d, dv } = this;
    const flags = d[at + 9], count = dv.getUint32(at + 12, true), start = at + dv.getUint32(at + 16, true);
    const table = at + dv.getUint16(at + 2, true);
    let off = -1;
    if (flags & 0x01) {
      // sparse: (index, offset / 4) pairs sorted by index
      let lo = 0, hi = count - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1, k = dv.getUint16(table + m * 4, true);
        if (k === idx) { off = dv.getUint16(table + m * 4 + 2, true) * 4; break; }
        if (k < idx) lo = m + 1; else hi = m - 1;
      }
    } else if (idx < count) {
      if (flags & 0x02) { const v = dv.getUint16(table + idx * 2, true); off = v === 0xffff ? -1 : v * 4; }
      else { const v = dv.getUint32(table + idx * 4, true); off = v === 0xffffffff ? -1 : v; }
    }
    if (off < 0) return null;
    const e = start + off;
    if (e + 8 > d.length) return null;
    const esize = dv.getUint16(e, true), eflags = dv.getUint16(e + 2, true);
    let type: number, data: number;
    if (eflags & 0x08) { type = eflags >> 8; data = dv.getUint32(e + 4, true); }   // compact entry
    else if (eflags & 0x01) return null;                                           // a bag (style, array)
    else { type = d[e + esize + 3]; data = dv.getUint32(e + esize + 4, true); }
    return { type, data, str: type === RES_STRING ? this.global?.get(data) : undefined };
  }
}

// ---------------------------------------------------------------- the package

export interface Apk {
  /** package name, version as the manifest gives them */
  pkg: string;
  versionName: string;
  versionCode: number;
  /** the base APK */
  base: Zip;
  /** the wrapper the base APK came in (.xapk, .apkm, .apks), if any */
  outer: Zip | null;
  manifest: XmlElement[];
  res: Resources | null;
  /** a file of the base APK, else of the splits */
  get(name: string): Uint8Array | undefined;
  /** paths in the base APK and in every configuration split (asset packs included) */
  readonly names: string[];
}

const opened = new WeakMap<Uint8Array, Apk | null>();

/**
 * The Android package in a file (an .apk, or a wrapper holding one), or null. Opened once per file: every importer's
 * detect asks for the same bytes, and only the first call does the work.
 */
export function openApk(data: Uint8Array): Apk | null {
  if (opened.has(data)) return opened.get(data)!;
  let apk: Apk | null = null;
  try { apk = open(data); } catch { apk = null; }
  opened.set(data, apk);
  return apk;
}

function open(data: Uint8Array): Apk | null {
  const z = openZip(data);
  if (!z) return null;
  let base = z, outer: Zip | null = null, splits: string[] = [];
  if (!z.has('AndroidManifest.xml')) {
    // XAPK / APKM / APKS sometimes put base.apk in a subdirectory; the file name is what matters
    const leaf = (n: string) => n.slice(n.lastIndexOf('/') + 1).toLowerCase();
    const inner = z.names.filter(n => /\.apk$/i.test(leaf(n)));
    if (!inner.length) return null;
    // the wrapper names its package (APKPure: manifest.json, APKMirror: info.json); its base APK is "base.apk",
    // "<package>.apk", or the one APK that isn't a configuration split
    let pkg = '';
    for (const j of ['manifest.json', 'info.json']) {
      try { const m = JSON.parse(new TextDecoder().decode(z.get(j))); pkg = m.package_name || m.pname || pkg; } catch { /* none */ }
    }
    const isSplit = (n: string) => /^(config\.|split_)/i.test(leaf(n));
    const byLeaf = (want: string) => inner.filter(n => leaf(n) === want).sort((a, b) => a.split('/').length - b.split('/').length)[0];
    const name = byLeaf('base.apk') ?? (pkg ? byLeaf(pkg.toLowerCase() + '.apk') : undefined) ??
      inner.filter(n => !isSplit(n)).sort((a, b) => z.size(b) - z.size(a))[0];
    const bytes = name ? z.get(name) : undefined;
    const b = bytes && openZip(bytes);
    if (!b || !b.has('AndroidManifest.xml')) return null;
    base = b; outer = z; splits = inner.filter(n => n !== name);
  }
  const manifest = readBinaryXml(base.get('AndroidManifest.xml') ?? new Uint8Array());
  const root = manifest.find(e => e.name === 'manifest');
  // a configuration split on its own holds no game
  if (!root || root.attrs.has('split')) return null;
  const arsc = base.get('resources.arsc');
  const splitZips = new Map<string, Zip | null>();
  let namesCache: string[] | null = null;
  return {
    pkg: root.attrs.get('package')?.str ?? '',
    versionName: root.attrs.get('versionName')?.str ?? '',
    versionCode: root.attrs.get('versionCode')?.data ?? 0,
    base, outer, manifest,
    res: arsc ? new Resources(arsc) : null,
    get names() {
      if (namesCache) return namesCache;
      const out = [...base.names];
      const seen = new Set(out);
      if (outer) {
        for (const s of splits) {
          if (!splitZips.has(s)) { const b = outer.get(s); splitZips.set(s, b ? openZip(b) : null); }
          for (const n of splitZips.get(s)?.names ?? []) if (!seen.has(n)) { seen.add(n); out.push(n); }
        }
      }
      namesCache = out;
      return out;
    },
    get(name) {
      const f = base.get(name);
      if (f || !outer) return f;
      for (const s of splits) {
        if (!splitZips.has(s)) { const b = outer.get(s); splitZips.set(s, b ? openZip(b) : null); }
        const v = splitZips.get(s)?.get(name);
        if (v) return v;
      }
      return undefined;
    },
  };
}

/** the app's name in every language it has (the default one as English) */
export function apkLabel(apk: Apk): Text {
  const v = apk.manifest.find(e => e.name === 'application')?.attrs.get('label');
  if (!v) return {};
  if (v.type !== RES_REFERENCE) return v.str ? { en: v.str } : {};
  const out: Record<string, string> = {};
  for (const e of apk.res?.values(v.data) ?? []) {
    if (e.type !== RES_STRING || !e.str) continue;
    const lang = e.locale.split('-')[0] || 'en';
    if (['en', 'de', 'fr', 'it', 'es', 'ja', 'ko'].includes(lang) && (!out[lang] || !e.locale.includes('-'))) out[lang] = e.str;
  }
  return out;
}

// ---------------------------------------------------------------- the launcher icon

async function decodeImage(d: Uint8Array): Promise<Rgba | null> {
  if (isPng(d)) return decodePng(d);
  // WebP and anything else: only where the platform decodes images (the browser, Electron)
  const g = globalThis as any;
  if (typeof g.createImageBitmap !== 'function' || typeof g.OffscreenCanvas !== 'function') return null;
  try {
    const bmp = await g.createImageBitmap(new Blob([d as Uint8Array<ArrayBuffer>]));
    const c = new g.OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d');
    x.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, px: new Uint8Array(x.getImageData(0, 0, bmp.width, bmp.height).data.buffer) };
  } catch { return null; }
}

/** a drawable as a picture: the biggest bitmap among its densities, a colour, or an adaptive icon's layers */
async function drawable(apk: Apk, id: number, depth = 0): Promise<Rgba | null> {
  const vals = (apk.res?.values(id) ?? []).filter(v => v.type === RES_STRING || (v.type >= 0x1c && v.type <= 0x1f));
  // densities: 0 = default, 0xfffe = none, 0xffff = any (vector / adaptive XML)
  const rank = (v: ResEntry) => (v.density === 0xffff ? -1 : v.density === 0xfffe ? 0 : v.density || 1);
  vals.sort((a, b) => rank(b) - rank(a));
  for (const v of vals) {
    if (v.type !== RES_STRING) {
      const c = v.data;   // ARGB
      const px = new Uint8Array(4 * 4);
      for (let i = 0; i < 4; i++) px.set([(c >> 16) & 255, (c >> 8) & 255, c & 255, c >>> 24], i * 4);
      return { w: 2, h: 2, px };
    }
    const f = apk.get(v.str!);
    if (!f) continue;
    if (/\.xml$/i.test(v.str!)) {
      if (depth > 2) continue;
      const pic = await adaptive(apk, readBinaryXml(f), depth);
      if (pic) return pic;
      continue;
    }
    const img = await decodeImage(f);
    if (img) return img;
  }
  return null;
}

/** an adaptive icon: its foreground over its background, cut to the part a launcher shows (the middle 72 of 108) */
async function adaptive(apk: Apk, xml: XmlElement[], depth: number): Promise<Rgba | null> {
  if (xml[0]?.name !== 'adaptive-icon') return null;
  const layer = async (name: string) => {
    const v = xml.find(e => e.name === name)?.attrs.get('drawable');
    return v && v.type === RES_REFERENCE ? drawable(apk, v.data, depth + 1) : null;
  };
  const fg = await layer('foreground'), bg = await layer('background');
  const size = Math.max(fg?.w ?? 0, bg?.w ?? 0);
  if (size < 8) return null;
  let full: Rgba = { w: size, h: size, px: new Uint8Array(size * size * 4) };
  if (bg) full = over(full, bg);
  if (fg) full = over(full, fg);
  const m = Math.round(full.w / 6), n = full.w - 2 * m, px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) px.set(full.px.subarray(((y + m) * full.w + m) * 4, ((y + m) * full.w + m + n) * 4), y * n * 4);
  return { w: n, h: n, px };
}

/**
 * The app's launcher icon as a pack icon (at most `max` pixels wide): looked up through the manifest and
 * resources.arsc, so renamed or obfuscated resource files are found too; the wrapper's icon.png if that fails.
 */
export async function apkIcon(apk: Apk, max = 64): Promise<PackIcon | undefined> {
  const app = apk.manifest.find(e => e.name === 'application');
  let img: Rgba | null = null;
  for (const k of ['icon', 'roundIcon']) {
    const v = app?.attrs.get(k);
    if (v?.type === RES_REFERENCE && (img = await drawable(apk, v.data))) break;
  }
  if (!img && apk.outer?.has('icon.png')) img = await decodeImage(apk.outer.get('icon.png')!);
  if (!img) return undefined;
  const s = shrink(img, max);
  return makeIcon(s.w, s.h, s.px);
}
