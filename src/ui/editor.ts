// Puzzle editor: draw or import a picture, check that it has exactly one solution (with suggested fixes), and keep
// your puzzles in your own packs, which play and export like every other pack.
import { Pack, PackLevel, PackPuzzle, pickAny } from '../packs/format';
import { puzzleScore, puzzleLevel, suggestFix } from '../game/difficulty';
import { storage } from '../store';
import { t, lang } from '../i18n';
import { h, pickFile } from '../app';
import { icon } from './icons';

interface ED {
  packs(): Pack[];
  setPacks(p: Pack[]): void;
  header(title: string, back: () => void): HTMLElement;
  screen(...kids: Array<Node | null>): HTMLElement;
  home(): void;
  choose(title: string, options: Array<[string, () => void]>): Promise<void>;
  /** try a puzzle on the real board */
  test(pack: Pack, lv: PackLevel, i: number, back: () => void): void;
  author: string;
}

const isMine = (p: Pack) => p.id.startsWith('my-');
/** random ids: a pack made here never takes the place of someone else's on a server */
const newId = (pre: string) => pre + Array.from(crypto.getRandomValues(new Uint8Array(10)), b => (b % 36).toString(36)).join('');

async function save(ed: ED, pack: Pack) {
  pack.rev = Date.now(); // every change is a new version (shared packs then offer an update)
  await storage.savePack(pack);
  ed.setPacks([...ed.packs().filter(p => p.id !== pack.id), pack]);
}

/** your packs: create, open, rename, delete */
export function editorHome(ed: ED) {
  const mine = ed.packs().filter(isMine);
  const list = h('div', { class: 'levels' });
  for (const p of mine) {
    const n = p.levels.reduce((a, l) => a + l.puzzles.length, 0);
    list.append(h('button', { class: 'btn level', onClick: () => packEditor(ed, p) }, h('b', {}, pickAny(p.title, lang())), h('small', {}, `${n} ${t('puzzles')}`)));
  }
  const create = async () => {
    const title = prompt(t('edPackName'), t('edMyPuzzles'));
    if (!title) return;
    const p: Pack = {
      format: 'momogram-pack', version: 1, id: newId('my-'), title: { [lang()]: title },
      source: { game: title, platform: 'MomoGram', developer: ed.author },
      levels: [{ id: 'l1', title: { [lang()]: t('edLevel') + ' 1' }, rules: 'normal', puzzles: [] }],
    };
    await save(ed, p);
    packEditor(ed, p);
  };
  ed.screen(ed.header(t('editor'), ed.home), h('div', { class: 'editor-home' },
    h('p', { class: 'fine' }, t('edHelp')),
    h('button', { class: 'btn primary big', onClick: create }, '✚ ' + t('edNewPack')),
    mine.length ? list : h('p', { class: 'fine' }, t('edNoPacks'))));
}

/** one of your packs: its levels and puzzles */
function packEditor(ed: ED, pack: Pack) {
  const back = () => editorHome(ed);
  const self = () => packEditor(ed, ed.packs().find(p => p.id === pack.id) ?? pack);
  const body = h('div', { class: 'editor-pack' });
  pack.levels.forEach((lv, li) => {
    const grid = h('div', { class: 'puzzles' });
    lv.puzzles.forEach((pz, i) => {
      const c = h('canvas', { width: pz.width, height: pz.height });
      const g = c.getContext('2d')!;
      pz.rows.forEach((r, y) => [...r].forEach((v, x) => { g.fillStyle = v === '#' ? '#1a1a1a' : '#fff'; g.fillRect(x, y, 1, 1); }));
      grid.append(h('button', { class: 'btn puzzle cleared', onClick: () => puzzleEditor(ed, pack, li, i) }, c, h('span', { class: 'num' }, String(i + 1))));
    });
    grid.append(h('button', { class: 'btn puzzle add', onClick: () => puzzleEditor(ed, pack, li, -1) }, h('span', { class: 'qmark' }, '+')));
    body.append(h('div', { class: 'ed-level' },
      h('div', { class: 'section-row' }, h('h2', { class: 'section-title' }, pickAny(lv.title, lang())),
        h('button', { class: 'btn ghost', onClick: async () => { const n = prompt(t('edLevelName'), pickAny(lv.title, lang())); if (n) { lv.title = { [lang()]: n }; await save(ed, pack); self(); } } }, '✎')),
      grid));
  });
  ed.screen(ed.header(pickAny(pack.title, lang()), back), body,
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn', onClick: async () => { pack.levels.push({ id: newId('l'), title: { [lang()]: `${t('edLevel')} ${pack.levels.length + 1}` }, rules: 'normal', puzzles: [] }); await save(ed, pack); self(); } }, '✚ ' + t('edNewLevel')),
      h('button', { class: 'btn', onClick: async () => { const n = prompt(t('edPackName'), pickAny(pack.title, lang())); if (n) { pack.title = { [lang()]: n }; pack.source.game = n; await save(ed, pack); self(); } } }, '✎ ' + t('edRename')),
      h('button', { class: 'btn', onClick: async () => {
        if (!confirm(t('delete') + ': ' + pickAny(pack.title, lang()) + '?')) return;
        await storage.deletePack(pack.id); ed.setPacks(ed.packs().filter(p => p.id !== pack.id)); back();
      } }, '🗑 ' + t('delete'))),
    h('p', { class: 'fine' }, t('edExportHelp')));
}

/** draw / import one puzzle */
function puzzleEditor(ed: ED, pack: Pack, li: number, index: number) {
  const lv = pack.levels[li];
  const orig = index >= 0 ? lv.puzzles[index] : null;
  let w = orig?.width ?? 15, hgt = orig?.height ?? 15;
  let cells: boolean[] = orig ? orig.rows.join('').split('').map(c => c === '#') : new Array(w * hgt).fill(false);
  let marks = new Set<number>(); // suggested changes, shown in orange
  let source: HTMLCanvasElement | null = null; // last imported image, for re-sampling
  let threshold = 0.5, invert = false;
  const back = () => packEditor(ed, pack);

  const cv = h('canvas', { class: 'ed-grid' }) as HTMLCanvasElement;
  const status = h('div', { class: 'ed-status' });
  const nameIn = h('input', { type: 'text', value: orig ? pickAny(orig.name, lang()) : '', placeholder: t('edPuzzleName'), maxlength: 40 }) as HTMLInputElement;
  const num = (v: number, set: (n: number) => void) => h('input', { type: 'number', min: 5, max: 30, value: v, onChange: (e: Event) => { const n = Math.max(5, Math.min(30, +(e.target as HTMLInputElement).value || 5)); set(n); } });
  const resize = (nw: number, nh: number) => {
    const old = cells, ow = w, oh = hgt;
    w = nw; hgt = nh; cells = new Array(w * hgt).fill(false);
    for (let y = 0; y < Math.min(oh, hgt); y++) for (let x = 0; x < Math.min(ow, w); x++) cells[y * w + x] = old[y * ow + x];
    if (source) sample(); marks.clear(); draw(); check();
    wIn.value = String(w); hIn.value = String(hgt);
  };
  const wIn = num(w, n => resize(n, hgt)) as HTMLInputElement, hIn = num(hgt, n => resize(w, n)) as HTMLInputElement;
  const rows = () => [...Array(hgt)].map((_, y) => cells.slice(y * w, y * w + w).map(v => (v ? '#' : '.')).join(''));

  // ---- drawing
  const cellPx = () => Math.floor(Math.min(cv.clientWidth / w, 560 / hgt, (window.innerHeight * 0.55) / hgt));
  function draw() {
    const s = Math.max(6, cellPx() || 16), dpr = window.devicePixelRatio || 1;
    cv.width = w * s * dpr; cv.height = hgt * s * dpr; cv.style.height = hgt * s + 'px';
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      g.fillStyle = marks.has(i) ? (cells[i] ? '#e07a10' : '#ffd08a') : cells[i] ? '#1a1a1a' : (x >> 0 & 1) ^ (y & 1) ? '#f4f8fb' : '#ffffff';
      g.fillRect(x * s, y * s, s, s);
    }
    g.strokeStyle = '#c9d6e2'; g.lineWidth = 1;
    for (let x = 0; x <= w; x++) { g.beginPath(); g.moveTo(x * s + .5, 0); g.lineTo(x * s + .5, hgt * s); g.stroke(); }
    for (let y = 0; y <= hgt; y++) { g.beginPath(); g.moveTo(0, y * s + .5); g.lineTo(w * s, y * s + .5); g.stroke(); }
    g.strokeStyle = '#f39a2c'; g.lineWidth = 2;
    for (let x = 5; x < w; x += 5) { g.beginPath(); g.moveTo(x * s, 0); g.lineTo(x * s, hgt * s); g.stroke(); }
    for (let y = 5; y < hgt; y += 5) { g.beginPath(); g.moveTo(0, y * s); g.lineTo(w * s, y * s); g.stroke(); }
  }
  let paintVal: boolean | null = null;
  const at = (e: PointerEvent) => { const r = cv.getBoundingClientRect(), s = r.width / w; const x = Math.floor((e.clientX - r.left) / s), y = Math.floor((e.clientY - r.top) / s); return x >= 0 && y >= 0 && x < w && y < hgt ? y * w + x : -1; };
  cv.addEventListener('pointerdown', e => { const i = at(e); if (i < 0) return; cv.setPointerCapture(e.pointerId); paintVal = !cells[i]; cells[i] = paintVal; marks.clear(); draw(); });
  cv.addEventListener('pointermove', e => { if (paintVal === null) return; const i = at(e); if (i >= 0 && cells[i] !== paintVal) { cells[i] = paintVal; draw(); } });
  const end = () => { if (paintVal !== null) { paintVal = null; check(); } };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.style.touchAction = 'none';

  // ---- image import: scaled to the grid, dark pixels become filled
  function sample() {
    if (!source) return;
    const c = document.createElement('canvas'); c.width = w; c.height = hgt;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, hgt);
    const sc = Math.min(w / source.width, hgt / source.height), dw = source.width * sc, dh = source.height * sc;
    g.imageSmoothingQuality = 'high';
    g.drawImage(source, (w - dw) / 2, (hgt - dh) / 2, dw, dh);
    const d = g.getImageData(0, 0, w, hgt).data;
    for (let i = 0; i < w * hgt; i++) {
      const lum = (0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2]) / 255;
      cells[i] = (lum < threshold) !== invert;
    }
  }
  async function importImage() {
    const f = await pickFile('image/*');
    if (!f) return;
    const img = await createImageBitmap(f);
    source = document.createElement('canvas'); source.width = img.width; source.height = img.height;
    const g = source.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, img.width, img.height); g.drawImage(img, 0, 0);
    // keep the picture's shape: fit the grid to its aspect ratio
    const ar = img.width / img.height;
    if (ar > 1) resize(w, Math.max(5, Math.min(30, Math.round(w / ar)))); else resize(Math.max(5, Math.min(30, Math.round(hgt * ar))), hgt);
    sample(); marks.clear(); draw(); check();
    imgTools.hidden = false;
  }
  const thr = h('input', { type: 'range', min: 0.1, max: 0.9, step: 0.02, value: threshold, onInput: (e: Event) => { threshold = +(e.target as HTMLInputElement).value; sample(); marks.clear(); draw(); }, onChange: () => check() });
  const inv = h('label', { class: 'chk' }, h('input', { type: 'checkbox', onChange: (e: Event) => { invert = (e.target as HTMLInputElement).checked; sample(); marks.clear(); draw(); check(); } }), t('edInvert'));
  const imgTools = h('div', { class: 'ed-img', hidden: true }, h('span', {}, t('edThreshold')), thr, inv);

  // ---- uniqueness check and suggested fix
  let fixCells: Array<{ x: number; y: number }> = [];
  function check() {
    const r = rows();
    if (!cells.some(Boolean)) { status.replaceChildren(h('span', { class: 'fine' }, t('edEmpty'))); return; }
    const s = puzzleScore(r);
    fixCells = [];
    if (s.solvable) {
      const d = puzzleLevel({ rows: r });
      status.replaceChildren(h('b', { class: 'ok' }, '✓ ' + t('edUnique')), h('span', { class: 'diff d' + d }, t('diff' + d)));
    } else {
      const open = s.grid.reduce((a, v) => a + (v === 0 ? 1 : 0), 0);
      status.replaceChildren(h('b', { class: 'warn' }, '⚠ ' + t('edAmbiguous', { n: open })),
        h('button', { class: 'btn', onClick: () => {
          fixCells = suggestFix(r, 12);
          marks = new Set(fixCells.map(c => c.y * w + c.x));
          draw();
          status.replaceChildren(fixCells.length
            ? h('span', {}, t('edFixFound', { n: fixCells.length }), ' ', h('button', { class: 'btn primary', onClick: () => { for (const c of fixCells) cells[c.y * w + c.x] = !cells[c.y * w + c.x]; marks.clear(); draw(); check(); } }, t('edApply')))
            : h('span', { class: 'warn' }, t('edNoFix')));
        } }, t('edSuggest')));
    }
  }

  async function store(): Promise<number> {
    const pz: PackPuzzle = { id: orig?.id ?? newId('p'), width: w, height: hgt, rows: rows(), name: nameIn.value.trim() ? { [lang()]: nameIn.value.trim() } : undefined };
    const i = index >= 0 ? index : lv.puzzles.length;
    lv.puzzles[i] = pz;
    await save(ed, pack);
    return i;
  }

  ed.screen(ed.header(orig ? `${t('puzzleNo')} ${index + 1}` : t('edNewPuzzle'), back), h('div', { class: 'editor' },
    h('div', { class: 'ed-bar' },
      h('label', {}, t('size'), wIn, '×', hIn),
      h('button', { class: 'btn', onClick: importImage }, '🖼 ' + t('edImport')),
      h('button', { class: 'btn', onClick: () => { cells = cells.map(v => !v); marks.clear(); draw(); check(); } }, t('edInvertAll')),
      h('button', { class: 'btn', onClick: () => { cells.fill(false); source = null; imgTools.hidden = true; marks.clear(); draw(); check(); } }, t('edClear'))),
    imgTools,
    h('div', { class: 'ed-canvas' }, cv),
    status,
    nameIn,
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn', onClick: async () => { const i = await store(); ed.test(pack, lv, i, () => puzzleEditor(ed, pack, li, i)); } }, icon('play'), t('edTest')),
      h('button', { class: 'btn primary', onClick: async () => { await store(); back(); } }, t('edSave')),
      orig ? h('button', { class: 'btn', onClick: async () => { lv.puzzles.splice(index, 1); await save(ed, pack); back(); } }, '🗑') : null)));
  requestAnimationFrame(() => { draw(); check(); });
}
