// Jupiter's 3DS Picross games (Picross e1–e9, Pokémon Picross, My Nintendo / Club Nintendo Picross, …).
// Needs decrypted files; puzzles are .bprs (title utf16[16], w, h, cells) or .bprs2 (".PRS" header, title, w, h, cells).
import { registerImporter } from './index';
import { readCtr, lz11, ctrEncrypted, SMDH_LANGS, u16, CtrFile } from '../../rom/ctr';
import { Lang, Pack, PackLevel, PackPuzzle, PackTheme, PackAsset, Text, rowsFromBits } from '../format';
import { accentFromColors } from '../theme';
import { isBcstm } from '../../audio/bcstm';

interface Raw { file: string; w: number; h: number; cells: Uint8Array; title: string }

function parseBprs(f: CtrFile): Raw | null {
  const d = lz11(f.data);
  const td = new TextDecoder('utf-16le');
  if (/\.bprs2$/i.test(f.path)) {
    // ".PRS" magic (utf16), u16 version, u16 title length, title, then a few bytes before w,h
    const n = u16(d, 10), p = 12 + n * 2;
    const m = f.path.match(/(\d+)x(\d+)/);
    for (let q = p; q < p + 8; q++) {
      const w = d[q], h = d[q + 1];
      if (m ? (w === +m[1] && h === +m[2]) : (w >= 5 && h >= 5 && w <= 40 && h <= 40)) {
        const cells = d.subarray(q + 2, q + 2 + w * h);
        if (cells.length === w * h && cells.every(c => c <= 1)) return { file: f.path, w, h, cells, title: td.decode(d.subarray(12, p)) };
      }
    }
    return null;
  }
  const w = d[0x20], h = d[0x21];
  const cells = d.subarray(0x22, 0x22 + w * h);
  if (w < 1 || h < 1 || cells.length !== w * h || !cells.every(c => c <= 1)) return null;
  return { file: f.path, w, h, cells, title: td.decode(d.subarray(0, 0x20)).replace(/\0+$/, '') };
}

/** IdxRes string tables: u32 offsets, utf16 strings. The puzzle titles are the last N entries. */
function idxStrings(d: Uint8Array): string[] {
  d = lz11(d);
  const n = (d[0] | (d[1] << 8) | (d[2] << 16)) >> 2;
  const offs = [...Array(n)].map((_, i) => d[i * 4] | (d[i * 4 + 1] << 8) | (d[i * 4 + 2] << 16));
  const td = new TextDecoder('utf-16le');
  return offs.map((o, i) => td.decode(d.subarray(o, i + 1 < n ? offs[i + 1] : d.length)).replace(/\0+$/, ''));
}

const MODE: Record<string, { key: string; title: Text }> = {
  E: { key: 'easy', title: { en: 'Easy', de: 'Leicht', fr: 'Facile', it: 'Facile', es: 'Fácil', ja: 'かんたん' } },
  N: { key: 'normal', title: { en: 'Normal', de: 'Normal', fr: 'Normal', it: 'Normale', es: 'Normal', ja: 'ノーマル' } },
  F: { key: 'free', title: { en: 'Free', de: 'Frei', fr: 'Libre', it: 'Libera', es: 'Libre', ja: 'フリー' } },
  X: { key: 'extra', title: { en: 'Extra', de: 'Extra', fr: 'Extra', it: 'Extra', es: 'Extra', ja: 'エクストラ' } },
};
const IDX_LANG: Record<string, Lang> = { English: 'en', French: 'fr', Germany: 'de', German: 'de', Italian: 'it', Spanish: 'es', Japanese: 'ja' };

function chunk(prefix: string, title: Text, group: string, puzzles: PackPuzzle[]): PackLevel[] {
  const out: PackLevel[] = [];
  for (let i = 0; i < puzzles.length; i += 15) {
    const k = i / 15 + 1, many = puzzles.length > 15;
    const t: Text = {};
    for (const [l, v] of Object.entries(title)) t[l as Lang] = many ? `${v} ${k}` : v;
    out.push({ id: `${prefix}${k}`, title: t, rules: 'free', group, puzzles: puzzles.slice(i, i + 15) });
  }
  return out;
}

export function read3ds(data: Uint8Array): Pack[] {
  const t = readCtr(data);
  const raws = t.files.filter(f => /\.bprs2?$/i.test(f.path) && !/sample/i.test(f.path)).map(parseBprs).filter((r): r is Raw => !!r);
  if (!raws.length) throw new Error('No Picross puzzles found in this 3DS title.');
  raws.sort((a, b) => a.file.localeCompare(b.file, 'en', { numeric: true }));
  const toPuzzle = (r: Raw, id: string): PackPuzzle => ({
    id, width: r.w, height: r.h,
    rows: rowsFromBits(r.w, r.h, (x, y) => r.cells[y * r.w + x] === 1),
    name: r.title ? { ja: r.title } : undefined,
  });
  const levels: PackLevel[] = [];
  const modeStyle = raws.every(r => /\/Prs_[ENFX]_\d+\.bprs$/.test(r.file));
  if (modeStyle) {
    // Picross e: Easy, Normal, Free, Extra; localized titles in mode order
    const titles = new Map<Lang, string[]>();
    for (const f of t.files) {
      const m = f.path.match(/IdxRes_PrsTitle_(\w+)\.dat$/);
      if (m && IDX_LANG[m[1]]) titles.set(IDX_LANG[m[1]], idxStrings(f.data));
    }
    let k = 0;
    for (const mode of ['E', 'N', 'F', 'X']) {
      const list = raws.filter(r => r.file.includes(`/Prs_${mode}_`)).map(r => {
        const p = toPuzzle(r, `${mode.toLowerCase()}-${r.file.match(/_(\d+)\.bprs$/)![1]}`);
        // the table ends with one title per puzzle (in mode order) and an empty entry
        for (const [lang, names] of titles) {
          const s = names[names.length - 1 - raws.length + k];
          if (s) p.name = { ...p.name, [lang]: s };
        }
        k++;
        return p;
      });
      levels.push(...chunk(MODE[mode].key, MODE[mode].title, MODE[mode].key, list));
    }
  } else {
    // later games: files grouped by size (…_15x15_07.bprs / E9_20x15_03.bprs2)
    const bySize = new Map<string, Raw[]>();
    for (const r of raws) {
      const key = `${r.w}x${r.h}`;
      (bySize.get(key) ?? bySize.set(key, []).get(key)!).push(r);
    }
    const sizes = [...bySize.keys()].sort((a, b) => { const [aw, ah] = a.split('x').map(Number), [bw, bh] = b.split('x').map(Number); return aw * ah - bw * bh; });
    for (const s of sizes) {
      const list = bySize.get(s)!.map((r, i) => toPuzzle(r, `${s}-${String(i + 1).padStart(2, '0')}`));
      const label = s.replace('x', '×');
      levels.push(...chunk(`s${s}-`, { en: label }, s, list));
    }
  }
  const title: Text = {};
  t.names.forEach((n, i) => { const l = SMDH_LANGS[i] as Lang; if (n && ['ja', 'en', 'fr', 'de', 'it', 'es', 'ko'].includes(l)) title[l] = n; });
  // identify the game across regions by its English (or Japanese) title, not the region-specific code
  const key = (title.en ?? title.ja ?? t.productCode).toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
  const { theme, assets } = music3ds(t.files);
  const accent = accentFromColors(t.iconColors);
  if (accent) theme.palette = { accent };
  return [{
    theme: theme.palette || theme.music ? theme : undefined,
    assets: assets.length ? assets : undefined,
    format: 'momogram-pack', version: 1,
    id: 'ctr-' + key,
    title: Object.keys(title).length ? title : { en: t.productCode },
    source: { game: title.en ?? title.ja ?? t.productCode, platform: 'Nintendo 3DS', region: t.productCode.slice(-1), developer: 'Jupiter' },
    levels,
  }];
}

// Stream music (.bcstm) by role. Picross e-style names: GA = in game, ME = menu, MG / MI = Mega / Micross;
// Pokémon Picross style: Bgm_Home, Bgm_Picross, Jingle_Cliear, …
const ROLES: Array<[keyof NonNullable<PackTheme['music']>, RegExp]> = [
  ['play', /(^|_)(ga_b_00|bgm_picross|bgm_normal)\b/i],
  ['play2', /(^|_)(mg_b_00|bgm_mega|mi_b_00|bgm_micross|ga_b_01)\b/i],
  ['menu', /(^|_)(me_b_00|bgm_home)\b/i],
  ['title', /(^|_)(bgm_title|me_b_01|tu_b_00)\b/i],
  ['clear', /(^|_)(jingle_cliear|jingle_clear)\b/i],
];

function music3ds(files: CtrFile[]): { theme: PackTheme; assets: PackAsset[] } {
  const theme: PackTheme = {};
  const assets: PackAsset[] = [];
  const streams = files.filter(f => /\.bcstm$/i.test(f.path) && isBcstm(f.data));
  for (const [role, re] of ROLES) {
    const f = streams.find(s => re.test(s.path.split('/').pop()!.replace(/\.dspadpcm/i, '').replace(/\.bcstm$/i, '')));
    if (!f) continue;
    const name = f.path.split('/').pop()!.replace(/\.dspadpcm/i, '');
    if (!assets.some(a => a.name === name)) assets.push({ name, data: f.data.slice() });
    (theme.music ??= {})[role] = name;
  }
  return { theme, assets };
}

registerImporter({
  name: 'Nintendo 3DS',
  detect: d => ctrEncrypted(d) === false,
  read: d => read3ds(d),
});
