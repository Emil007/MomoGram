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
