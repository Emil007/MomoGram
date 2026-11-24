// Charm Studies (Ren'Py picross, by Nami / nomnomnami). Steam: "Non Non Nonograms!" bundle.
//
// The game is a Ren'Py visual novel whose puzzles live as plain text in the game folder:
//   game/puzzles.rpy   the 25 story puzzles, 5×5 … 15×15
//   game/puzzles2.rpy  the 144 "special" puzzles, all 10×10 (48 per character: cassia, senna, astra)
//
// A puzzle is a Ren'Py list of tuples of 0/1, one tuple per row:
//   define puzzle01 = [
//       (1,1,0,1,1),
//       ...
//   ]
// The story puzzles are named in Puzzle(...) definitions in puzzles.rpy ("Astral Magic", "Temporal Magic", …);
// the special puzzles are unnamed, grouped per character (sp_puzzle101..148 cassia, 201..248 senna, 301..348 astra).
//
// The importer reads the files as text, finds every "define <name> = [" block, parses the 0/1 rows, and names the
// story puzzles from the Puzzle(...) calls. It reads whichever of puzzles.rpy / puzzles2.rpy are present.
import { registerSetImporter, GameFiles } from './index';
import { Pack, PackAsset, PackLevel, PackPuzzle, Text, rowsFromBits } from '../format';

const utf8 = new TextDecoder('utf-8');

/** all "define name = [ ... ]" blocks in a Ren'Py file, as (name, rows[][]) */
function defineGrids(text: string): Map<string, number[][]> {
  const out = new Map<string, number[][]>();
  // a block starts at "define <ident> =" and continues to a "]" at the end of a line
  const re = /define\s+([A-Za-z_]\w*)\s*=\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[1], body = m[2];
    const rows: number[][] = [];
    for (const line of body.split('\n')) {
      const cells = [...line.matchAll(/[01]/g)].map(x => +x[0]);
      // only count lines that look like a row of a grid (a comma-separated list of 0/1)
      if (cells.length >= 5) rows.push(cells);
    }
    if (rows.length && rows.every(r => r.length === rows[0].length)) out.set(name, rows);
  }
  return out;
}

/** the story puzzles' ids and names: rows variable -> { id, name } from Puzzle(...) calls */
function puzzleMeta(text: string): Map<string, { id: string; name: Text }> {
  const out = new Map<string, { id: string; name: Text }>();
  const re = /Puzzle\(\s*_?\("([^"]*)"\)\s*,\s*id="([^"]+)"\s*,([\s\S]{0,150}?)rows=([A-Za-z_]\w*)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [_, name, id, , rowsVar] = m;
    out.set(rowsVar, { id, name: { en: name } });
  }
  return out;
}

interface CharSet { tag: string; title: string; prefix: string }

/** a puzzle list as a level: one level per size for story, one per character for specials */
function levelFromPuzzles(id: string, title: Text, puzzles: PackPuzzle[]): PackLevel {
  return { id, title, rules: 'normal' as const, puzzles };
}

registerSetImporter({
  name: 'Charm Studies (RenPy)',
  version: 1,
  find(names) {
    const roots = new Set<string>();
    for (const n of names) {
      // the root is the folder above game/ (puzzles.rpy is in game/)
      const m = n.match(/^(.*?)game\/puzzles?2?\.rpy$/);
      if (m) roots.add(m[1]);
    }
    return [...roots];
  },
  async read(files, root) {
    const get = async (n: string) => await files.get(root + n);
    const rpy1 = await get('game/puzzles.rpy');
    const rpy2 = await get('game/puzzles2.rpy');
    if (!rpy1 && !rpy2) throw new Error('Puzzles not found (no game/puzzles.rpy).');

    // sizes for story levels: gather puzzles, name them, sort by size
    const all: PackPuzzle[] = [];
    const story = rpy1 ? defineGrids(utf8.decode(rpy1)) : new Map<string, number[][]>();
    const special = rpy2 ? defineGrids(utf8.decode(rpy2)) : new Map<string, number[][]>();
    const meta = rpy1 ? puzzleMeta(utf8.decode(rpy1)) : new Map<string, { id: string; name: Text }>();

    const push = (key: string, rows: number[][], id: string, name?: Text) => {
      const w = rows[0].length, h = rows.length;
      all.push({ id, width: w, height: h, rows: rowsFromBits(w, h, (x, y) => rows[y][x] === 1), ...(name && Object.keys(name).length ? { name } : {}) });
    };

    // story puzzles, in the file's order; ids like the game's ("star", "time", …)
    for (const [varName, rows] of story) {
      const m = meta.get(varName);
      const pId = m?.id ?? `p${varName.slice('puzzle'.length)}`;
      push(varName, rows, pId, m?.name);
    }

    // special puzzles: sp_puzzle101..148 = cassia, 201..248 = senna, 301..348 = astra (48 each).
    // ids follow the game's create_sp_puzzle: char + running index (1..48).
    const groups: CharSet[] = [
      { tag: 'cassia', title: 'Cassia', prefix: '1' },
      { tag: 'senna', title: 'Senna', prefix: '2' },
      { tag: 'astra', title: 'Astragalus', prefix: '3' },
    ];
    for (const g of groups) {
      const sel = [...special.entries()]
        .filter(([v]) => v.match(new RegExp(`^sp_puzzle${g.prefix}\\d{2}$`)))
        .sort((a, b) => a[0].localeCompare(b[0]));
      sel.forEach(([v, rows], i) => {
        push(v, rows, `${g.tag}-${i + 1}`);
      });
    }

    if (!all.length) throw new Error('No puzzles found.');

    // story levels by size; special levels by character
    const levels: PackLevel[] = [];
    const bySize = new Map<string, PackPuzzle[]>();
    const spec = new Map<string, PackPuzzle[]>();
    const specTitles: Record<string, Text> = { cassia: { en: 'Special: Cassia' }, senna: { en: 'Special: Senna' }, astra: { en: 'Special: Astragalus' } };
    for (const p of all) {
      const m = p.id.match(/^(cassia|senna|astra)-/);
      if (m) { (spec.get(m[1]) ?? spec.set(m[1], []).get(m[1])!).push(p); }
      else {
        const k = `${p.width}x${p.height}`;
        (bySize.get(k) ?? bySize.set(k, []).get(k)!).push(p);
      }
    }
    for (const [k, puzzles] of [...bySize.entries()].sort((a, b) => a[1][0].width * a[1][0].height - b[1][0].width * b[1][0].height)) {
      levels.push(levelFromPuzzles(`size-${k}`, { en: k.replace('x', '×') }, puzzles));
    }
    for (const [tag, puzzles] of spec) {
      levels.push(levelFromPuzzles(`special-${tag}`, specTitles[tag], puzzles));
    }

    // music: Ren'Py keeps its BGM as ready-to-use Ogg Vorbis files in game/audio/.
    // Assigning roles the way the game plays them (script.rpy):
    //   config.main_menu_music = audio/title.ogg   -> main menu + title
    //   play music puzzle1/2/3/4/5                  -> in-game puzzle tracks
    //   play music gallery                          -> collection/gallery screen
    // We read the Ogg bytes straight out of the game folder into pack.assets and wire
    // the roles into the theme. No FSB5/UAsset conversion needed for Ren'Py.
    // already Ogg Vorbis, so the pack keeps the files as they are
    const assets: PackAsset[] = [];
    const names = ['title', 'puzzle1', 'puzzle2', 'puzzle3', 'puzzle4', 'puzzle5', 'gallery'];
    const avail = new Set<string>();
    for (const n of names) {
      const data = await files.get(root + `game/audio/${n}.ogg`);
      if (data && data.length > 4 && data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53) {
        assets.push({ name: `${n}.ogg`, data }); avail.add(n);
      }
    }
    const pack: Pack = {
      format: 'momogram-pack', version: 1, id: 'renpy-charm-studies',
      title: { en: 'Charm Studies' },
      source: { game: 'Charm Studies', platform: 'RenPy', developer: 'nomnomnami', file: 'puzzles.rpy' },
      levels,
      theme: { palette: { style: 'notebook', accent: '#e06a9a', fill: '#3a2a3a', bg: '#202020', cursor: '#ff9fc0', grid: '#7a6a7a', clue: '#f0d0e0' } },
    };
    if (avail.size) {
      const og = (n: string) => (avail.has(n) ? `${n}.ogg` : undefined);
      const theme = pack.theme!;
      theme.music = { menu: og('title'), title: og('title'), play: og('puzzle1') };
      theme.tracks = names.filter(n => avail.has(n)).map(n => `${n}.ogg`);
      theme.songs = theme.tracks.slice();
      pack.assets = assets;
    }
    return [pack];
  },
});
