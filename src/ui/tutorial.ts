// The tutorials: short guided puzzles for nonograms, Mega and Color.
import { Audio as Snd } from '../audio';
import { Board, CROSS, FILL } from '../game/board';
import { inkOn } from '../game/color';
import { BoardView } from '../game/view';
import { t } from '../i18n';
import { saveSettings, settings } from '../store';
import { choose } from './dialog';
import { icon } from './icons';
import { h, header, home, screen, themeRoot, toolSwitchArt } from '../app';

// ---------------------------------------------------------------- tutorial
// A short guided puzzle (and one for Mega), like a game's first lessons: each step points at the lines
// it talks about and goes on by itself once you've done what it asks. Easy rules, so mistakes are caught.
type TutStep = { text: string; rows?: number[]; cols?: number[]; done?: (b: Board) => boolean };
const TUT_PUZZLE = ['#####', '#.#.#', '#####', '.###.', '..#..'];
const TUT_MEGA = ['#..##', '#..##', '#.#..', '###..', '.###.'];
const TUT_COLOR = ['.R.R.', 'RRRRR', '.RRR.', '..G..', '.GGG.'];
const TUT_PAL = ['#e0413a', '#3aa64c'];
type Lesson = 'basic' | 'mega' | 'color';
export function tutorialScreen(back: () => void, lesson: Lesson = 'basic') {
  themeRoot(null);
  const mega = lesson === 'mega', colorL = lesson === 'color';
  const rowsOf = mega ? TUT_MEGA : colorL ? TUT_COLOR.map(r => r.replace(/[A-Z]/g, '#')) : TUT_PUZZLE;
  const cp = colorL ? { w: 5, h: 5, palette: TUT_PAL, cells: Uint8Array.from(TUT_COLOR.join(''), c => (c === 'R' ? 1 : c === 'G' ? 2 : 0)) } : null;
  const board = new Board(rowsOf, 'easy', mega ? { rows: [1], cols: [] } : null, cp);
  const colorRow = (b: Board, y: number, want: string) => [...want].every((c, x) => c === '.' || (b.at(x, y) === FILL && b.colorAt(x, y) === (c === 'R' ? 0 : 1)));
  const row = (b: Board, y: number) => [...Array(b.w)].map((_, x) => b.at(x, y));
  const col = (b: Board, x: number) => [...Array(b.h)].map((_, y) => b.at(x, y));
  const filled = (cells: number[], want: number[]) => want.every(i => cells[i] === FILL);
  const steps: TutStep[] = colorL ? [
    { text: t('tutC1') },
    { text: t('tutC2'), rows: [1], done: b => colorRow(b, 1, 'RRRRR') },
    { text: t('tutC3'), cols: [2], done: b => [1, 2, 3, 4].every(y => b.at(2, y) === FILL && b.colorAt(2, y) === (y < 3 ? 0 : 1)) },
    { text: t('tutC4'), done: b => b.checkSolved() },
    { text: t('tutCEnd') },
  ] : mega ? [
    { text: t('tutM1') },
    { text: t('tutM2'), rows: [1, 2] },
    { text: t('tutM3'), rows: [1, 2], done: b => b.at(0, 1) === FILL && b.at(0, 2) === FILL },
    { text: t('tutM4'), done: b => b.checkSolved() },
    { text: t('tutMEnd') },
  ] : [
    { text: t('tut1') },
    { text: t('tut2'), rows: [0], done: b => filled(row(b, 0), [0, 1, 2, 3, 4]) },
    { text: t('tut3'), rows: [2], cols: [2], done: b => filled(row(b, 2), [0, 1, 2, 3, 4]) && filled(col(b, 2), [0, 1, 2, 3, 4]) },
    { text: t('tut4'), rows: [1], done: b => filled(row(b, 1), [0, 2, 4]) },
    { text: t('tut5'), rows: [4], done: b => [0, 1, 3, 4].every(i => row(b, 4)[i] === CROSS) },
    { text: t('tut6'), done: b => b.checkSolved() },
    { text: t('tutEnd') },
  ];
  let at = 0;
  const canvas = h('canvas', {}) as HTMLCanvasElement;
  const wrap = h('div', { class: 'boardwrap tut-board' }, canvas);
  const textEl = h('p', { class: 'tut-text' });
  const dots = h('div', { class: 'tut-dots' });
  const nextBtn = h('button', { class: 'btn primary', onClick: () => go(at + 1) }, t('tutNext'));
  const toolBtn = h('button', { class: 'rbtn tool-toggle', title: t('fill'), 'aria-label': t('fill'), onClick: () => setTool(view.tool === 'fill' ? 'cross' : 'fill') }, toolSwitchArt());
  const undoBtn = h('button', { class: 'rbtn', title: t('undo'), 'aria-label': t('undo'), onClick: () => { if (board.undo()) view.invalidate(); } }, icon('undo'));
  const leave = () => { ro.disconnect(); view.destroy(); back(); };
  const view: BoardView = new BoardView(canvas, board, {
    onChange: r => { Snd.sfx(r === 'mistake' ? 'mistake' : 'tap'); check(); },
  });
  // colour lesson: the palette
  const palette = cp ? h('div', { class: 'palette' }) : null;
  const drawPalette = () => { if (cp) toolBtn.style.setProperty('--tf', cp.palette[view.color]); palette?.replaceChildren(...cp!.palette.map((c, k) => h('button', {
    class: 'swatch' + (view.color === k && view.tool === 'fill' ? ' on' : ''), style: `--sw:${c}; --ink:${inkOn(c)}`,
    onClick: () => { view.color = k; setTool('fill'); },
  }, h('span', {}, String(board.colorsLeft()[k] || '✓'))))); };
  function setTool(tool: 'fill' | 'cross') {
    view.tool = tool;
    toolBtn.classList.toggle('crossing', tool === 'cross');
    drawPalette();
  }
  function check() {
    drawPalette();
    const st = steps[at];
    if (st.done?.(board)) setTimeout(() => { if (steps[at] === st) { Snd.sfx('clear'); go(at + 1); } }, 350);
  }
  function go(i: number) {
    if (i >= steps.length) { leave(); return; }
    at = i;
    const st = steps[i];
    textEl.textContent = st.text;
    view.focus = st.rows || st.cols ? { rows: st.rows ?? [], cols: st.cols ?? [] } : null;
    view.invalidate();
    dots.replaceChildren(...steps.map((_, k) => h('i', { class: k === i ? 'on' : k < i ? 'past' : '' })));
    const last = i === steps.length - 1;
    nextBtn.style.visibility = st.done && !last ? 'hidden' : ''; // keeps its space: the board doesn't move
    nextBtn.textContent = last ? t('done') : t('tutNext');
    extra.replaceChildren();
    if (last && lesson === 'basic') extra.append(h('button', { class: 'btn', onClick: () => { ro.disconnect(); view.destroy(); tutorialScreen(back, 'mega'); } }, t('tutMegaToo')));
    // after each basic lesson: its techniques
    if (last) extra.append(h('button', { class: 'btn', onClick: () => { ro.disconnect(); view.destroy(); techniqueScreen(back, lesson === 'mega' ? 'megaAdvanced' : lesson === 'color' ? 'colorAdvanced' : 'advanced'); } }, '🧠 ' + techniqueTitle(lesson === 'mega' ? 'megaAdvanced' : lesson === 'color' ? 'colorAdvanced' : 'advanced')));
    check();
  }
  const extra = h('div', { class: 'tut-extra' });
  screen(header(mega ? t('tutorialMega') : colorL ? t('tutorialColor') : t('tutorial'), leave),
    h('div', { class: 'tut' }, h('div', { class: 'tut-card card' }, dots, textEl, h('div', { class: 'row wrap tut-btns' }, nextBtn, extra)),
      wrap, palette, h('nav', { class: 'tools tut-tools' }, toolBtn, h('span', { class: 'gap' }), undoBtn)));
  const ro = new ResizeObserver(() => {
    const w = wrap.clientWidth, hh = wrap.clientHeight; // inside the frame
    if (w !== view.width || hh !== view.height) view.resize(w, hh);
  });
  ro.observe(wrap);
  go(0);
}

/** the first visit (and the first switch to Mega or Colour): offer that tutorial once; afterwards it's in the options */
export async function offerTutorial(lesson: Lesson = 'basic') {
  // asked once per profile (synced with the account, so other devices don't ask again)
  const key = 'momogram.tutorialAsked' + (lesson === 'basic' ? '' : '.' + lesson);
  const asked = settings.tutAsked ?? [];
  if (asked.includes(lesson) || localStorage.getItem(key)) return;
  settings.tutAsked = [...asked, lesson]; saveSettings();
  let yes = false;
  await choose(t(lesson === 'mega' ? 'tutAskMega' : lesson === 'color' ? 'tutAskColor' : 'tutAsk'), [[t('tutYes'), () => { yes = true; }], [t('tutNo'), () => {}]]);
  if (yes) tutorialScreen(home, lesson);
}

// ---------------------------------------------------------------- techniques
// The advanced lessons: one technique per step, each on a line of its own (the column numbers are hidden, so only
// the row's own numbers can be used; the colour lesson's last step looks across on purpose). A step is done when
// every cell the technique makes certain is set; a cell that isn't certain (yet) is taken back.
export type Technique = 'advanced' | 'megaAdvanced' | 'colorAdvanced';
/** sol: the picture ('#', or R / G for colours); pre: what is set already ('#' / R / G filled, 'x' crossed) */
type TechStep = { text: string; sol: string[]; pre: string[]; mega?: boolean; full?: boolean; focus?: number };
const TECH_PAL = ['#e0413a', '#3aa64c'];
const TECH: Record<Technique, Array<Omit<TechStep, 'text'> & { key: string }>> = {
  advanced: [
    { key: 'tA1', sol: ['..#######.'], pre: ['..........'] },
    { key: 'tA2', sol: ['###..####.'], pre: ['..........'] },
    { key: 'tA3', sol: ['###...##..'], pre: ['#.........'] },
    { key: 'tA4', sol: ['...####...'], pre: ['..x#......'] },
    { key: 'tA5', sol: ['.#####....'], pre: ['..#..#....'] },
    { key: 'tA6', sol: ['...###.###'], pre: ['..x...x...'] },
    { key: 'tA7', sol: ['.#....##..'], pre: ['......##..'] },
    { key: 'tA8', sol: ['#.##..'], pre: ['..#...'] },
    { key: 'tA9', sol: ['##.#.###.#'], pre: ['..........'] },
  ],
  megaAdvanced: [
    { key: 'tMA1', sol: ['...#....', '...#....'], pre: ['xxx.xxxx', 'xx..xxxx'], mega: true },
    { key: 'tMA2', sol: ['..##....', '...#....'], pre: ['xx...xxx', 'xxx.xxxx'], mega: true },
    { key: 'tMA3', sol: ['.##.....', '..#.....'], pre: ['...xxxxx', 'x..x....'], mega: true },
    { key: 'tMA4', sol: ['##......', '....###.'], pre: ['##......', '........'], mega: true },
  ],
  colorAdvanced: [
    { key: 'tCA1', sol: ['RRGGG', 'RR.RR'], pre: ['.....', '.....'] },
    { key: 'tCA2', sol: ['RRR..GG'], pre: ['.......'] },
    { key: 'tCA3', sol: ['.GGG.', '..R..', '.GGG.'], pre: ['xGGGx', '.....', 'xGGGx'], full: true, focus: 1 },
  ],
};
const TECH_TITLE: Record<Technique, string> = { advanced: 'techniques', megaAdvanced: 'techniquesMega', colorAdvanced: 'techniquesColor' };
export const techniqueTitle = (k: Technique) => t(TECH_TITLE[k]);
const colorIdx = (c: string) => (c === 'R' ? 0 : c === 'G' ? 1 : -1);

export function techniqueScreen(back: () => void, kind: Technique = 'advanced') {
  themeRoot(null);
  const steps = TECH[kind];
  let at = -1, board!: Board, view: BoardView | null = null, prev = new Uint8Array(0), prevC = new Uint8Array(0);
  let want = new Map<number, [number, number]>();
  const wrap = h('div', { class: 'boardwrap tut-board' });
  const textEl = h('p', { class: 'tut-text' });
  const dots = h('div', { class: 'tut-dots' });
  const palette = h('div', { class: 'palette' });
  const nextBtn = h('button', { class: 'btn primary', onClick: () => go(at + 1) }, t('tutNext'));
  const toolBtn = h('button', { class: 'rbtn tool-toggle', title: t('fill'), 'aria-label': t('fill'), onClick: () => setTool(view?.tool === 'fill' ? 'cross' : 'fill') }, toolSwitchArt());
  let tool: 'fill' | 'cross' = 'fill', color = 0;
  const ro = new ResizeObserver(() => { if (view && (wrap.clientWidth !== view.width || wrap.clientHeight !== view.height)) view.resize(wrap.clientWidth, wrap.clientHeight); });
  const leave = () => { ro.disconnect(); view?.destroy(); back(); };
  function setTool(x: 'fill' | 'cross') { tool = x; if (view) view.tool = x; toolBtn.classList.toggle('crossing', x === 'cross'); drawPalette(); }
  function drawPalette() {
    const cp = board?.color;
    if (!cp) { palette.replaceChildren(); toolBtn.style.removeProperty('--tf'); return; }
    toolBtn.style.setProperty('--tf', cp.palette[color]);
    palette.replaceChildren(...cp.palette.map((c, k) => h('button', { class: 'swatch' + (color === k && tool === 'fill' ? ' on' : ''), style: `--sw:${c}; --ink:${inkOn(c)}`,
      onClick: () => { color = k; if (view) view.color = k; setTool('fill'); } }, h('span', {}, ''))));
  }
  function shake() { Snd.sfx('mistake'); textEl.classList.remove('shake'); void textEl.offsetWidth; textEl.classList.add('shake'); setTimeout(() => textEl.classList.remove('shake'), 600); }
  function changed() {
    if (!view) return;
    let hit = false, miss = false;
    for (let i = 0; i < board.cells.length; i++) {
      if (board.cells[i] === prev[i] && board.colors[i] === prevC[i]) continue;
      const w = want.get(i);
      const ok = !!w && board.cells[i] === w[0] && (w[0] !== FILL || !board.color || board.colors[i] === w[1]);
      if (ok) { hit = true; want.delete(i); } else { board.cells[i] = prev[i]; board.colors[i] = prevC[i]; miss = true; }
    }
    board.touch(); view.invalidate();
    prev = board.cells.slice(); prevC = board.colors.slice();
    if (miss) shake(); else if (hit) Snd.sfx('tap');
    if (hit && !want.size) { const s = at; setTimeout(() => { if (at === s) { Snd.sfx('clear'); nextBtn.style.visibility = ''; textEl.textContent = '✓ ' + t(steps[at].key); } }, 250); }
  }
  function go(i: number) {
    if (i >= steps.length) {
      // the end: what it all comes to, then back
      at = i; view?.destroy(); view = null; wrap.replaceChildren(); palette.replaceChildren();
      textEl.textContent = t(steps[0].key.replace(/\d+$/, 'End'));
      dots.replaceChildren(...steps.map(() => h('i', { class: 'past' })));
      nextBtn.textContent = t('done'); nextBtn.onclick = leave; nextBtn.style.visibility = '';
      return;
    }
    at = i;
    const st = steps[i];
    const isColor = st.sol.some(r => /[A-Z]/.test(r));
    const rows = st.sol.map(r => r.replace(/[A-Z#]/g, '#'));
    const w = rows[0].length, hh = rows.length;
    const cp = isColor ? { w, h: hh, palette: TECH_PAL, cells: Uint8Array.from(st.sol.join(''), c => colorIdx(c) + 1) } : null;
    board = new Board(rows, 'free', st.mega ? { rows: [0], cols: [] } : null, cp);
    [...st.pre.join('')].forEach((c, k) => { if (c === 'x') board.cells[k] = CROSS; else if (c !== '.') { board.cells[k] = FILL; board.colors[k] = Math.max(0, colorIdx(c)); } });
    board.touch();
    // what this step asks for: every cell the line(s) make certain now
    want = new Map();
    for (let k = 0; k < w * hh; k++) if (board.cells[k] === 0) { const o = board.optionsAt(k, st.full ? undefined : 'r'); if (o.length === 1) want.set(k, o[0]); }
    prev = board.cells.slice(); prevC = board.colors.slice();
    textEl.textContent = t(st.key);
    dots.replaceChildren(...steps.map((_, k) => h('i', { class: k === i ? 'on' : k < i ? 'past' : '' })));
    nextBtn.style.visibility = 'hidden'; nextBtn.textContent = t('tutNext');
    view?.destroy();
    const canvas = h('canvas', {}) as HTMLCanvasElement;
    wrap.replaceChildren(canvas);
    view = new BoardView(canvas, board, { onChange: () => changed() });
    view.rowsOnly = !st.full;
    if (/[?&]debug/.test(location.search)) (window as any).__tech = { board, want, view };
    view.focus = st.focus !== undefined ? { rows: [st.focus], cols: [] } : null;
    view.tool = tool; color = 0; view.color = 0;
    drawPalette();
    view.resize(wrap.clientWidth, wrap.clientHeight);
  }
  screen(header(techniqueTitle(kind), leave),
    h('div', { class: 'tut technique' }, h('div', { class: 'tut-card card' }, dots, textEl, h('div', { class: 'row wrap tut-btns' }, nextBtn)),
      wrap, palette, h('nav', { class: 'tools tut-tools' }, toolBtn)));
  ro.observe(wrap);
  setTool('fill');
  requestAnimationFrame(() => go(0));
}
