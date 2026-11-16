// MomoGram UI: home, level/puzzle selection, play screen, solved screen, packs and options.
import { Board, formatTime, FILL, CROSS } from './game/board';
import { BoardView } from './game/view';
import { PictureAnimator, thumbnail, PckGetter } from './game/picture';
import { Pack, PackLevel, PackPuzzle, Lang, pickText, pickAny } from './packs/format';
import { PicrossDsData, pckFile, readPicrossDs } from './rom/picrossds';
import { storage, settings, saveSettings, getProgress, recordClear, getQuickSave, setQuickSave, resetProgress } from './store';
import { t, setLang, lang, LANG_NAMES } from './i18n';
import { Gamepads } from './input';
import { openPackManager } from './ui/packs';
import { Audio as Snd } from './audio';
import { unzipFirst } from './util/files';

const TIME_LIMIT = 60 * 60_000;

interface Ctx {
  ds: PicrossDsData | null;
  packs: Pack[];
  pck: PckGetter | null;
}

const ctx: Ctx = { ds: null, packs: [], pck: null };
const root = () => document.getElementById('app')!;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: Array<Node | string | null | undefined | false>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) (e as any)[k.toLowerCase()] = v;
    else if (k === 'class') e.className = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}
export { h };

function screen(...kids: Array<Node | null>): HTMLElement {
  const r = root();
  r.innerHTML = '';
  const s = h('div', { class: 'screen' }, ...kids);
  r.append(s);
  Gamepads.focusFirst(s);
  return s;
}

function header(title: string, back?: () => void): HTMLElement {
  return h('header', { class: 'bar' },
    back ? h('button', { class: 'btn ghost back', onClick: back, 'aria-label': t('back') }, '‹ ' + t('back')) : h('span'),
    h('h1', {}, title), h('span'));
}

function packLang(): Lang { return lang(); }

// ---------------------------------------------------------------- unlocking

function clearedInGroup(pack: Pack, group: string | undefined): number {
  let n = 0;
  for (const l of pack.levels) if (l.group === group) for (const p of l.puzzles) if (getProgress(pack.id, p.id).cleared) n++;
  return n;
}

export function levelUnlocked(pack: Pack, lv: PackLevel): boolean {
  if (settings.unlockAll) return true;
  if (lv.extra) {
    return pack.levels.filter(l => l.group === lv.group && !l.extra).every(l => l.puzzles.every(p => getProgress(pack.id, p.id).underLimit));
  }
  return !lv.unlockAfter || clearedInGroup(pack, lv.group) >= lv.unlockAfter;
}

// ---------------------------------------------------------------- home

export async function boot() {
  const want = (settings.lang || navigator.language.slice(0, 2)) as Lang;
  setLang(['en', 'de', 'fr', 'it', 'es', 'ja', 'ko'].includes(want) ? want : 'en');
  storage.persist();
  try {
    const rom = await storage.loadRom('picross-ds');
    if (rom) loadDs(rom);
  } catch (e) { console.warn(e); }
  ctx.packs = (await storage.allPacks().catch(() => [])) ?? [];
  Snd.init(() => ctx.ds?.sdat ?? null);
  home();
}

function loadDs(data: Uint8Array) {
  ctx.ds = readPicrossDs(data);
  ctx.pck = i => (ctx.ds ? pckFile(ctx.ds, i) : null);
  if (!settings.lang) setLang(ctx.ds.languages.includes(lang()) ? lang() : ctx.ds.languages[0]);
}

async function pickRom() {
  const f = await pickFile('.nds,.zip,.srl');
  if (!f) return;
  let data = new Uint8Array(await f.arrayBuffer());
  if (/\.zip$/i.test(f.name)) {
    const inner = await unzipFirst(data, /\.nds$/i);
    if (!inner) { alert('No .nds file in this zip.'); return; }
    data = inner as Uint8Array<ArrayBuffer>;
  }
  try {
    loadDs(data);
    await storage.saveRom('picross-ds', data);
    home();
  } catch (e: any) {
    alert(e.message || String(e));
  }
}

export function pickFile(accept: string, multiple = false): Promise<File | null> {
  return pickFiles(accept, multiple).then(f => f[0] ?? null);
}
export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise(res => {
    const i = h('input', { type: 'file', accept, multiple: multiple || undefined }) as HTMLInputElement;
    i.onchange = () => res([...(i.files ?? [])]);
    i.click();
  });
}

function logo(): HTMLElement {
  // original MomoGram mark: an hourglass drawn in grid cells
  const rows = ['#######', '.#####.', '..###..', '...#...', '..#.#..', '.#...#.', '#######'];
  const g = h('div', { class: 'logo-grid', 'aria-hidden': 'true' });
  rows.forEach(r => [...r].forEach(c => g.append(h('i', { class: c === '#' ? 'on' : '' }))));
  return h('div', { class: 'logo' }, g, h('div', {}, h('div', { class: 'logo-name' }, 'MomoGram'), h('div', { class: 'tagline' }, t('tagline'))));
}

export function home() {
  Snd.play('title_SEQ');
  const items: HTMLElement[] = [];
  if (!ctx.ds) {
    items.push(h('section', { class: 'card setup' },
      h('p', {}, t('romHelp')),
      h('button', { class: 'btn primary big', onClick: pickRom }, t('addRom'))));
  } else {
    const q = getQuickSave();
    if (q) items.push(h('button', { class: 'btn primary big', onClick: () => resumeQuick() }, '▶ ' + t('continue')));
    const ds = ctx.ds.pack;
    const easy = ds.levels.find(l => l.group === 'easy')!;
    items.push(h('div', { class: 'menu' },
      h('button', { class: 'btn big mode easy', onClick: () => puzzleList(ds, easy, home) }, h('b', {}, t('easy')), h('small', {}, progressText(ds, [easy]))),
      h('button', { class: 'btn big mode normal', onClick: () => levelList(ds, 'normal') }, h('b', {}, t('normal')), h('small', {}, progressText(ds, ds.levels.filter(l => l.group === 'normal')))),
      h('button', { class: 'btn big mode free', onClick: () => levelList(ds, 'free') }, h('b', {}, t('free')), h('small', {}, progressText(ds, ds.levels.filter(l => l.group === 'free')))),
      h('button', { class: 'btn big mode daily', onClick: () => daily() }, h('b', {}, t('daily')), h('small', {}, '7×7')),
    ));
  }
  items.push(h('div', { class: 'menu small' },
    h('button', { class: 'btn', onClick: () => packsScreen() }, '📦 ' + t('packs') + (ctx.packs.length ? ` (${ctx.packs.length})` : '')),
    h('button', { class: 'btn', onClick: () => optionsScreen() }, '⚙ ' + t('options'))));
  let total = 0, cleared = 0;
  if (ctx.ds) for (const l of ctx.ds.pack.levels) for (const p of l.puzzles) { total++; if (getProgress(ctx.ds.pack.id, p.id).cleared) cleared++; }
  const topScreen = h('section', { class: 'home-top' }, logo(),
    ctx.ds ? h('div', { class: 'home-progress' }, h('div', { class: 'bar-outer' }, h('div', { class: 'bar-inner', style: `width:${total ? (cleared / total) * 100 : 0}%` })), h('small', {}, t('solvedCount', { a: cleared, b: total }))) : null);
  screen(h('div', { class: 'home' }, topScreen, h('section', { class: 'home-bottom' }, ...items), h('footer', { class: 'fine' }, ctx.ds ? t('romLoaded', { region: ctx.ds.region }) : '')));
}

function progressText(pack: Pack, levels: PackLevel[]) {
  let a = 0, b = 0;
  for (const l of levels) for (const p of l.puzzles) { b++; if (getProgress(pack.id, p.id).cleared) a++; }
  return t('solvedCount', { a, b });
}

// ---------------------------------------------------------------- level & puzzle lists

function levelList(pack: Pack, group: string, back: () => void = home) {
  const levels = pack.levels.filter(l => l.group === group);
  const list = h('div', { class: 'levels' });
  for (const lv of levels) {
    const open = levelUnlocked(pack, lv);
    const done = lv.puzzles.filter(p => getProgress(pack.id, p.id).cleared).length;
    const sz = `${lv.puzzles[0].width}×${lv.puzzles[0].height}`;
    list.append(h('button', {
      class: 'btn level' + (open ? '' : ' locked') + (done === lv.puzzles.length ? ' complete' : ''),
      disabled: open ? undefined : true,
      title: open ? '' : lv.extra ? t('extraHint') : t('unlockHint', { n: lv.unlockAfter ?? 0 }),
      onClick: () => puzzleList(pack, lv, () => levelList(pack, group, back)),
    }, h('b', {}, pickAny(lv.title, packLang())), h('small', {}, open ? `${sz} · ${done}/${lv.puzzles.length}` : '🔒 ' + (lv.extra ? t('extraHint') : t('unlockHint', { n: lv.unlockAfter ?? 0 })))));
  }
  screen(header(group === 'normal' ? t('normal') : group === 'free' ? t('free') : pickAny(pack.title, packLang()), back), list);
}

function puzzleList(pack: Pack, lv: PackLevel, back: () => void) {
  const grid = h('div', { class: 'puzzles' });
  const pck = pack.id === 'picross-ds' ? ctx.pck : null;
  lv.puzzles.forEach((p, i) => {
    const pr = getProgress(pack.id, p.id);
    const tile = h('button', { class: 'btn puzzle' + (pr.cleared ? ' cleared' : ''), onClick: () => play(pack, lv, i, back) });
    if (pr.cleared) tile.append(thumbnail(p, pck, 64));
    else tile.append(h('span', { class: 'qmark' }, '?'));
    tile.append(h('small', {}, pr.cleared ? (pickText(p.name, packLang()) || `${p.width}×${p.height}`) : `${p.width}×${p.height}`));
    if (pr.best !== undefined) tile.append(h('em', {}, formatTime(pr.best)));
    tile.append(h('span', { class: 'num' }, String(i + 1)));
    if (pr.underLimit) tile.append(h('span', { class: 'star', title: '< 60:00' }, '★'));
    grid.append(tile);
  });
  // level tabs for quick switching within the same mode, like the level selector on the DS
  const sib = lv.group ? pack.levels.filter(l => l.group === lv.group) : [];
  const tabs = sib.length > 1 ? h('div', { class: 'tabs' }, ...sib.map(l => {
    const open = levelUnlocked(pack, l);
    const label = pickAny(l.title, packLang()).replace(/^\D+\s(?=\d)/, '').replace(/^.*Extra$/, 'EX');
    return h('button', { class: 'tab' + (l === lv ? ' on' : ''), disabled: open ? undefined : true, onClick: () => puzzleList(pack, l, back) }, open ? label : '🔒');
  })) : null;
  const done = lv.puzzles.filter(p => getProgress(pack.id, p.id).cleared).length;
  screen(header(pickAny(lv.title, packLang()), back), tabs,
    h('p', { class: 'rules' }, (lv.rules === 'free' ? t('rulesFree') : t('rulesNormal')) + ` · ${done}/${lv.puzzles.length}`), grid);
}

function resumeQuick() {
  const q = getQuickSave();
  if (!q) return home();
  const pack = allPacks().find(p => p.id === q.packId);
  const lv = pack?.levels.find(l => l.id === q.levelId);
  const i = lv?.puzzles.findIndex(p => p.id === q.puzzleId) ?? -1;
  if (!pack || !lv || i < 0) { setQuickSave(null); return home(); }
  play(pack, lv, i, home, q.state);
}

function allPacks(): Pack[] { return [...(ctx.ds ? [ctx.ds.pack] : []), ...ctx.packs]; }

// ---------------------------------------------------------------- daily

function daily() {
  if (!ctx.ds) return;
  const d = new Date();
  const seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const pool = ctx.ds.daily7.filter(p => p.rows.some(r => r.includes('#')));
  const puzzles = [0, 1, 2, 3, 4].map(k => ({ ...pool[(seed * 7919 + k * 104729) % pool.length], id: `daily-${seed}-${k}` }));
  const lv: PackLevel = { id: 'daily-' + seed, title: { en: t('daily') }, rules: 'normal', puzzles };
  const pack: Pack = { format: 'momogram-pack', version: 1, id: 'daily', title: { en: t('daily') }, source: { game: 'Picross DS', platform: 'Nintendo DS' }, levels: [lv] };
  puzzleList(pack, lv, home);
}

// ---------------------------------------------------------------- play

function play(pack: Pack, lv: PackLevel, index: number, back: () => void, restore?: any) {
  const pz = lv.puzzles[index];
  const board = new Board(pz.rows, lv.rules);
  if (restore) board.restore(restore);
  const isDs = pack.id === 'picross-ds';
  Snd.play(lv.rules === 'free' ? settings.freeStyle : settings.normalStyle);

  // DS-style layout: a "top screen" with the live picture, zoom frame and timer; the "touch screen" with the grid.
  const timeEl = h('span', { class: 'time' }, '00:00');
  const mistakesEl = h('span', { class: 'mist' });
  const preview = h('canvas', { class: 'preview' });
  const levelLabel = h('div', { class: 'lvl' }, h('b', {}, pickAny(lv.title, packLang())), h('span', {}, `${t('puzzleNo')} ${index + 1}`));
  const sizeLabel = h('div', { class: 'size' }, `${pz.width} × ${pz.height}`);
  const top = h('section', { class: 'top' },
    h('div', { class: 'screen-frame' }, preview),
    h('div', { class: 'info' }, levelLabel, sizeLabel, h('div', { class: 'stats' }, h('span', { class: 'clock' }, '⏱'), timeEl, mistakesEl),
      h('div', { class: 'rulechip ' + lv.rules }, lv.rules === 'free' ? t('free') : t('normal'))));
  const canvas = h('canvas', { class: 'board' });
  // tool pad in the clue corner, like the stylus icons on the DS
  const penBtn = h('button', { class: 'pad on', title: t('fill'), 'aria-label': t('fill'), onClick: () => setTool('fill') }, h('i', { class: 'ico pen' }));
  const xBtn = h('button', { class: 'pad', title: t('cross'), 'aria-label': t('cross'), onClick: () => setTool('cross') }, h('i', { class: 'ico cross' }));
  const lensBtn = h('button', { class: 'pad', title: t('zoom'), 'aria-label': t('zoom'), onClick: () => { view.toggleZoom(); lensBtn.classList.toggle('on', view.zoomed); } }, h('i', { class: 'ico lens' }));
  const toolPad = h('div', { class: 'toolpad' }, penBtn, xBtn, lensBtn);
  const boardWrap = h('section', { class: 'boardwrap' }, canvas, toolPad);

  const undoBtn = h('button', { class: 'btn tool', onClick: () => { if (board.undo()) { view.invalidate(); updateInfo(); } } }, '↶ ' + t('undo'));
  const trialBtn = lv.rules === 'free' ? h('button', { class: 'btn tool', onClick: () => trialToggle() }, t('tryIt')) : null;
  const menuBtn = h('button', { class: 'btn tool', onClick: () => pauseMenu() }, '☰ ' + t('menu'));
  const tools = h('nav', { class: 'tools' + (settings.lefty ? ' lefty' : '') }, undoBtn, trialBtn, menuBtn);
  const fillBtn = penBtn, crossBtn = xBtn;

  screen(h('div', { class: 'play' }, top, boardWrap, tools));

  const view = new BoardView(canvas, board, {
    onChange: r => {
      if (r === 'mistake') Snd.sfx('mistake'); else Snd.sfx('tap');
      updateInfo();
      if (board.checkSolved()) solved();
    },
  });

  if (/[?&]debug/.test(location.search)) (window as any).__play = {
    board, view,
    solve() { for (let y = 0; y < board.h; y++) for (let x = 0; x < board.w; x++) board.cells[y * board.w + x] = board.solution[y * board.w + x] ? FILL : CROSS; view.invalidate(); if (board.checkSolved()) solved(); },
  };

  view.onLayout = () => {
    const c = view.cornerRect();
    const sz = Math.max(22, Math.min(56, Math.floor((Math.min(c.w, c.h) - 10) / 2)));
    Object.assign(toolPad.style, { left: c.x + 'px', top: c.y + 'px', width: c.w + 'px', height: c.h + 'px', '--pad': sz + 'px' });
    lensBtn.classList.toggle('on', view.zoomed);
    updateInfo();
  };

  function setTool(tool: 'fill' | 'cross') {
    view.tool = tool;
    fillBtn.classList.toggle('on', tool === 'fill');
    crossBtn.classList.toggle('on', tool === 'cross');
  }

  function trialToggle() {
    if (!board.trial) { board.startTrial(); trialBtn!.textContent = t('keep') + ' / ' + t('discard'); trialBtn!.classList.add('on'); }
    else {
      choose(t('tryIt'), [[t('keep'), () => board.commitTrial()], [t('discard'), () => board.discardTrial()], [t('back'), () => { /* stay */ }]]).then(() => {
        if (!board.trial) { trialBtn!.textContent = t('tryIt'); trialBtn!.classList.remove('on'); }
        view.invalidate();
        if (board.checkSolved()) solved();
      });
    }
    view.invalidate();
  }

  function updateInfo() {
    timeEl.textContent = formatTime(Math.min(board.totalMs, 99 * 60_000 + 59_000));
    timeEl.classList.toggle('over', board.totalMs >= TIME_LIMIT);
    mistakesEl.textContent = board.mistakes ? `✕${board.mistakes}` : '';
    // live picture of the board, with the zoom frame when zoomed in
    const r = preview.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (preview.width !== W || preview.height !== H) { preview.width = W; preview.height = H; }
    const pc = preview.getContext('2d')!;
    const sc = Math.min(W / board.w, H / board.h) * 0.9;
    pc.fillStyle = '#f7fbff'; pc.fillRect(0, 0, W, H);
    const ox = (W - board.w * sc) / 2, oy = (H - board.h * sc) / 2;
    pc.fillStyle = '#e3edf8'; pc.fillRect(ox, oy, board.w * sc, board.h * sc);
    for (let y = 0; y < board.h; y++) for (let x = 0; x < board.w; x++) {
      const v = board.at(x, y);
      if (v === FILL) { pc.fillStyle = board.isTrialCell(x, y) ? '#e08a2c' : '#24375f'; pc.fillRect(ox + x * sc, oy + y * sc, Math.ceil(sc), Math.ceil(sc)); }
    }
    if (view.zoomed) {
      const v = view.visibleCells();
      pc.strokeStyle = '#f0a020'; pc.lineWidth = Math.max(2, dpr * 2);
      pc.strokeRect(ox + v.x * sc, oy + v.y * sc, v.w * sc, v.h * sc);
    }
  }

  // layout
  const ro = new ResizeObserver(() => {
    const r = boardWrap.getBoundingClientRect();
    view.resize(Math.floor(r.width), Math.floor(r.height));
  });
  ro.observe(boardWrap);

  // timer
  let last = performance.now(), running = true, finished = false;
  const tick = () => {
    if (finished) return;
    const now = performance.now();
    if (running && !board.solved) board.elapsedMs += now - last;
    last = now;
    updateInfo();
    timerId = window.setTimeout(tick, 250);
  };
  let timerId = window.setTimeout(tick, 250);
  updateInfo();

  // keyboard & gamepad
  let held: number | null = null; // painting value while A/B is held
  const key = (e: KeyboardEvent) => {
    if (document.querySelector('.modal')) return;
    const k = e.key;
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1], a: [-1, 0], d: [1, 0], w: [0, -1], s: [0, 1] };
    if (dirs[k]) { e.preventDefault(); view.moveCursor(dirs[k][0], dirs[k][1], held as any); return; }
    if ((k === 'z' || k === ' ' || k === 'Enter') && !e.repeat) { held = view.pressAtCursor('fill'); }
    else if ((k === 'x' || k === 'Shift') && !e.repeat) { held = view.pressAtCursor('cross'); }
    else if (k === 'c') view.toggleZoom();
    else if (k === 'Escape') pauseMenu();
    else if ((k === 'u' || (k === 'z' && (e.ctrlKey || e.metaKey)))) { if (board.undo()) view.invalidate(); }
  };
  const keyUp = (e: KeyboardEvent) => { if (['z', 'x', ' ', 'Enter', 'Shift'].includes(e.key)) held = null; };
  window.addEventListener('keydown', key);
  window.addEventListener('keyup', keyUp);
  const gp = Gamepads.onPlay({
    move: (dx, dy) => view.moveCursor(dx, dy, held as any),
    a: down => { held = down ? view.pressAtCursor('fill') : null; },
    b: down => { held = down ? view.pressAtCursor('cross') : null; },
    y: () => view.toggleZoom(),
    start: () => pauseMenu(),
    l: () => { if (board.undo()) view.invalidate(); },
    r: () => trialBtn && trialToggle(),
  });

  function cleanup() {
    finished = true;
    clearTimeout(timerId);
    ro.disconnect();
    view.destroy();
    window.removeEventListener('keydown', key);
    window.removeEventListener('keyup', keyUp);
    gp();
  }

  async function pauseMenu() {
    running = false;
    await choose(t('menu'), [
      [t('resume'), () => {}],
      [t('stopSave'), () => { setQuickSave({ packId: pack.id, levelId: lv.id, puzzleId: pz.id, state: board.snapshot() }); cleanup(); back(); }],
      [t('restart'), () => { cleanup(); setQuickSave(null); play(pack, lv, index, back); }],
      [t('quit'), () => { cleanup(); setQuickSave(null); back(); }],
    ]);
    last = performance.now();
    running = true;
  }

  // hint roulette (Normal rules, fresh start)
  if (!restore && lv.rules === 'normal' && pz.width * pz.height > 25) {
    const ask = settings.hints;
    const go = () => { board.pushUndo(); board.revealHint(); view.invalidate(); updateInfo(); };
    if (ask === 'always') go();
    else if (ask === 'ask') { running = false; choose(t('useHints'), [[t('yes'), go], [t('no'), () => {}]]).then(() => { last = performance.now(); running = true; }); }
  }

  function solved() {
    finished = true;
    Snd.play('game_clear_jingle_SEQ', false);
    const under = board.totalMs < TIME_LIMIT;
    if (pack.id !== 'daily') recordClear(pack.id, pz.id, board.totalMs, under);
    setQuickSave(null);
    cleanup();
    showSolved(pack, lv, index, board, under, isDs ? ctx.pck : null, back);
  }
}

function showSolved(pack: Pack, lv: PackLevel, index: number, board: Board, under: boolean, pck: PckGetter | null, back: () => void) {
  const pz = lv.puzzles[index];
  const cv = h('canvas', { class: 'solved-pic' });
  const anim = new PictureAnimator(pz as any, pck);
  const best = getProgress(pack.id, pz.id).best;
  const next = index + 1 < lv.puzzles.length ? h('button', { class: 'btn primary', onClick: () => { stop(); play(pack, lv, index + 1, back); } }, t('next') + ' ›') : null;
  screen(h('div', { class: 'solved' },
    h('div', { class: 'stamp' }, t('cleared')),
    under ? h('div', { class: 'pic-frame' }, cv) : h('p', { class: 'over' }, t('overLimit')),
    h('h2', {}, pickText(pz.name, packLang()) || `${pz.width}×${pz.height}`),
    h('div', { class: 'result' },
      h('div', {}, t('time'), h('b', {}, formatTime(board.totalMs))),
      board.mistakes ? h('div', {}, t('penalty'), h('b', {}, '+' + formatTime(board.penaltyMs))) : null,
      best !== undefined ? h('div', {}, t('best'), h('b', {}, formatTime(best))) : null),
    h('div', { class: 'row' }, h('button', { class: 'btn', onClick: () => { stop(); back(); } }, t('toList')), next)));
  setTimeout(() => Snd.play('game_clear_loop_SEQ'), 2500);
  let raf = 0, last = performance.now();
  const loop = () => {
    const r = cv.getBoundingClientRect();
    const size = Math.floor(Math.min(r.width, r.height)) || 192;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== size * dpr) { cv.width = size * dpr; cv.height = size * dpr; }
    const g = cv.getContext('2d')!;
    const now = performance.now();
    anim.tick(now - last); last = now;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    anim.draw(g, 0, 0, cv.width);
    raf = requestAnimationFrame(loop);
  };
  if (under) loop();
  function stop() { cancelAnimationFrame(raf); }
}

// ---------------------------------------------------------------- dialogs

export function choose(title: string, options: Array<[string, () => void]>): Promise<void> {
  return new Promise(res => {
    const m = h('div', { class: 'modal' });
    const box = h('div', { class: 'dialog' }, h('h3', {}, title));
    for (const [label, fn] of options) box.append(h('button', { class: 'btn', onClick: () => { m.remove(); Gamepads.popModal(); fn(); res(); } }, label));
    m.append(box);
    document.body.append(m);
    Gamepads.pushModal(box);
  });
}

// ---------------------------------------------------------------- packs

function packsScreen() {
  openPackManager({
    root: root(),
    packs: () => ctx.packs,
    setPacks: p => { ctx.packs = p; },
    header: (title: string) => header(title, home),
    screen,
    openPack: (p: Pack) => packLevels(p),
  });
}

function packLevels(pack: Pack) {
  if (pack.levels.length === 1) return puzzleList(pack, pack.levels[0], packsScreen);
  const groups = [...new Set(pack.levels.map(l => l.group ?? ''))];
  if (groups.length > 1 || groups[0]) {
    const list = h('div', { class: 'levels' });
    for (const g of groups) {
      const lvs = pack.levels.filter(l => (l.group ?? '') === g);
      list.append(h('button', { class: 'btn level', onClick: () => groupLevels(pack, g) }, h('b', {}, groupTitle(pack, g)), h('small', {}, progressText(pack, lvs))));
    }
    return screen(header(pickAny(pack.title, packLang()), packsScreen), list);
  }
  groupLevels(pack, '');
}

function groupTitle(pack: Pack, g: string) {
  const lv = pack.levels.find(l => (l.group ?? '') === g);
  return (lv as any)?.groupTitle ? pickText((lv as any).groupTitle, packLang()) : g || pickAny(pack.title, packLang());
}

function groupLevels(pack: Pack, g: string) {
  const levels = pack.levels.filter(l => (l.group ?? '') === g);
  const list = h('div', { class: 'levels' });
  for (const lv of levels) {
    const open = levelUnlocked(pack, lv);
    const done = lv.puzzles.filter(p => getProgress(pack.id, p.id).cleared).length;
    list.append(h('button', { class: 'btn level' + (open ? '' : ' locked'), disabled: open ? undefined : true, onClick: () => puzzleList(pack, lv, () => groupLevels(pack, g)) },
      h('b', {}, pickAny(lv.title, packLang())), h('small', {}, `${lv.puzzles.length} ${t('puzzles')} · ${done}/${lv.puzzles.length}`)));
  }
  screen(header(groupTitle(pack, g), () => packLevels(pack)), list);
}

// ---------------------------------------------------------------- options

function optionsScreen() {
  const sel = (key: keyof typeof settings, opts: Array<[string, string]>) => {
    const s = h('select', { onChange: (e: Event) => { (settings as any)[key] = (e.target as HTMLSelectElement).value; saveSettings(); if (key === 'lang') { setLang(settings.lang as Lang); optionsScreen(); } } });
    for (const [v, l] of opts) s.append(h('option', { value: v, selected: String(settings[key]) === v ? true : undefined }, l));
    return s;
  };
  const chk = (key: keyof typeof settings, after?: () => void) => {
    const c = h('input', { type: 'checkbox', checked: settings[key] ? true : undefined, onChange: (e: Event) => { (settings as any)[key] = (e.target as HTMLInputElement).checked; saveSettings(); after?.(); } });
    return c;
  };
  const styles: Array<[string, string]> = [
    ['stage_jazz_SEQ', 'Jazz'], ['stage_reggae_SEQ', 'Reggae'], ['stage_bossanova_SEQ', 'Bossa Nova'], ['stage_waltz_SEQ', 'Waltz'],
    ['stage_musette_SEQ', 'Musette'], ['stage_musicbox_SEQ', 'Music Box'], ['stage_rock_SEQ', 'Rock'], ['stage_house_SEQ', 'House'], ['stage_sine_SEQ', 'Sine'],
  ];
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: settings.musicVolume, onInput: (e: Event) => { settings.musicVolume = +(e.target as HTMLInputElement).value; saveSettings(); Snd.setVolume(settings.musicVolume); } });
  const row = (label: string, ctl: Node) => h('label', { class: 'opt' }, h('span', {}, label), ctl);
  screen(header(t('options'), home), h('div', { class: 'options' },
    row(t('language'), sel('lang', [['', 'Auto'], ...(Object.entries(LANG_NAMES) as Array<[string, string]>)])),
    row(t('music'), chk('music', () => settings.music ? Snd.play('title_SEQ') : Snd.stop())),
    row(t('volume'), vol),
    row(t('sfx'), chk('sfx')),
    row(t('normalMusic'), sel('normalStyle', styles)),
    row(t('freeMusic'), sel('freeStyle', styles)),
    row(t('hints'), sel('hints', [['ask', t('ask')], ['always', t('always')], ['never', t('never')]])),
    row(t('unlockAll'), chk('unlockAll')),
    row('Lefty toolbar', chk('lefty')),
    h('p', { class: 'fine' }, t('controls')),
    ctx.ds ? h('div', { class: 'row' },
      h('button', { class: 'btn', onClick: () => { if (confirm(t('confirmReset'))) resetProgress('picross-ds'); } }, t('resetProgress')),
      h('button', { class: 'btn', onClick: async () => { await storage.deleteRom('picross-ds'); ctx.ds = null; ctx.pck = null; home(); } }, t('removeRom'))) : null,
    h('p', { class: 'fine' }, 'MomoGram ' + (window as any).MOMOGRAM_VERSION + ' · MIT · No game data included.')));
}

export { ctx, CROSS };
