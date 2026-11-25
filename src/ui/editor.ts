// Puzzle editor: draw or import a picture, check that it has exactly one solution (with suggested fixes), and keep
// your puzzles in your own packs, which play and export like every other pack.
import { Pack, PackLevel, PackPuzzle, pickAny, safeColor } from '../packs/format';
import { puzzleScore, puzzleLevel, suggestFix } from '../game/difficulty';
import { colorOf, colorSolutionCount } from '../game/color';
import { storage } from '../store';
import { t, lang } from '../i18n';
import { h, pickFile } from '../app';
import { askText, confirmBox, message } from './dialog';
import { icon } from './icons';

/** a swatch colour is written into a style attribute, so only plain hex is kept */
function swatchHex(c: unknown): string {
  const s = safeColor(c, '');
  const m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (!m) return '#1a1a1a';
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).replace(/./g, ch => ch + ch);
  return '#' + h.slice(0, 6).toLowerCase();
}

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
    const title = await askText(t('edPackName'), t('edMyPuzzles'));
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
      pz.rows.forEach((r, y) => [...r].forEach((v, x) => {
        const ch = pz.color?.rows[y]?.[x];
        const k = ch && ch !== '.' ? parseInt(ch, 36) : -1;
        g.fillStyle = v === '#' ? (k >= 0 && pz.color ? swatchHex(pz.color.palette[k]) : '#1a1a1a') : '#fff';
        g.fillRect(x, y, 1, 1);
      }));
      grid.append(h('button', { class: 'btn puzzle cleared', onClick: () => puzzleEditor(ed, pack, li, i) }, c, h('span', { class: 'num' }, String(i + 1))));
    });
    grid.append(h('button', { class: 'btn puzzle add', onClick: () => puzzleEditor(ed, pack, li, -1) }, h('span', { class: 'qmark' }, '+')));
    body.append(h('div', { class: 'ed-level' },
      h('div', { class: 'section-row' }, h('h2', { class: 'section-title' }, pickAny(lv.title, lang())),
        h('button', { class: 'btn ghost', onClick: async () => { const n = await askText(t('edLevelName'), pickAny(lv.title, lang())); if (n) { lv.title = { [lang()]: n }; await save(ed, pack); self(); } } }, '✎')),
      grid));
  });
  ed.screen(ed.header(pickAny(pack.title, lang()), back), body,
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn', onClick: async () => { pack.levels.push({ id: newId('l'), title: { [lang()]: `${t('edLevel')} ${pack.levels.length + 1}` }, rules: 'normal', puzzles: [] }); await save(ed, pack); self(); } }, '✚ ' + t('edNewLevel')),
      h('button', { class: 'btn', onClick: async () => { const n = await askText(t('edPackName'), pickAny(pack.title, lang())); if (n) { pack.title = { [lang()]: n }; pack.source.game = n; await save(ed, pack); self(); } } }, '✎ ' + t('edRename')),
      h('button', { class: 'btn', onClick: async () => {
        if (!(await confirmBox(t('delete') + ': ' + pickAny(pack.title, lang()) + '?', t('delete'), true))) return;
        await storage.deletePack(pack.id); ed.setPacks(ed.packs().filter(p => p.id !== pack.id)); back();
      } }, '🗑 ' + t('delete'))),
    h('p', { class: 'fine' }, t('edExportHelp')));
}

const INK = ['#1a1a1a', '#e23d3d', '#2f6bff', '#2fa84a', '#e0a020', '#8d45d6', '#f07a1a', '#1aa8b8'];

/** draw / import one puzzle. Cells are 0 (empty) or 1…n (a palette colour). Up to 8 colours. */
function puzzleEditor(ed: ED, pack: Pack, li: number, index: number) {
  const lv = pack.levels[li];
  const orig = index >= 0 ? lv.puzzles[index] : null;
  let w = orig?.width ?? 15, hgt = orig?.height ?? 15;
  let palette = (orig?.color?.palette ?? ['#1a1a1a']).slice(0, 8).map(swatchHex);
  const fromOrig = (): number[] => {
    if (!orig) return new Array(w * hgt).fill(0);
    return orig.rows.join('').split('').map((c, i) => {
      if (c !== '#') return 0;
      const ch = orig.color?.rows[Math.floor(i / orig.width)]?.[i % orig.width];
      const k = ch && ch !== '.' ? parseInt(ch, 36) : 0;
      return (Number.isFinite(k) ? Math.min(k, palette.length - 1) : 0) + 1;
    });
  };
  let cells: number[] = fromOrig();
  let brush = 1;
  let marks = new Set<number>(); // suggested changes, shown in orange
  let open = new Set<number>(); // cells the line solver still can't decide
  let source: HTMLCanvasElement | null = null;
  let threshold = 0.5, invert = false, contrast = 1, dither = false, colorsN = 1;
  let crop = { l: 0, t: 0, r: 0, b: 0 };
  let zoom = 1, panX = 0, panY = 0;
  let live = false; // the grid is being filled from the camera
  let camTimer = 0;
  let camStream: MediaStream | null = null;
  let stopCam = () => {};
  const back = () => { stopCam(); packEditor(ed, pack); };

  const cv = h('canvas', { class: 'ed-grid' }) as HTMLCanvasElement;
  const zoomEl = h('div', { class: 'ed-zoom' }, cv);
  const stage = h('div', { class: 'ed-stage' }, zoomEl);
  const status = h('div', { class: 'ed-status' });
  const nameIn = h('input', { type: 'text', value: orig ? pickAny(orig.name, lang()) : '', placeholder: t('edPuzzleName'), maxlength: 40 }) as HTMLInputElement;
  const num = (v: number, set: (n: number) => void) => h('input', { type: 'number', min: 5, max: 30, value: v, onChange: (e: Event) => { const n = Math.max(5, Math.min(30, +(e.target as HTMLInputElement).value || 5)); set(n); } });
  const resize = (nw: number, nh: number) => {
    const old = cells, ow = w, oh = hgt;
    w = nw; hgt = nh; cells = new Array(w * hgt).fill(0);
    for (let y = 0; y < Math.min(oh, hgt); y++) for (let x = 0; x < Math.min(ow, w); x++) cells[y * w + x] = old[y * ow + x];
    marks.clear(); open.clear();
    if (live) draw();
    else { if (source) sample(); draw(); check(); }
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
      const i = y * w + x, v = cells[i];
      const base = v ? swatchHex(palette[Math.min(v - 1, palette.length - 1)]) : (x & 1) ^ (y & 1) ? '#f4f8fb' : '#ffffff';
      g.fillStyle = marks.has(i) ? '#e07a10' : open.has(i) && !v ? '#c5ddf5' : base;
      g.fillRect(x * s, y * s, s, s);
      if (marks.has(i)) { g.strokeStyle = '#7a3e00'; g.lineWidth = 2; g.strokeRect(x * s + 1, y * s + 1, s - 2, s - 2); }
    }
    g.strokeStyle = '#c9d6e2'; g.lineWidth = 1;
    for (let x = 0; x <= w; x++) { g.beginPath(); g.moveTo(x * s + .5, 0); g.lineTo(x * s + .5, hgt * s); g.stroke(); }
    for (let y = 0; y <= hgt; y++) { g.beginPath(); g.moveTo(0, y * s + .5); g.lineTo(w * s, y * s + .5); g.stroke(); }
    g.strokeStyle = '#f39a2c'; g.lineWidth = 2;
    for (let x = 5; x < w; x += 5) { g.beginPath(); g.moveTo(x * s, 0); g.lineTo(x * s, hgt * s); g.stroke(); }
    for (let y = 5; y < hgt; y += 5) { g.beginPath(); g.moveTo(0, y * s); g.lineTo(w * s, y * s); g.stroke(); }
  }
  let paintVal: number | null = null;
  const pts = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  const place = () => { zoomEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`; };
  const at = (e: PointerEvent) => { const r = cv.getBoundingClientRect(), s = r.width / w; const x = Math.floor((e.clientX - r.left) / s), y = Math.floor((e.clientY - r.top) / s); return x >= 0 && y >= 0 && x < w && y < hgt ? y * w + x : -1; };
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  stage.addEventListener('wheel', e => { e.preventDefault(); zoom = Math.max(1, Math.min(8, zoom * (e.deltaY < 0 ? 1.12 : 0.9))); if (zoom === 1) { panX = 0; panY = 0; } place(); }, { passive: false });
  stage.addEventListener('pointerdown', e => {
    stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size >= 2) { paintVal = null; pinch = dist(); return; }
    if (live) return; // the camera owns the cells until the frame is kept
    const i = at(e); if (i < 0) return;
    paintVal = brush; cells[i] = brush; marks.clear(); draw();
  });
  stage.addEventListener('pointermove', e => {
    const p = pts.get(e.pointerId); if (!p) return;
    if (pts.size >= 2) {
      const prev = pinch; pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); pinch = dist();
      if (prev) zoom = Math.max(1, Math.min(8, zoom * pinch / prev));
      panX += e.clientX - p.x; panY += e.clientY - p.y;
      if (zoom === 1) { panX = 0; panY = 0; }
      place(); return;
    }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (paintVal === null) return;
    const i = at(e); if (i >= 0 && cells[i] !== paintVal) { cells[i] = paintVal; draw(); }
  });
  const endPt = (e: PointerEvent) => { pts.delete(e.pointerId); if (paintVal !== null && pts.size === 0) { paintVal = null; check(); } };
  stage.addEventListener('pointerup', endPt); stage.addEventListener('pointercancel', endPt);

  // ---- image import: scaled to the grid, dark pixels become filled
  const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
  function sample() {
    if (!source) return;
    const c = document.createElement('canvas'); c.width = w; c.height = hgt;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, hgt);
    const sx = source.width * crop.l, sy = source.height * crop.t;
    const sw = Math.max(1, source.width * (1 - crop.l - crop.r)), sh = Math.max(1, source.height * (1 - crop.t - crop.b));
    const sc = Math.min(w / sw, hgt / sh), dw = sw * sc, dh = sh * sc;
    g.imageSmoothingQuality = 'high';
    g.drawImage(source, sx, sy, sw, sh, (w - dw) / 2, (hgt - dh) / 2, dw, dh);
    const d = g.getImageData(0, 0, w, hgt).data;
    const lum = new Float32Array(w * hgt);
    const rgb: Array<[number, number, number]> = [];
    for (let i = 0; i < w * hgt; i++) {
      let L = (0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2]) / 255;
      L = Math.max(0, Math.min(1, (L - 0.5) * contrast + 0.5));
      lum[i] = L; rgb.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
    }
    if (colorsN <= 1) {
      if (dither) {
        for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
          const i = y * w + x, old = lum[i], neu = old < threshold ? 0 : 1, err = old - neu;
          lum[i] = neu;
          if (x + 1 < w) lum[i + 1] += err * 7 / 16;
          if (y + 1 < hgt && x > 0) lum[i + w - 1] += err * 3 / 16;
          if (y + 1 < hgt) lum[i + w] += err * 5 / 16;
          if (y + 1 < hgt && x + 1 < w) lum[i + w + 1] += err * 1 / 16;
        }
      }
      for (let i = 0; i < lum.length; i++) cells[i] = ((dither ? lum[i] < 0.5 : lum[i] < threshold) !== invert) ? 1 : 0;
      palette = ['#1a1a1a']; brush = 1;
      return;
    }
    const ink = rgb.filter((_, i) => lum[i] < 0.92);
    const src = ink.length ? ink : rgb;
    const step = Math.max(1, Math.floor(src.length / colorsN));
    let means = [...Array(colorsN)].map((_, k) => src[Math.min(src.length - 1, k * step)]);
    for (let it = 0; it < 6; it++) {
      const grp: Array<Array<[number, number, number]>> = means.map(() => []);
      for (const p of src) {
        let bi = 0, bd = 1e9;
        means.forEach((m, i) => { const dd = (p[0] - m[0]) ** 2 + (p[1] - m[1]) ** 2 + (p[2] - m[2]) ** 2; if (dd < bd) { bd = dd; bi = i; } });
        grp[bi].push(p);
      }
      means = means.map((m, i) => grp[i].length ? grp[i].reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map(n => n / grp[i].length) as [number, number, number] : m);
    }
    palette = means.map(m => hex(m[0], m[1], m[2]));
    for (let i = 0; i < w * hgt; i++) {
      if (lum[i] >= 0.92) { cells[i] = 0; continue; }
      const p = rgb[i]; let bi = 0, bd = 1e9;
      means.forEach((m, k) => { const dd = (p[0] - m[0]) ** 2 + (p[1] - m[1]) ** 2 + (p[2] - m[2]) ** 2; if (dd < bd) { bd = dd; bi = k; } });
      cells[i] = bi + 1;
    }
    brush = 1;
  }
  function take(img: CanvasImageSource, iw: number, ih: number) {
    source = document.createElement('canvas'); source.width = iw; source.height = ih;
    const g = source.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, iw, ih); g.drawImage(img, 0, 0, iw, ih);
    crop = { l: 0, t: 0, r: 0, b: 0 };
    const ar = iw / ih;
    if (ar > 1) resize(w, Math.max(5, Math.min(30, Math.round(w / ar)))); else resize(Math.max(5, Math.min(30, Math.round(hgt * ar))), hgt);
    sample(); marks.clear(); open.clear(); draw(); check(); paintSwatches();
    imgTools.hidden = false;
  }
  async function importImage() {
    const f = await pickFile('image/*');
    if (!f) return;
    const img = await createImageBitmap(f);
    take(img, img.width, img.height);
  }
  function trim() {
    if (!source) return;
    const g = source.getContext('2d')!, d = g.getImageData(0, 0, source.width, source.height).data;
    let x0 = source.width, y0 = source.height, x1 = 0, y1 = 0;
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * 4;
      if (d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    if (x1 <= x0) return;
    crop = { l: x0 / source.width, t: y0 / source.height, r: 1 - (x1 + 1) / source.width, b: 1 - (y1 + 1) / source.height };
    sample(); marks.clear(); draw(); check();
  }
  const slide = (label: string, min: number, max: number, step: number, value: number, set: (n: number) => void) =>
    h('label', { class: 'ed-slide' }, h('span', {}, label), h('input', { type: 'range', min, max, step, value, onInput: (e: Event) => set(+(e.target as HTMLInputElement).value), onChange: () => check() }));
  const thr = slide(t('edThreshold'), 0.1, 0.9, 0.02, threshold, n => { threshold = n; sample(); marks.clear(); draw(); });
  const con = slide(t('edContrast'), 0.4, 2.4, 0.05, contrast, n => { contrast = n; sample(); marks.clear(); draw(); });
  const cols = slide(t('edColors'), 1, 8, 1, colorsN, n => { colorsN = n; sample(); marks.clear(); draw(); paintSwatches(); });
  const inv = h('label', { class: 'chk' }, h('input', { type: 'checkbox', onChange: (e: Event) => { invert = (e.target as HTMLInputElement).checked; sample(); marks.clear(); draw(); check(); } }), t('edInvert'));
  const dit = h('label', { class: 'chk' }, h('input', { type: 'checkbox', onChange: (e: Event) => { dither = (e.target as HTMLInputElement).checked; sample(); marks.clear(); draw(); check(); } }), t('edDither'));
  const imgTools = h('div', { class: 'ed-img', hidden: true }, thr, con, cols, inv, dit, h('button', { class: 'btn', onClick: trim }, t('edTrim')));

  // ---- uniqueness check and suggested fix
  let fixCells: Array<{ x: number; y: number }> = [];
  function check() {
    const r = rows();
    open = new Set();
    if (!cells.some(v => v > 0)) { draw(); status.replaceChildren(h('span', { class: 'fine' }, t('edEmpty'))); return; }
    const built = builtPuzzle();
    const s = puzzleScore(r);
    s.grid.forEach((v, i) => { if (v === 0) open.add(i); });
    fixCells = [];
    const colored = palette.length > 1;
    const cp = colored ? colorOf({ ...built, colorGame: true }) : null;
    const solutions = cp ? colorSolutionCount(cp, 8000) : (s.solvable ? 1 : 2);
    draw();
    if (solutions === 1 && s.solvable) {
      const d = puzzleLevel({ rows: r });
      status.replaceChildren(h('b', { class: 'ok' }, '✓ ' + t('edUnique')), h('span', { class: 'diff d' + d }, t('diff' + d)));
    } else {
      const left = s.grid.reduce((a, v) => a + (v === 0 ? 1 : 0), 0);
      status.replaceChildren(h('b', { class: 'warn' }, '⚠ ' + t('edAmbiguous', { n: left })),
        h('button', { class: 'btn', onClick: () => {
          fixCells = suggestFix(r, 12);
          marks = new Set(fixCells.map(c => c.y * w + c.x));
          draw();
          status.replaceChildren(fixCells.length
            ? h('span', {}, t('edFixFound', { n: fixCells.length }), ' ', h('button', { class: 'btn primary', onClick: () => { for (const c of fixCells) { const i = c.y * w + c.x; cells[i] = cells[i] ? 0 : 1; } marks.clear(); draw(); check(); } }, t('edApply')))
            : h('span', { class: 'warn' }, t('edNoFix')));
        } }, t('edSuggest')));
    }
  }

  function builtPuzzle(): PackPuzzle {
    const color = palette.length > 1 ? {
      palette: palette.slice(),
      rows: [...Array(hgt)].map((_, y) => cells.slice(y * w, y * w + w).map(v => (v ? (v - 1).toString(36) : '.')).join('')),
    } : undefined;
    return { id: orig?.id ?? 'draft', width: w, height: hgt, rows: rows(), color, ...(color ? { colorGame: true } : {}) };
  }
  async function store(): Promise<number> {
    const built = builtPuzzle();
    const pz: PackPuzzle = { ...built, id: orig?.id ?? newId('p'), name: nameIn.value.trim() ? { [lang()]: nameIn.value.trim() } : undefined };
    const i = index >= 0 ? index : lv.puzzles.length;
    lv.puzzles[i] = pz;
    await save(ed, pack);
    return i;
  }

  const swatches = h('div', { class: 'ed-swatches' });
  function paintSwatches() {
    const add = palette.length < 8 ? h('button', { class: 'swatch add', onClick: () => { const next = INK.find(c => !palette.some(p => p.toLowerCase() === c.toLowerCase())) ?? '#888'; palette = [...palette, next]; brush = palette.length; paintSwatches(); } }, '+') : null;
    swatches.replaceChildren(
      h('button', { class: 'swatch empty' + (brush === 0 ? ' on' : ''), title: t('edEraser'), onClick: () => { brush = 0; paintSwatches(); } }, '✕'),
      ...palette.map((c, i) => h('button', { class: 'swatch' + (brush === i + 1 ? ' on' : ''), style: `background:${swatchHex(c)}`, onClick: () => { brush = i + 1; paintSwatches(); } })),
      ...(add ? [add] : []));
  }
  paintSwatches();

  const camBar = h('div', { class: 'ed-img', hidden: true });
  const toolBtns = h('span', { class: 'ed-tools' },
    h('button', { class: 'btn', onClick: importImage }, '🖼 ' + t('edImport')),
    h('button', { class: 'btn', onClick: () => { void camera(); } }, '📷 ' + t('edCamera')),
    h('button', { class: 'btn', onClick: () => { zoom = Math.min(8, zoom * 1.25); place(); } }, '+'),
    h('button', { class: 'btn', onClick: () => { zoom = Math.max(1, zoom / 1.25); if (zoom === 1) { panX = 0; panY = 0; } place(); } }, '−'),
    h('button', { class: 'btn', onClick: () => { cells = cells.map(v => v ? 0 : brush || 1); marks.clear(); draw(); check(); } }, t('edInvertAll')),
    h('button', { class: 'btn', onClick: () => { if (live) return; cells.fill(0); source = null; imgTools.hidden = true; marks.clear(); open.clear(); draw(); check(); } }, t('edClear')));
  stopCam = () => {
    live = false;
    if (camTimer) { window.clearTimeout(camTimer); camTimer = 0; }
    camStream?.getTracks().forEach(tr => tr.stop());
    camStream = null;
    camBar.hidden = true;
    camBar.replaceChildren();
    toolBtns.hidden = false;
    swatches.hidden = false;
  };
  // The grid itself is the camera picture, rebuilt twice a second until the frame is kept. Two frames a
  // second is enough to aim a real object, and slow enough that the cells stay readable. A larger grid
  // keeps more of that picture.
  /** cover-crop one camera frame into the current grid. Bigger width × height keeps more detail. */
  function see(video: HTMLVideoElement) {
    if (!video.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = w; c.height = hgt;
    const g = c.getContext('2d')!;
    const vw = video.videoWidth, vh = video.videoHeight, sc = Math.max(w / vw, hgt / vh);
    g.drawImage(video, (w - vw * sc) / 2, (hgt - vh * sc) / 2, vw * sc, vh * sc);
    const d = g.getImageData(0, 0, w, hgt).data;
    const lum = new Float32Array(w * hgt);
    for (let i = 0; i < lum.length; i++) {
      const L = (0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2]) / 255;
      lum[i] = Math.max(0, Math.min(1, (L - 0.5) * contrast + 0.5));
    }
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, old = lum[i], neu = old < 0.5 ? 0 : 1, err = old - neu;
      lum[i] = neu;
      if (x + 1 < w) lum[i + 1] += err * 7 / 16;
      if (y + 1 < hgt && x > 0) lum[i + w - 1] += err * 3 / 16;
      if (y + 1 < hgt) lum[i + w] += err * 5 / 16;
      if (y + 1 < hgt && x + 1 < w) lum[i + w + 1] += err * 1 / 16;
    }
    palette = ['#1a1a1a']; brush = 1;
    for (let i = 0; i < lum.length; i++) cells[i] = ((lum[i] < 0.5) !== invert) ? 1 : 0;
    marks.clear(); open.clear(); draw();
  }
  async function camera() {
    if (live) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 960 }, height: { ideal: 720 } },
      });
    } catch { await message(t('edNoCamera')); return; }
    const video = document.createElement('video');
    video.srcObject = stream; video.playsInline = true; video.muted = true;
    try { await video.play(); }
    catch { stream.getTracks().forEach(tr => tr.stop()); await message(t('edNoCamera')); return; }
    const track = stream.getVideoTracks()[0];
    const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { focusDistance?: { min: number; max: number } };
    try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }); } catch { /* the camera focuses on its own */ }
    live = true;
    source = null;
    imgTools.hidden = true;
    toolBtns.hidden = true;
    swatches.hidden = true;
    camStream = stream;
    if (contrast < 1.2) contrast = 1.4;
    const slideOnly = (label: string, min: number, max: number, step: number, value: number, set: (n: number) => void) =>
      h('label', { class: 'ed-slide' }, h('span', {}, label), h('input', { type: 'range', min, max, step, value, onInput: (e: Event) => set(+(e.target as HTMLInputElement).value) }));
    const fd = caps.focusDistance;
    const focus = fd && fd.max > fd.min ? slideOnly(t('edFocus'), 0, 1, 0.01, 0.3, u => {
      const near = Math.max(fd.min, 0.02), far = Math.max(fd.max, near + 0.01);
      const dist = Math.exp(Math.log(near) + u * (Math.log(far) - Math.log(near)));
      track.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: dist } as MediaTrackConstraintSet] }).catch(() => {});
    }) : null;
    const finish = () => { stopCam(); palette = ['#1a1a1a']; brush = 1; paintSwatches(); marks.clear(); open.clear(); draw(); check(); };
    camBar.replaceChildren(
      slideOnly(t('edContrast'), 0.6, 2.4, 0.05, contrast, n => { contrast = n; }),
      ...(focus ? [focus] : []),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: invert, onChange: (e: Event) => { invert = (e.target as HTMLInputElement).checked; } }), t('edInvert')),
      h('button', { class: 'btn primary', onClick: finish }, t('edCapture')));
    camBar.hidden = false;
    status.replaceChildren(h('span', { class: 'fine' }, t('edCamHint')));
    const tick = () => { if (!live) return; see(video); camTimer = window.setTimeout(tick, 500); };
    tick();
  }

  ed.screen(ed.header(orig ? `${t('puzzleNo')} ${index + 1}` : t('edNewPuzzle'), back), h('div', { class: 'editor' },
    h('div', { class: 'ed-bar' }, h('label', {}, t('size'), wIn, '×', hIn), toolBtns),
    swatches, imgTools, camBar, stage,
    status,
    nameIn,
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn', onClick: async () => { const i = await store(); ed.test(pack, lv, i, () => puzzleEditor(ed, pack, li, i)); } }, icon('play'), t('edTest')),
      h('button', { class: 'btn primary', onClick: async () => { await store(); back(); } }, t('edSave')),
      orig ? h('button', { class: 'btn', onClick: async () => { lv.puzzles.splice(index, 1); await save(ed, pack); back(); } }, '🗑') : null)));
  requestAnimationFrame(() => { draw(); check(); });
}
