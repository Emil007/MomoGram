// Unity files as Jupiter's Switch games ship them: asset bundles ("UnityFS", LZ4 compressed) holding serialized
// files, and plain serialized files (resources.assets). Read here: the objects' names and bytes (TextAsset, the
// MonoBehaviours with an m_bytes field) and AudioClips (name, and where their FSB5 data is).
// Written from the publicly documented file layout (as also implemented by UnityPy / AssetStudio).
import { lzma } from './lzma';

const MAX_LZ4 = 512 * 1024 * 1024;

/** LZ4 block format (no frame). A short decode is a failure, not a truncated assets file. */
export function lz4(src: Uint8Array, outSize: number): Uint8Array {
  if (outSize < 0 || outSize > MAX_LZ4) throw new Error('LZ4 output is too large.');
  const out = new Uint8Array(outSize);
  let i = 0, o = 0;
  const fail = () => { throw new Error('LZ4 block is truncated.'); };
  while (i < src.length) {
    const tok = src[i++];
    let lit = tok >> 4;
    if (lit === 15) { let b = 255; while (b === 255) { if (i >= src.length) fail(); b = src[i++]; lit += b; } }
    if (lit) {
      if (i + lit > src.length || o + lit > outSize) fail();
      out.set(src.subarray(i, i + lit), o); i += lit; o += lit;
    }
    if (i >= src.length) break;
    if (i + 2 > src.length) fail();
    const off = src[i] | (src[i + 1] << 8); i += 2;
    if (!off || off > o) fail();
    let len = tok & 15;
    if (len === 15) { let b = 255; while (b === 255) { if (i >= src.length) fail(); b = src[i++]; len += b; } }
    len += 4;
    if (o + len > outSize) fail();
    for (let k = 0; k < len; k++, o++) out[o] = out[o - off];
  }
  if (o !== outSize) fail();
  return out;
}

class R {
  o = 0;
  constructor(public d: Uint8Array, public le = false) {}
  get dv() { return new DataView(this.d.buffer, this.d.byteOffset, this.d.byteLength); }
  u8() { return this.d[this.o++]; }
  u16() { const v = this.dv.getUint16(this.o, this.le); this.o += 2; return v; }
  i16() { const v = this.dv.getInt16(this.o, this.le); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o, this.le); this.o += 4; return v; }
  i32() { const v = this.dv.getInt32(this.o, this.le); this.o += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.o, this.le); this.o += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.o, this.le); this.o += 8; return v; }
  u64() { const v = Number(this.dv.getBigUint64(this.o, this.le)); this.o += 8; return v; }
  i64() { const v = Number(this.dv.getBigInt64(this.o, this.le)); this.o += 8; return v; }
  cstr() { const e = this.d.indexOf(0, this.o); const s = new TextDecoder().decode(this.d.subarray(this.o, e)); this.o = e + 1; return s; }
  bytes(n: number) { const b = this.d.subarray(this.o, this.o + n); this.o += n; return b; }
  align(n = 4) { this.o = (this.o + n - 1) & ~(n - 1); }
  str() { const n = this.u32(); const s = new TextDecoder().decode(this.bytes(n)); this.align(); return s; }
}

export const isUnityBundle = (d: Uint8Array) => d.length > 16 && String.fromCharCode(...d.subarray(0, 7)) === 'UnityFS';

/** the files inside an asset bundle (serialized files, .resource / .resS data) */
export function readBundle(d: Uint8Array): Map<string, Uint8Array> {
  const r = new R(d);
  r.o = 8;
  const version = r.u32(); r.cstr(); r.cstr();
  r.u64(); const cSize = r.u32(), uSize = r.u32(), flags = r.u32();
  if (version >= 7) r.align(16);
  let infoAt = r.o;
  if (flags & 0x80) infoAt = d.length - cSize; else r.o += cSize;
  const unpack = (b: Uint8Array, kind: number, size: number) => {
    if (kind === 0) return b;
    if (kind === 2 || kind === 3) return lz4(b, size);
    if (kind === 1) return lzma(b, size);
    throw new Error(`Unknown bundle compression ${kind}.`);
  };
  const info = new R(unpack(d.subarray(infoAt, infoAt + cSize), flags & 0x3f, uSize));
  info.o = 16;
  const blocks: Array<{ u: number; c: number; f: number }> = [];
  for (let i = 0, n = info.i32(); i < n; i++) blocks.push({ u: info.u32(), c: info.u32(), f: info.u16() });
  const nodes: Array<{ off: number; size: number; path: string }> = [];
  for (let i = 0, n = info.i32(); i < n; i++) { const off = info.i64(), size = info.i64(); info.u32(); nodes.push({ off, size, path: info.cstr() }); }
  if (flags & 0x200) r.align(16);
  // all blocks one after another; refuse a claimed size that would allocate without a bound
  const MAX_BUNDLE = 512 * 1024 * 1024;
  let total = 0, cursor = r.o;
  for (const b of blocks) {
    if (b.u > MAX_BUNDLE || b.c > d.length || cursor + b.c > d.length) throw new Error('Unity bundle block is not readable.');
    total += b.u;
    cursor += b.c;
    if (total > MAX_BUNDLE) throw new Error('Unity bundle is too large.');
  }
  const data = new Uint8Array(total);
  let p = r.o, q = 0;
  for (const b of blocks) { data.set(unpack(d.subarray(p, p + b.c), b.f & 0x3f, b.u), q); p += b.c; q += b.u; }
  return new Map(nodes.map(n => [n.path, data.subarray(n.off, n.off + n.size)]));
}

interface TNode { type: string; name: string; size: number; level: number; flags: number }
interface SType { classId: number; nodes: TNode[] | null }
export interface UObject { pathId: number; classId: number; data: Uint8Array; type: SType; le: boolean; version: number }

/** a serialized file: its objects (bytes, class, type tree where the file has one) */
export function readSerialized(d: Uint8Array): UObject[] {
  const h = new R(d);
  let metaSize = h.u32(), fileSize = h.u32(), version = h.u32(), dataOffset = h.u32();
  let le = true;
  if (version >= 9) { le = h.u8() === 0; h.o += 3; }
  if (version >= 22) { metaSize = h.u32(); fileSize = h.i64(); dataOffset = h.i64(); h.i64(); }
  void metaSize; void fileSize;
  const r = new R(d, le); r.o = h.o;
  if (version >= 7) r.cstr();
  if (version >= 8) r.i32();
  const typeTree = version >= 13 ? r.u8() !== 0 : true;
  const types: SType[] = [];
  for (let i = 0, n = r.i32(); i < n; i++) {
    const classId = r.i32();
    if (version >= 16) r.u8();
    if (version >= 17) r.i16();
    if (version >= 13) { if ((version < 16 && classId < 0) || (version >= 16 && classId === 114)) r.o += 16; r.o += 16; }
    let nodes: TNode[] | null = null;
    if (typeTree) {
      const count = r.i32(), strSize = r.i32(), nodeSize = version >= 19 ? 32 : 24;
      const raw = r.bytes(count * nodeSize), strs = r.bytes(strSize);
      const nr = new R(raw, le);
      const name = (off: number) => off & 0x80000000 ? COMMON[off & 0x7fffffff] ?? '?' : new TextDecoder().decode(strs.subarray(off, strs.indexOf(0, off)));
      nodes = [];
      for (let k = 0; k < count; k++) {
        nr.o = k * nodeSize; nr.u16(); const level = nr.u8(); nr.u8();
        const t = nr.u32(), nm = nr.u32(), size = nr.i32(); nr.i32(); const flags = nr.i32();
        nodes.push({ type: name(t), name: name(nm), size, level, flags });
      }
      if (version >= 21) { const deps = r.i32(); r.o += deps * 4; }
    }
    types.push({ classId, nodes });
  }
  if (version >= 7 && version < 14) r.i32();
  const objs: UObject[] = [];
  for (let i = 0, n = r.i32(); i < n; i++) {
    if (version >= 14) r.align(4);
    const pathId = version >= 14 ? r.i64() : r.i32();
    const start = version >= 22 ? r.i64() : r.u32(), size = r.u32();
    const ti = r.i32();
    if (version < 16) r.u16();
    if (version < 11) r.u16();
    if (version >= 11 && version < 17) r.i16();
    if (version === 15 || version === 16) r.u8();
    const type = version >= 16 ? types[ti] : (types.find(t => t.classId === ti) ?? { classId: ti, nodes: null });
    objs.push({ pathId, classId: type.classId, data: d.subarray(dataOffset + start, dataOffset + start + size), type, le, version });
  }
  return objs;
}

/** an object's fields through its type tree (basic types, strings, arrays, nested structures) */
export function readTyped(o: UObject): Record<string, any> | null {
  const nodes = o.type.nodes;
  if (!nodes) return null;
  const r = new R(o.data, o.le);
  const end = (k: number) => { let j = k + 1; while (j < nodes.length && nodes[j].level > nodes[k].level) j++; return j; };
  const kids = (k: number) => { const out: number[] = []; for (let j = k + 1, e = end(k); j < e; j++) if (nodes[j].level === nodes[k].level + 1) out.push(j); return out; };
  const aligned = (k: number) => (nodes[k].flags & 0x4000) !== 0;
  const prim = (t: string): (() => any) | null => {
    switch (t) {
      case 'SInt8': return () => (r.u8() << 24) >> 24;
      case 'UInt8': case 'char': return () => r.u8();
      case 'bool': return () => r.u8() !== 0;
      case 'SInt16': case 'short': return () => r.i16();
      case 'UInt16': case 'unsigned short': return () => r.u16();
      case 'SInt32': case 'int': return () => r.i32();
      case 'UInt32': case 'unsigned int': case 'Type*': return () => r.u32();
      case 'SInt64': case 'long long': return () => r.i64();
      case 'UInt64': case 'unsigned long long': case 'FileSize': return () => r.u64();
      case 'float': return () => r.f32();
      case 'double': return () => r.f64();
      default: return null;
    }
  };
  const read = (k: number): any => {
    const n = nodes[k], p = prim(n.type);
    let v: any;
    if (p) v = p();
    else if (n.type === 'string') {
      const len = r.u32(); v = new TextDecoder().decode(r.bytes(len));
      if (kids(k).some(aligned)) r.align();
    } else if (n.type === 'TypelessData') {
      v = r.bytes(r.i32()).slice();
    } else {
      const ks = kids(k);
      if (ks.length === 1 && nodes[ks[0]].type === 'Array') {
        // vector / map: Array { size, data }
        const arr = ks[0], data = kids(arr)[1];
        const count = r.i32();
        const t = nodes[data].type;
        if (t === 'UInt8' || t === 'char') v = r.bytes(count).slice();
        else { v = []; for (let j = 0; j < count; j++) v.push(read(data)); }
        if (aligned(arr)) r.align();
      } else {
        v = {};
        for (const c of ks) v[nodes[c].name] = read(c);
      }
    }
    if (aligned(k)) r.align();
    return v;
  };
  try { return read(0); } catch { return null; }
}

/** TextAsset (class 49): name and bytes; the layout is the same in every Unity version used here */
export function textAsset(o: UObject): { name: string; bytes: Uint8Array } | null {
  if (o.classId !== 49) return null;
  const r = new R(o.data, o.le);
  const name = r.str(), n = r.u32();
  return { name, bytes: r.bytes(n) };
}

export interface AudioClipInfo { name: string; source: string; offset: number; size: number }
/** AudioClip (class 83): where its sound data is (an FSB5 file inside a .resource file) */
export function audioClip(o: UObject): AudioClipInfo | null {
  if (o.classId !== 83) return null;
  const t = readTyped(o);
  if (t?.m_Resource) return { name: t.m_Name, source: t.m_Resource.m_Source, offset: t.m_Resource.m_Offset, size: t.m_Resource.m_Size };
  // no type tree (Unity 5.x player files): m_Name, 4 ints, a float, 2 bools (aligned), an int, 3 bools (aligned), m_Resource
  const r = new R(o.data, o.le);
  const name = r.str(); r.o += 16; r.f32(); r.u8(); r.u8(); r.align(); r.i32(); r.u8(); r.u8(); r.u8(); r.align();
  const source = r.str(), offset = r.u64(), size = r.u64();
  return /\.res/.test(source) ? { name, source, offset, size } : null;
}

/** MonoBehaviours with a byte array (Jupiter's later games keep their puzzles and tables in these) */
export function monoBytes(o: UObject): { name: string; bytes: Uint8Array } | null {
  if (o.classId !== 114) return null;
  const t = readTyped(o);
  return t && t.m_bytes instanceof Uint8Array ? { name: t.m_Name, bytes: t.m_bytes } : null;
}

/** all named byte blobs of a file (TextAssets and MonoBehaviour bytes); names can repeat */
export function namedBlobs(objs: UObject[]): Array<{ name: string; bytes: Uint8Array }> {
  const out: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const o of objs) { const b = textAsset(o) ?? monoBytes(o); if (b) out.push(b); }
  return out;
}

/** the serialized files of a bundle, or the file itself */
export function serializedFiles(d: Uint8Array): { files: Uint8Array[]; resources: Map<string, Uint8Array> } {
  if (!isUnityBundle(d)) return { files: [d], resources: new Map() };
  const nodes = readBundle(d), files: Uint8Array[] = [], resources = new Map<string, Uint8Array>();
  for (const [n, v] of nodes) if (/\.res(ource|S)$/.test(n)) resources.set(n, v); else files.push(v);
  return { files, resources };
}

// strings Unity type trees refer to by offset (high bit set): one buffer of zero-terminated strings in this order
const COMMON: Record<number, string> = (() => {
  const list = 'AABB AnimationClip AnimationCurve AnimationState Array Base BitField bitset bool char ColorRGBA Component data deque double dynamic~array FastPropertyName first float Font GameObject Generic_Mono GradientNEW GUID GUIStyle int list long_long map Matrix4x4f MdFour MonoBehaviour MonoScript m~ByteSize m~Curve m~EditorClassIdentifier m~EditorHideFlags m~Enabled m~ExtensionPtr m~GameObject m~Index m~IsArray m~IsStatic m~MetaFlag m~Name m~ObjectHideFlags m~PrefabInternal m~PrefabParentObject m~Script m~StaticEditorFlags m~Type m~Version Object pair PPtr<Component> PPtr<GameObject> PPtr<Material> PPtr<MonoBehaviour> PPtr<MonoScript> PPtr<Object> PPtr<Prefab> PPtr<Sprite> PPtr<TextAsset> PPtr<Texture> PPtr<Texture2D> PPtr<Transform> Prefab Quaternionf Rectf RectInt RectOffset second set short size SInt16 SInt32 SInt64 SInt8 staticvector string TextAsset TextMesh Texture Texture2D Transform TypelessData UInt16 UInt32 UInt64 UInt8 unsigned_int unsigned_long_long unsigned_short vector Vector2f Vector3f Vector4f m~ScriptingClassIdentifier Gradient Type* int2~storage int3~storage BoundsInt m~CorrespondingSourceObject m~PrefabInstance m~PrefabAsset FileSize Hash128 RenderingLayerMask fixed~array EntityId LoadableObjectId LoadableSceneId'.split(' ');
  const out: Record<number, string> = {};
  let off = 0;
  for (const s of list) { const v = s.replace(/_/g, ' ').replace(/~/g, '_'); out[off] = v; off += v.length + 1; }
  return out;
})();
