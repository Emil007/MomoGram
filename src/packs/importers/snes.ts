// Super Famicom / Satellaview Picross games by Jupiter.
//
// Mario no Super Picross (1995) and Tamori no Picross (Satellaview, 1995) share one puzzle format:
// a table of 4-byte entries (24-bit HiROM pointer + 00) points to one record per puzzle. A record is a
// list of chunks [type][length lo][length hi][length-2 bytes]:
//   type 0 (length 8): size code, kind, four date / number bytes (BCD; Satellaview broadcasts store the
//                      day the puzzle was on air, e.g. 23 04 = 23 April)
//   type 1: the solution, one bit per cell, row-major, least significant bit first
//   type 2, 3 …: the coloured picture shown after solving and its palette (not used here)
// Size codes: 0 = 5x5, 1 = 10x10, 2 = 15x15, 3 = 20x20, 6 = 25x20.
import { registerImporter } from './index';
import { Pack, PackLevel, PackPuzzle, Text, rowsFromBits } from '../format';

const SIZES: Record<number, [number, number]> = { 0: [5, 5], 1: [10, 10], 2: [15, 15], 3: [20, 20], 6: [25, 20] };

interface SfcRecord { size: number; kind: number; tag: number[]; puzzle: Omit<PackPuzzle, 'id'> }

const hiromOffset = (lo: number, hi: number, bank: number) => (((bank & 0x3f) << 16) | (hi << 8) | lo);

function isRecord(d: Uint8Array, a: number): boolean {
  return a + 12 <= d.length && d[a] === 0 && d[a + 1] === 8 && d[a + 2] === 0 && d[a + 9] === 1;
}

function readRecord(d: Uint8Array, a: number): SfcRecord | null {
  if (!isRecord(d, a)) return null;
  const size = d[a + 3], wh = SIZES[size];
  if (!wh) return null;
  const [w, h] = wh, len = d[a + 10] | (d[a + 11] << 8), bits = a + 12;
  if (len - 2 !== Math.ceil((w * h) / 8) || bits + len - 2 > d.length) return null;
  const rows = rowsFromBits(w, h, (x, y) => { const i = y * w + x; return ((d[bits + (i >> 3)] >> (i & 7)) & 1) === 1; });
  return { size, kind: d[a + 4], tag: [d[a + 5], d[a + 6], d[a + 7], d[a + 8]], puzzle: { width: w, height: h, rows } };
}

/** every pointer table whose entries all lead to puzzle records (longest first) */
export function findSfcTables(d: Uint8Array): Array<{ offset: number; count: number }> {
  const out: Array<{ offset: number; count: number }> = [];
  for (let o = 0; o + 8 <= d.length;) {
    let n = 0;
    for (;;) {
      const q = o + 4 * n;
      if (q + 4 > d.length || d[q + 3] !== 0 || d[q + 2] < 0xc0) break;
      if (!readRecord(d, hiromOffset(d[q], d[q + 1], d[q + 2]))) break;
      n++;
    }
    if (n >= 8) { out.push({ offset: o, count: n }); o += 4 * n; } else o++;
  }
  return out.sort((a, b) => b.count - a.count);
}

function readTable(d: Uint8Array, t: { offset: number; count: number }): SfcRecord[] {
  const out: SfcRecord[] = [];
  for (let i = 0; i < t.count; i++) {
    const q = t.offset + 4 * i;
    out.push(readRecord(d, hiromOffset(d[q], d[q + 1], d[q + 2]))!);
  }
  return out;
}

const headerTitle = (d: Uint8Array) => d.length >= 0x10000 ? String.fromCharCode(...d.subarray(0xffc0, 0xffd5)) : '';
const letter = (i: number) => String.fromCharCode(65 + i);

function withTitle(base: Text, suffix: string): Text {
  const t: Text = {};
  for (const [l, v] of Object.entries(base)) t[l as keyof Text] = `${v} ${suffix}`;
  return t;
}

// ---- Mario no Super Picross ----
// 302 records: Mario levels 1-10 + Special (12 puzzles each, A-L), Mario EX (13, A-M), Wario levels 1-10 +
// Special (12 each), Wario Ultra (8), Wario EX (15, A-O), then a tutorial and a demo puzzle (not imported).
// Mario's side penalises mistakes; Wario's side has no mistake checking or time limit.
function readMarioSuper(d: Uint8Array, fileName: string): Pack {
  const t = findSfcTables(d)[0];
  if (!t || t.count < 300) throw new Error('Puzzle table not found.');
  const recs = readTable(d, t);
  const levels: PackLevel[] = [];
  let i = 0;
  const take = (n: number) => recs.slice(i, (i += n));
  const side = (key: 'm' | 'w', title: Text, rules: 'normal' | 'free', extra: Array<{ id: string; t: Text; n: number }>) => {
    for (let lv = 1; lv <= 11; lv++) {
      const special = lv === 11;
      const id = special ? `${key}-sp` : `${key}-${lv}`;
      levels.push({
        id, rules, group: key,
        title: special ? withTitle(title, '– Special') : withTitle(title, `${lv}`),
        puzzles: take(12).map((r, k) => ({ id: `${id}-${letter(k)}`, ...r.puzzle })),
      });
    }
    for (const e of extra) levels.push({ id: `${key}-${e.id}`, rules, group: key, extra: true, title: e.t, puzzles: take(e.n).map((r, k) => ({ id: `${key}-${e.id}-${letter(k)}`, ...r.puzzle })) });
  };
  const mario: Text = { en: 'Mario', ja: 'マリオ' }, wario: Text = { en: 'Wario', ja: 'ワリオ' };
  side('m', mario, 'normal', [{ id: 'ex', t: { en: 'Mario EX', ja: 'マリオ EX' }, n: 13 }]);
  side('w', wario, 'free', [{ id: 'ultra', t: { en: 'Wario Ultra', ja: 'ワリオ ウルトラ' }, n: 8 }, { id: 'ex', t: { en: 'Wario EX', ja: 'ワリオ EX' }, n: 15 }]);
  (levels as any[]).forEach(l => { l.groupTitle = l.group === 'm' ? mario : wario; });
  const vc = /virtual console/i.test(fileName);
  return {
    format: 'momogram-pack', version: 1, id: 'sfc-mario-no-super-picross',
    title: { en: "Mario's Super Picross", ja: 'マリオのスーパーピクロス' },
    source: { game: "Mario's Super Picross", platform: 'Super Famicom', region: vc ? 'Virtual Console' : 'JPN', developer: 'Jupiter', year: 1995 },
    levels,
  };
}

// ---- Tamori no Picross (Satellaview) ----
// Every broadcast carries the same 14 standard puzzles (dated 23 April), a 15x15 puzzle for each day of
// the broadcast period and a weekly set of five 20x20 puzzles. Puzzles are filed by their air date, so
// importing several broadcasts adds the new days to one pack instead of creating duplicates.
const bcd = (v: number) => (v >> 4) * 10 + (v & 15);
const MONTHS_EN = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function readTamori(d: Uint8Array): Pack {
  const t = findSfcTables(d)[0];
  if (!t) throw new Error('Puzzle table not found.');
  const recs = readTable(d, t);
  const levels = new Map<string, PackLevel>();
  const level = (id: string, title: Text, order: number) => {
    let l = levels.get(id);
    if (!l) { l = { id, title, rules: 'normal', puzzles: [] }; (l as any).order = order; levels.set(id, l); }
    return l;
  };
  const counter = new Map<string, number>();
  for (const r of recs) {
    const [a, b, c, e] = r.tag, key = `${r.size}-${r.kind}-${r.tag.join('.')}`;
    const k = counter.get(key) ?? 0; counter.set(key, k + 1);
    const day = bcd(a), mon = bcd(b);
    let l: PackLevel, id: string;
    if (mon === 4 && day === 23 && !c && !e) {
      // standard puzzles, the same in every broadcast
      l = level('standard', { en: 'Standard puzzles', ja: 'スタンダード' }, 0);
      id = `std-${r.kind}-${r.size}-${k + 1}`;
    } else if (c || e) {
      if (a === 0) {
        // numbered special sets (seen in the 7/14 broadcast): bytes 00 nn 00 kk
        l = level(`set-${b}`, { en: `Special set ${b}` }, 3000 + b);
        id = `set-${b}-${e}`;
      } else {
        // weekly 20x20 set with first and last air date
        const tag = `${String(mon).padStart(2, '0')}${String(day).padStart(2, '0')}`;
        l = level(`week-${tag}`, { en: `Week ${mon}/${day} – ${bcd(e)}/${bcd(c)}`, ja: `${mon}/${day}～${bcd(e)}/${bcd(c)}` }, 2000 + mon * 40 + day);
        id = `w${tag}-${k + 1}`;
      }
    } else {
      const tag = `${String(mon).padStart(2, '0')}${String(day).padStart(2, '0')}`;
      l = level(`day-${String(mon).padStart(2, '0')}`, { en: `Daily puzzles – ${MONTHS_EN[mon] ?? mon}`, ja: `${mon}月の毎日ピクロス` }, 1000 + mon);
      id = `d${tag}${k ? '-' + (k + 1) : ''}`;
    }
    l.puzzles.push({ id, ...r.puzzle });
  }
  const out = [...levels.values()].sort((x: any, y: any) => x.order - y.order);
  for (const l of out) { delete (l as any).order; l.puzzles.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)); }
  const date = headerTitle(d).match(/(\d+)\/(\d+)/);
  return {
    format: 'momogram-pack', version: 1, id: 'bs-tamori-no-picross',
    title: { en: 'Tamori no Picross', ja: 'タモリのピクロス' },
    source: { game: 'Tamori no Picross', platform: 'Satellaview', region: 'JPN', developer: 'Jupiter', year: 1995, ...(date ? { file: `broadcast ${date[1]}/${date[2]}` } : {}) },
    levels: out,
  };
}

const isTamori = (d: Uint8Array) => d.length >= 0x10000 && d[0xffc1] === 0xc0 && d[0xffc2] === 0xd3 && d[0xffc3] === 0xd8;

registerImporter({
  name: 'Mario no Super Picross (Super Famicom)',
  detect: d => d.length >= 0x10000 && headerTitle(d).startsWith('SUPER PICROSS'),
  read: (d, f) => [readMarioSuper(d, f)],
});

registerImporter({
  name: 'Tamori no Picross (Satellaview)',
  detect: d => isTamori(d),
  read: d => [readTamori(d)],
});
