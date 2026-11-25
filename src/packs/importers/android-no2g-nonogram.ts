// No2g: Nonogram (com.mkene.no2g, MKene) — nonogram puzzles from its Cocos2d-x Android app.
//
// The game is a Cocos2d-x (ARM, C++) app; its whole catalogue ships in the base APK under
// `assets/packages/`: 161 `.pkg` files, one per pack (theme / story / UGC pack). Each `.pkg` is a
// ZipCrypto (PKWARE "traditional", general-purpose flag 0x1) encrypted zip.
//
// The shared ZipCrypto password is not a stored literal; it is derived per package at runtime:
//
//     password = "~!@#$%^&*()_+"  +  base64( SHA1( "com.mkene.no2g." + <package stem> ) )
//
// (Package::Package(string,bool) in libMyGame.so 2.119.3 copies a 13-byte rodata prefix
// "~!@#$%^&*()_+", SHA1s "com.mkene.no2g." + the package name, base64-encodes the 20-byte digest
// and appends; cocos2d::ZipFile uses that whole string as minizip's unzOpenCurrentFilePassword.
// All 161 shipped packages open with this scheme — every entry of every package decodes; see the
// _code extract and VERIFIED.md for the evidence, plus the SHA1 / ZipCrypto and pack build maps.)
//
// Each package zip holds:
//   index.json   the pack's localised metadata: "__pkg_name__" per language (en, ko, ja) is the
//                pack title; every other key is a puzzle id -> its name in that language. (Some
//                packages also carry "__desc__" — also metadata, not a puzzle.)
//   <stem>.png / <name>_<n>.png   one puzzle per PNG (plus a 256×256 icon.png / icon_pressed.png).
//                The PNG itself IS the solved picture: palette (color type 3, bit depth 2 or 8),
//                palette = black (opaque) + transparent. No2g is a monotone black/white nonogram:
//                the stored picture is the solution; row/column clue runs follow from it.
//
// File names encode puzzle number in two conventions (the game is inconsistent across packages):
//   "10_01_rabbit"   -> size 10, number 01   (the common convention)
//   "01_30.png"      -> number 01, size 30   (ugc_22 and a few others put the number first)
// The PNG's own IHDR width/height is the authoritative size; the first numeric token is kept as the
// puzzle's number (leading zeros removed for a natural sort). A puzzle whose id is absent from
// index.json (11 puzzles in ugc_22) is still imported, unnamed.
//
// Sizes present across the catalogue: 5, 10, 15, 20, 25, 30 (always square). The counts:
//   5×5 115, 10×10 260, 15×15 260, 20×20 383, 25×25 365, 30×30 1455 = 8 398 puzzle puzzles;
//   plus 1 puzzle whose PNG is 5×5 in a 32-puzzle pack appears as a 5 in the sizes above; the
//   package-level total is 8 399 puzzles across 159 puzzle packages ("more" and "user_puzzles"
//   carry only icons + an index.json with no puzzle keys, so they are skipped).
//
// No MEGA and no COLOUR modes exist. The PNGs' palettes resolve to at most black + transparent, and
// the few PNGs with more RGBA values are grey anti-aliasing around black edges (no colour with an
// area share > 1 %, no coherent colour regions — see ANALYSIS.md); there is no companion mega/colour
// data file anywhere in the APK (verified by scanning every .pkg's entries and every native buffer).
// The task's pack-icon requirement is met by shipping each package's own 256×256 icon.png: it is
// decoded to the pack icon (makeIcon) and the raw PNG is carried as a pack asset "<pkg>-icon.png".
//
// Container-agnostic by design (owner requirement): detect/read never gate on the file extension
// (.apk / .xapk / .apkm / .zip / a picked folder are all fine). The real markers that decide are
//   - the binary AndroidManifest.xml with the package "com.mkene.no2g" (and versionName 2.119.3),
//   - the packages: assets/packages/<stem>.pkg ZipCrypto zips whose index.json carries "__pkg_name__"
//     and whose puzzle PNGs decode as square black/white grids; several packages must decode.
// .xapk / .apkm are zips holding the base APK (com.mkene.no2g.apk — itself a zip with those assets)
// next to language/abi splits, so unzipping recursively and matching the markers works for every
// distribution. An already-extracted base APK or a picked folder is handled by the Set variant
// below (same read path).
import { registerImporter, registerSetImporter, GameFiles } from './index';
import { Pack, PackLevel, PackPuzzle, makeIcon, PackIcon } from '../format';
import { unzipSync, inflateSync, unzlibSync } from 'fflate';
// package groups use chapter-style folders (20 packs per group) — see packFromEntries

// ---------------------------------------------------------------- container unwrapping

type Entry = { name: string; data: Uint8Array };

const PKG_RE = /^assets\/packages\/([^\/]+)\.pkg$/i;

function containsAscii(d: Uint8Array, needle: string): boolean {
  const nd = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + nd.length <= d.length; i++) {
    for (let j = 0; j < nd.length; j++) if (d[i + j] !== nd[j]) continue outer;
    return true;
  }
  return false;
}
function containsUtf16(d: Uint8Array, needle: string): boolean {
  const nd = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + nd.length * 2 <= d.length; i += 2) {
    for (let j = 0; j < nd.length; j++) if (d[i + j * 2] !== nd[j] || d[i + j * 2 + 1] !== 0) continue outer;
    return true;
  }
  return false;
}

/** true when this entry set is (or looks like) No2g's packages + manifest. */
function hasManifestPackage(entries: Entry[]): boolean {
  const m = entries.find(e => /^AndroidManifest\.xml$/i.test(e.name));
  return !!m && (containsUtf16(m.data, 'com.mkene.no2g') || containsAscii(m.data, 'com.mkene.no2g'));
}

/** true when a good spread of the game's packages is present (+ the manifest, or enough other markers). */
function looksLike(entries: Entry[]): boolean {
  const pkgs = entries.filter(e => PKG_RE.test(e.name)).length;
  const plists = entries.filter(e => /^assets\/no2g\d?\.plist$/i.test(e.name)).length;
  return pkgs >= 1 && (hasManifestPackage(entries) || pkgs >= 2 || plists >= 2);
}

function unzipAll(data: Uint8Array): Entry[] {
  const files = unzipSync(data);
  return Object.entries(files).filter(([n]) => !n.endsWith('/')).map(([name, d]) => ({ name, data: d as Uint8Array }));
}

/** recursively unwrap a container until the game's markers are on top (XAPK → base APK → assets). */
export function entriesOf(data: Uint8Array, depth = 0): Entry[] {
  if (depth > 4) throw new Error('Too many nested containers.');
  let entries: Entry[];
  try { entries = unzipAll(data); } catch { return []; }
  if (looksLike(entries)) return entries;
  const inner = entries.filter(e => /\.(apk|zip)$/i.test(e.name)).sort((a, b) => b.data.length - a.data.length)[0];
  if (inner) {
    const sub = entriesOf(inner.data, depth + 1);
    if (sub.length && looksLike(sub)) return sub;
  }
  return entries;
}

// ---------------------------------------------------------------- SHA-1 (pure JS)

/** SHA-1 digest of a byte string (RFC 3174), as bytes. Pure JS, works in Node and the browser. */
function sha1Bytes(msg: Uint8Array): Uint8Array {
  const rl = (n: number, s: number) => ((n << s) | (n >>> (32 - s))) >>> 0;
  let H0 = 0x67452301, H1 = 0xEFCDAB89, H2 = 0x98BADCFE, H3 = 0x10325476, H4 = 0xC3D2E1F0;
  const l = msg.length;
  const M = new Uint8Array((((l + 8) >> 6) + 1) << 6);
  M.set(msg, 0); M[l] = 0x80;
  const dv = new DataView(M.buffer);
  dv.setUint32(M.length - 8, Math.floor(l / 0x20000000) >>> 0);
  dv.setUint32(M.length - 4, (l * 8) >>> 0);
  const W = new Array<number>(80);
  for (let B = 0; B < M.length; B += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(B + i * 4);
    for (let i = 16; i < 80; i++) W[i] = rl((W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16]) >>> 0, 1);
    let a = H0, b = H1, c = H2, d = H3, e = H4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const T = (rl(a, 5) + (f >>> 0) + e + k + W[i]) >>> 0;
      e = d; d = c; c = rl(b, 30); b = a; a = T;
    }
    H0 = (H0 + a) >>> 0; H1 = (H1 + b) >>> 0; H2 = (H2 + c) >>> 0; H3 = (H3 + d) >>> 0; H4 = (H4 + e) >>> 0;
  }
  const o = new Uint8Array(20);
  const put = (n: number, i: number) => { o[i] = n >>> 24; o[i + 1] = (n >>> 16) & 0xff; o[i + 2] = (n >>> 8) & 0xff; o[i + 3] = n & 0xff; };
  put(H0, 0); put(H1, 4); put(H2, 8); put(H3, 12); put(H4, 16);
  return o;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64Encode(d: Uint8Array): string {
  let s = '';
  for (let i = 0; i < d.length; i += 3) {
    const a = d[i], b = i + 1 < d.length ? d[i + 1] : 0, c = i + 2 < d.length ? d[i + 2] : 0;
    s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < d.length ? B64[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < d.length ? B64[c & 63] : '=');
  }
  return s;
}

/** the shared ZipCrypto password for a package: "~!@#$%^&*()_+" + base64(SHA1("com.mkene.no2g." + stem)). */
export function zipPassword(stem: string): Uint8Array {
  const digest = sha1Bytes(new TextEncoder().encode('com.mkene.no2g.' + stem));
  return new TextEncoder().encode('~!@#$%^&*()_+' + b64Encode(digest));
}

// ---------------------------------------------------------------- ZipCrypto (traditional)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();

/**
 * Decrypt ZipCrypto streams. The 12-byte encryption header and the ciphertext are ONE keystream:
 * pass them as consecutive parts (header first). The keystream continues across the parts.
 */
function zipCryptoDecrypt(password: Uint8Array, parts: Array<Uint8Array>): Array<Uint8Array> {
  let k0 = 0x12345678 >>> 0, k1 = 0x23456789 >>> 0, k2 = 0x34567890 >>> 0;
  const crcByte = (crc: number, ch: number) => ((crc >>> 8) ^ CRC_TABLE[(crc ^ ch) & 0xff]) >>> 0;
  const upd = (ch: number) => {
    k0 = crcByte(k0, ch);
    k1 = (k1 + (k0 & 0xff)) >>> 0;
    k1 = (Math.imul(k1, 134775813) + 1) >>> 0;
    k2 = crcByte(k2, (k1 >>> 24) & 0xff);
  };
  for (let i = 0; i < password.length; i++) upd(password[i]);
  return parts.map(part => {
    const out = new Uint8Array(part.length);
    for (let i = 0; i < part.length; i++) {
      const k = k2 | 2;
      const d = (Math.imul(k, k ^ 1) >>> 8) & 0xff;
      const p = part[i] ^ d;
      upd(p);
      out[i] = p;
    }
    return out;
  });
}

// ---------------------------------------------------------------- a zip reader for the encrypted packages

interface ZipEntry { name: string; method: number; encrypted: boolean; csize: number; usize: number; local: number }

/** read every entry of a (possibly ZipCrypto) zip from its central directory. */
export function zipEntries(d: Uint8Array): ZipEntry[] {
  let eocd = -1;
  for (let p = d.length - 22; p >= Math.max(0, d.length - 70000); p--) {
    if (d[p] === 0x50 && d[p + 1] === 0x4b && d[p + 2] === 0x05 && d[p + 3] === 0x06) { eocd = p; break; }
  }
  if (eocd < 0) return [];
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const num = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  for (let i = 0; i < num; i++) {
    if (p + 46 > d.length || dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const fnl = dv.getUint16(p + 28, true);
    const exl = dv.getUint16(p + 30, true);
    const cml = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(d.subarray(p + 46, p + 46 + fnl));
    out.push({ name, method, encrypted: (flags & 1) !== 0, csize, usize, local });
    p += 46 + fnl + exl + cml;
  }
  return out;
}

/** decrypt + decompress one entry into its plaintext (method 0 stored / method 8 deflate). */
export function readZipEntry(d: Uint8Array, e: ZipEntry, password: Uint8Array): Uint8Array | null {
  if (e.name.endsWith('/')) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (e.local + 30 > d.length) return null;
  const fnl = dv.getUint16(e.local + 26, true), exl = dv.getUint16(e.local + 28, true);
  const dataStart = e.local + 30 + fnl + exl;
  if (dataStart + e.csize > d.length) return null;
  let plain: Uint8Array;
  if (e.encrypted) {
    const [, body] = zipCryptoDecrypt(password, [d.subarray(dataStart, dataStart + 12), d.subarray(dataStart + 12, dataStart + e.csize)]);
    plain = body;
  } else {
    plain = d.subarray(dataStart, dataStart + e.csize);
  }
  if (e.method === 8) { try { return inflateSync(plain); } catch { return null; } }
  if (e.method === 0) return plain;
  return null;
}

// ---------------------------------------------------------------- palette PNG decoder + rows

interface Grid { w: number; h: number; rows: string[]; rgba: Uint8Array }

/**
 * Decode a No2g PNG to RGBA + the black/white rows. Handles colour type 3 (palette, with optional
 * tRNS transparency) plus 0/2/6 RGB·A, bit depths 8 (and 1/2/4 for palette), non-interlaced.
 */
export function pngGrid(d: Uint8Array): Grid | null {
  if (d.length < 33 || d[0] !== 0x89 || d[1] !== 0x50 || d[2] !== 0x4e || d[3] !== 0x47) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const w = dv.getUint32(16), h = dv.getUint32(20);
  if (!(w >= 1 && w <= 1024 && h >= 1 && h <= 1024)) return null;
  const depth = d[24], ctype = d[25], interlace = d[28];
  if (interlace !== 0) return null;
  let bppc = 0; // bytes per complete pixel-ish (for filtering stride we use the byte stride of a row)
  let bits = 0;
  if (ctype === 3) { if (!(depth === 1 || depth === 2 || depth === 4 || depth === 8)) return null; bits = depth; }
  else if (ctype === 0) { if (depth !== 8 && depth !== 16) return null; bits = depth; bppc = depth === 16 ? 2 : 1; }
  else if (ctype === 2) { if (depth !== 8 && depth !== 16) return null; bits = depth; bppc = depth === 16 ? 6 : 3; }
  else if (ctype === 4) { if (depth !== 8 && depth !== 16) return null; bits = depth; bppc = depth === 16 ? 4 : 2; }
  else if (ctype === 6) { if (depth !== 8 && depth !== 16) return null; bits = depth; bppc = depth === 16 ? 8 : 4; }
  else return null;
  const bppBits = ctype === 3 ? bits : bppc * 8;
  const stride = Math.ceil((w * bppBits) / 8);

  const idats: Uint8Array[] = [];
  let pal: Uint8Array | null = null, trns: Uint8Array | null = null;
  let o = 8;
  while (o + 12 <= d.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(d[o + 4], d[o + 5], d[o + 6], d[o + 7]);
    const body = d.subarray(o + 8, o + 8 + len);
    if (type === 'IEND') break;
    if (type === 'PLTE') pal = body;
    if (type === 'tRNS') trns = body;
    if (type === 'IDAT') idats.push(body);
    o += 12 + len;
  }
  if (!idats.length || (ctype === 3 && !pal)) return null;
  let tl = 0; for (const id of idats) tl += id.length;
  const all = new Uint8Array(tl); let at = 0; for (const id of idats) { all.set(id, at); at += id.length; }
  let raw: Uint8Array;
  try { raw = unzlibSync(all); } catch { try { raw = inflateSync(all); } catch { return null; } }
  if (raw.length < (stride + 1) * h) return null;

  const pal0 = pal ?? new Uint8Array(0);
  const ncol = ctype === 3 ? Math.floor(pal0.length / 3) : 0;
  const rgba = new Uint8Array(w * h * 4);
  const trns0 = trns;

  // per-pixel read given an unfiltered byte row
  const readPx = (row: Uint8Array, x: number): number[] => {
    if (ctype === 3) {
      if (depth === 8) {
        const idx = row[x];
        const px = [0, 0, 0, 255];
        if (idx < ncol) { px[0] = pal0[idx * 3]; px[1] = pal0[idx * 3 + 1]; px[2] = pal0[idx * 3 + 2]; }
        if (trns0 && idx < trns0.length) px[3] = trns0[idx];
        return px;
      }
      const per = (bits * 1);
      const bitOff = x * bits;
      const byte = bitOff >> 3, shift = 8 - bits - (bitOff & 7);
      const idx = (row[byte] >> shift) & ((1 << bits) - 1);
      const px = [0, 0, 0, 255];
      if (idx < ncol) { px[0] = pal0[idx * 3]; px[1] = pal0[idx * 3 + 1]; px[2] = pal0[idx * 3 + 2]; }
      if (trns0 && idx < trns0.length) px[3] = trns0[idx];
      return px;
    }
    const chans = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 4 ? 2 : 4;
    const byts = depth === 16 ? 2 : 1;
    const ch = (i: number) => {
      const off = x * chans * byts + i * byts;
      if (byts === 2) return row[off] * 256 + row[off + 1];
      return row[off];
    };
    if (ctype === 0) return [ch(0), ch(0), ch(0), 255];
    if (ctype === 2) return [ch(0), ch(1), ch(2), 255];
    if (ctype === 4) return [ch(0), ch(1), ch(2), ch(3)]; // gray+alpha: treat 'a' as alpha of grey? fill rg from g
    // ctype 6
    return [ch(0), ch(1), ch(2), ch(3)];
  };

  const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let p = 0;
  const bpp = Math.max(1, Math.ceil(bppBits / 8));
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const f = raw[p + x];
      cur[x] = filter === 0 ? f : filter === 1 ? (f + a) & 0xff : filter === 2 ? (f + b) & 0xff :
        filter === 3 ? (f + ((a + b) >> 1)) & 0xff : (f + paeth(a, b, c)) & 0xff;
    }
    p += stride;
    for (let x = 0; x < w; x++) {
      const px = readPx(cur, x);
      const di = (y * w + x) * 4;
      rgba[di] = px[0]; rgba[di + 1] = px[1]; rgba[di + 2] = px[2]; rgba[di + 3] = px[3];
    }
    prev.set(cur);
  }
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) s += rgba[(y * w + x) * 4 + 3] > 128 ? '#' : '.';
    rows.push(s);
  }
  return { w, h, rows, rgba };
}

// ---------------------------------------------------------------- pack building

type TextMap = Partial<Record<'en' | 'ko' | 'ja', string>>;
function localized(t: string): TextMap { return { en: t, ko: t, ja: t }; }

function parseIndex(idxData: Uint8Array | null): Map<string, TextMap> {
  const out = new Map<string, TextMap>();
  if (!idxData) return out;
  let json: any;
  try { json = JSON.parse(new TextDecoder().decode(idxData)); } catch { return out; }
  for (const lang of ['en', 'ko', 'ja'] as const) {
    const jl = json[lang];
    if (!jl || typeof jl !== 'object') continue;
    for (const k of Object.keys(jl)) {
      if (k === '__pkg_name__' || k === '__desc__') continue;
      const base = out.get(k) ?? {} as TextMap;
      (base as any)[lang] = jl[k];
      out.set(k, base);
    }
  }
  return out;
}

interface PkgPart { id: string; title: TextMap; puzzles: PackPuzzle[]; theme: Pack['theme']; icon?: PackIcon; iconPng?: Uint8Array }

/** decode one package zip into a MomoGram pack-part (its group). */
function partOfPackage(zipBytes: Uint8Array, stem: string, containerIcon?: Uint8Array): PkgPart | null {
  const entries = zipEntries(zipBytes);
  if (!entries.length) return null;
  const pw = zipPassword(stem);
  let idxData: Uint8Array | null = null;
  let pkgTitle: TextMap | null = null;
  let iconPng: Uint8Array | null = containerIcon ?? null;
  const pngs: Array<{ name: string; rows: string[]; w: number; h: number }> = [];

  for (const e of entries) {
    const plain = readZipEntry(zipBytes, e, pw);
    if (!plain) continue;
    const low = e.name.toLowerCase();
    if (low === 'index.json') {
      idxData = plain;
      try {
        const j = JSON.parse(new TextDecoder().decode(plain));
        pkgTitle = { en: j.en?.__pkg_name__ ?? stem, ko: j.ko?.__pkg_name__ ?? stem, ja: j.ja?.__pkg_name__ ?? stem };
      } catch { /* keep default */ }
    } else if (low === 'icon.png' && !iconPng) {
      iconPng = plain;
    } else if (low.endsWith('.png') && !low.startsWith('icon')) {
      const g = pngGrid(plain);
      if (g) pngs.push({ name: e.name, rows: g.rows, w: g.w, h: g.h });
    }
  }
  if (!pngs.length) return null; // "more" / "user_puzzles": no grids -> not a puzzle pack

  const names = parseIndex(idxData);
  pngs.sort((a, b) => {
    const na = a.name.replace(/\.png$/i, ''), nb = b.name.replace(/\.png$/i, '');
    // the game shows puzzles in file-name order; most packages encode a number, ai_* packs encode a size front
    const numA = na.split('_').filter(t => /^\d+$/.test(t))[0];
    const numB = nb.split('_').filter(t => /^\d+$/.test(t))[0];
    if (numA !== undefined && numB !== undefined && numA !== numB) return Number(numA) - Number(numB);
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
  const puzzles: PackPuzzle[] = pngs.map((p, i) => {
    const base = p.name.replace(/\.png$/i, '');
    const nums = base.split('_').filter(t => /^\d+$/.test(t));
    // the conventional position of a puzzle's own number: the second token in "<sz>_<num>_<name>",
    // or the first token in "<num>_<sz>.png" (ugc_22). ai_* packs carry no puzzle number (only size)
    const numToken = nums.length > 1 ? nums[1] : nums[0];
    const idx = String(i + 1).padStart(3, '0');
    const name = names.get(base);
    const puzzle: PackPuzzle = {
      id: `${numToken || 'x'}-${idx}`,
      width: p.w, height: p.h, rows: p.rows,
    };
    if (name && Object.keys(name).length) puzzle.name = name;
    return puzzle;
  });

  // dedupe puzzle ids (a sharp-edged file name with '_s' or extra tokens could collide after sanitising)
  const seenIds = new Set<string>();
  for (const z of puzzles) {
    if (seenIds.has(z.id)) { let n = 2; while (seenIds.has(`${z.id}~${n}`)) n++; z.id = `${z.id}~${n}`; }
    seenIds.add(z.id);
  }

  const title = pkgTitle ?? localized(stem);
  const pack: Pack = {
    format: 'momogram-pack', version: 1,
    id: `android-no2g-${stem.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
    title,
    source: { game: 'No2g: Nonogram', platform: 'Android', developer: 'MKene', year: 2026, file: `${puzzles.length} puzzles` },
    levels: [{ id: `no2g-${stem}`, title, rules: 'normal', puzzles }],
    theme: { palette: {
      accent: '#db9a53', fill: '#2b2320', cell: '#f4efe6', grid: '#b7a089', clue: '#241c18',
      cross: '#c0392b', cursor: '#e0a030', bg: '#efe6d8', style: 'default',
    } },
  };
  const out: PkgPart = { id: pack.id, title, puzzles, theme: pack.theme };
  if (iconPng) {
    const g = pngGrid(iconPng);
    if (g) { out.icon = makeIcon(g.w, g.h, g.rgba); out.iconPng = iconPng; }
  }
  return out;
}

const stemOf = (name: string) => (PKG_RE.exec(name) as RegExpExecArray)[1].toLowerCase();

function packFromEntries(entries: Entry[]): Pack {
  const pkgs = entries.filter(e => PKG_RE.test(e.name));
  if (!pkgs.length) throw new Error('No No2g package files found (assets/packages/*.pkg).');
  const seen = new Set<string>();
  const parts: PkgPart[] = [];
  for (const e of pkgs) {
    const stem = stemOf(e.name);
    if (seen.has(stem)) continue;
    seen.add(stem);
    const part = partOfPackage(e.data, stem);
    if (part) parts.push(part);
  }
  if (!parts.length) throw new Error('No No2g puzzle packages decoded (wrong APK or unreadable packages).');

  const perGroup = 20;
  const levels: PackLevel[] = parts.map((p, i) => {
    const g = Math.floor(i / perGroup);
    const from = g * perGroup + 1, to = Math.min((g + 1) * perGroup, parts.length);
    const groups = Math.ceil(parts.length / perGroup);
    return {
      id: `no2g-${p.id}`, title: p.title, rules: 'normal' as const, puzzles: p.puzzles,
      group: groups < 2 ? 'pkg' : `pkg-${g + 1}`,
      groupTitle: groups < 2
        ? { en: 'Packs', de: 'Packs' }
        : { en: `Packs ${from}–${to}`, de: `Packs ${from}–${to}` },
    };
  });
  // one level per package; packages are batched into folders of 20 so the list stays usable
  const pack: Pack = {
    format: 'momogram-pack', version: 1,
    id: 'android-no2g',
    title: { en: 'No2g: Nonogram', ko: '노노그램 No2g', ja: 'ノノグラム No2g' },
    source: {
      game: 'No2g: Nonogram', platform: 'Android', developer: 'MKene', year: 2026,
      file: `${levels.reduce((n, l) => n + l.puzzles.length, 0)} puzzles`,
    },
    levels,
    theme: parts[0].theme,
  };
  // pack icon: the biggest package icon (they're all 256×256; use the largest file for crispness)
  let best: { icon: PackIcon; png: Uint8Array; stem: string } | null = null;
  for (const p of parts) {
    if (p.iconPng && p.icon && (!best || p.iconPng.length > best.png.length)) {
      best = { icon: p.icon, png: p.iconPng, stem: p.id.replace(/^android-no2g-/, '') };
    }
  }
  if (best) {
    pack.icon = best.icon;
    // carry each package's own icon PNG as a pack asset (the task's "pack icon as asset")
    const assets = [];
    for (const p of parts) if (p.iconPng) assets.push({ name: `${p.id.replace(/^android-no2g-/, '')}-icon.png`, data: p.iconPng });
    (pack as any).assets = assets;
  }
  return pack;
}

// ---------------------------------------------------------------- entry points

function bundleDetect(data: Uint8Array): boolean {
  try { return looksLike(entriesOf(data)); } catch { return false; }
}

registerImporter({
  name: 'No2g: Nonogram (Android)',
  version: 1,
  detect(data, fileName) {
    if (data.length < 4096) return false;
    return bundleDetect(data);
  },
  read(data, fileName) {
    const entries = entriesOf(data);
    if (!looksLike(entries)) throw new Error('Not a No2g APK: assets/packages/*.pkg missing.');
    return [packFromEntries(entries)];
  },
});

registerSetImporter({
  name: 'No2g: Nonogram (Android)',
  version: 1,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      if (PKG_RE.test(n)) {
        const r = n.slice(0, n.indexOf('assets/'));
        roots.add(r === '' ? '.' : r.replace(/\/$/, ''));
      }
    }
    return [...roots];
  },
  async read(files: GameFiles, root: string) {
    const all: Entry[] = [];
    for (const n of files.names) {
      if (root !== '.' && !(n === root || n.startsWith(root + '/'))) continue;
      const data = await files.get(n);
      if (!data) continue;
      if (/\.(apk|xapk|apkm|zip)$/i.test(n)) {
        try { all.push(...entriesOf(data)); } catch { /* skip unreadable */ }
      } else {
        const rel = root === '.' ? n : n.slice(root.length + 1);
        if (!/^\.\.\//.test(rel)) all.push({ name: rel, data });
      }
    }
    if (!looksLike(all)) throw new Error('Not a No2g APK: assets/packages/*.pkg missing.');
    return [packFromEntries(all)];
  },
});
