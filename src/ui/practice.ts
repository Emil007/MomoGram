// Practice: little games with random puzzles from the player's games, in the mode that is on.
import { Audio as Snd } from '../audio';
import { Board, CROSS, EMPTY, FILL, formatTime } from '../game/board';
import { colorOf, inkOn } from '../game/color';
import { BoardView } from '../game/view';
import { t } from '../i18n';
import { PackPuzzle } from '../packs/format';
import { STARTER } from '../packs/starter';
import { activeProfile } from '../store';
import { message } from './dialog';
import { libPrefs } from './library';
import { icon } from './icons';
import { COLOR, MEGA, ctx, colorOfPz, colorView, curMode, fromText, h, header, home,  megaPairsOf, megaView, plainView, screen, themeRoot, toolSwitchArt } from '../app';

// ---------------------------------------------------------------- practice
// Small games with random puzzles from your own games, in the mode that is on (Normal, Mega or Color). Nothing here
// counts as solving the puzzle: no progress, medals, points or PixElo; only each game's best result is kept (per
// profile and mode, on this device).
type PracticeGame = 'errors' | 'finish' | 'sprint' | 'spot' | 'line' | 'memory';
const PRACTICE_GAMES: Array<{ id: PracticeGame; icon: string; higher?: boolean }> = [
  { id: 'errors', icon: '🔍' }, { id: 'finish', icon: '🧩' }, { id: 'sprint', icon: '⏱', higher: true },
  { id: 'spot', icon: '🎯' }, { id: 'line', icon: '📏' }, { id: 'memory', icon: '🧠' },
];
const practiceKey = () => 'momogram.practice.' + activeProfile().id;
const practiceSlot = (g: PracticeGame) => (curMode() === 'normal' ? g : g + '@' + curMode());
function practiceBest(): Record<string, number> { try { return JSON.parse(localStorage.getItem(practiceKey()) || '{}'); } catch { return {}; } }
/** keeps the result when it beats the best one (of this mode); true when it does */
function practiceRecord(g: PracticeGame, score: number): boolean {
  const b = practiceBest(), higher = PRACTICE_GAMES.find(x => x.id === g)!.higher, k = practiceSlot(g);
  const old = b[k];
  if (old !== undefined && (higher ? score <= old : score >= old)) return false;
  b[k] = score;
  try { localStorage.setItem(practiceKey(), JSON.stringify(b)); } catch { /* full */ }
  return true;
}
const practiceScoreText = (g: PracticeGame, v: number) => (g === 'sprint' ? t('pSolvedN', { n: v }) : formatTime(v));

export function practiceScreen(back: () => void = home) {
  themeRoot(null);
  const best = practiceBest();
  const m = curMode();
  screen(header(t('practice') + (m === 'normal' ? '' : ' · ' + t(m === 'mega' ? 'megaOn' : 'colorOn')), back),
    h('div', { class: 'practice-list' },
      h('p', { class: 'fine' }, t('practiceHelp')),
      ...PRACTICE_GAMES.map(g => {
        const b = best[practiceSlot(g.id)];
        // finding puzzles that fit can take a moment (Mega, big libraries): the button shows it is working
        return h('button', { class: 'btn practice-game', onClick: (ev: Event) => { (ev.currentTarget as HTMLElement).classList.add('busy'); setTimeout(() => practiceRun(g.id, () => practiceScreen(back)), 30); } },
          h('span', { class: 'pg-icon', 'aria-hidden': 'true' }, g.icon),
          h('span', { class: 'pg-text' }, h('b', {}, t('p_' + g.id)), h('small', {}, t('p_' + g.id + 'Help'))),
          b !== undefined ? h('em', { class: 'pg-best' }, '★ ' + practiceScoreText(g.id, b)) : null);
      })));
}

/** a board for a puzzle in the mode it comes from (its id says: "@mega", "@color" or neither) */
const practiceBoard = (pz: PackPuzzle, rules: 'easy' | 'free') => new Board(pz.rows, rules, megaPairsOf(pz), colorOfPz(pz));
type Step = [number, number, number]; // cell, FILL or CROSS, colour
/**
 * Solve with line logic (each line on its own, Mega pairs and colours included): the passes, each one the cells
 * the lines decide at that moment; null when line logic gets stuck.
 */
function practiceSolve(pz: PackPuzzle): Step[][] | null {
  const b = practiceBoard(pz, 'free'), w = b.w, n = w * b.h;
  const dr = new Uint8Array(b.h).fill(1), dc = new Uint8Array(w).fill(1);
  const passes: Step[][] = [];
  for (let guard = 0; guard < 300; guard++) {
    const pass: Step[] = [];
    for (let i = 0; i < n; i++) {
      if (b.cells[i] !== EMPTY || !(dr[(i / w) | 0] || dc[i % w])) continue;
      const o = b.optionsAt(i);
      if (!o.length) return null;
      if (o.length === 1) pass.push([i, o[0][0], o[0][1]]);
    }
    dr.fill(0); dc.fill(0);
    if (!pass.length) break;
    for (const [i, v, c] of pass) {
      b.cells[i] = v; b.colors[i] = c;
      const x = i % w, y = (i / w) | 0;
      // a Mega pair reaches the next line too
      for (let d = -1; d <= 1; d++) { if (y + d >= 0 && y + d < b.h) dr[y + d] = 1; if (x + d >= 0 && x + d < w) dc[x + d] = 1; }
    }
    b.touch();
    passes.push(pass);
  }
  return b.cells.includes(EMPTY) ? null : passes;
}

/** random puzzles of the shown games in the current mode, within a size range, solvable by line logic */
function practicePuzzles(n: number, min: number, max: number): Array<{ pz: PackPuzzle; passes: Step[][]; from: string }> {
  const pr = libPrefs(), m = curMode();
  const pool: Array<{ pz: PackPuzzle; from: string }> = [];
  for (const raw of [STARTER, ...ctx.packs].filter(p => !pr.hidden.includes(p.id))) {
    const p = m === 'mega' ? megaView(raw) : m === 'color' ? colorView(raw) : plainView(raw);
    for (const lv of p.levels) for (const z of lv.puzzles)
      if (z.width >= min && z.height >= min && z.width <= max && z.height <= max && z.rows.some(r => r.includes('#'))) pool.push({ pz: z, from: fromText({ pack: p, lv }) });
  }
  const out: Array<{ pz: PackPuzzle; passes: Step[][]; from: string }> = [], seen = new Set<string>();
  const t0 = performance.now();
  for (let tries = 0; tries < 200 && out.length < n && pool.length && performance.now() - t0 < 4000; tries++) {
    const k = Math.floor(Math.random() * pool.length), e = pool[k];
    pool.splice(k, 1);
    const key = e.pz.rows.join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    const passes = practiceSolve(e.pz);
    if (passes) out.push({ ...e, passes });
  }
  return out;
}

/** a random 5×5 puzzle in the current mode that line logic alone solves (for the sprint) */
const SPRINT_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00', '#202020'];
let sprintN = 0;
function sprintPuzzle(): { pz: PackPuzzle; passes: Step[][]; from: string } {
  const m = curMode();
  for (;;) {
    const d = 0.45 + Math.random() * 0.25;
    const k = m === 'color' ? 2 + Math.floor(Math.random() * 2) : 1;
    const grid = [...Array(5)].map(() => [...Array(5)].map(() => (Math.random() < d ? 1 + Math.floor(Math.random() * k) : 0)));
    const rows = grid.map(r => r.map(v => (v ? '#' : '.')).join(''));
    if (!rows.some(r => r.includes('#'))) continue;
    const pal = [...SPRINT_COLORS].sort(() => Math.random() - 0.5).slice(0, k);
    const pz: PackPuzzle = { id: 'sprint' + (sprintN++) + (m === 'mega' ? MEGA : m === 'color' ? COLOR : ''), width: 5, height: 5, rows,
      ...(m === 'color' ? { color: { palette: pal, rows: grid.map(r => r.map(v => (v ? String(v - 1) : '.')).join('')) } } : {}) } as PackPuzzle;
    if (m === 'color' && !colorOf(pz)) continue;
    const passes = practiceSolve(pz);
    if (passes) return { pz, passes, from: '' };
  }
}

function practiceRun(game: PracticeGame, back: () => void) {
  const ROUNDS = 5;
  const sizes: Record<PracticeGame, [number, number]> = { errors: [5, 15], finish: [10, 20], sprint: [5, 5], spot: [10, 15], line: [10, 20], memory: [5, 10] };
  const list = game === 'sprint' ? [] : practicePuzzles(ROUNDS, ...sizes[game]);
  if (game !== 'sprint' && !list.length) { message(t('pNoPuzzles')); return; }
  const rounds = game === 'sprint' ? Infinity : list.length;
  const SPRINT_MS = 60_000;
  let round = 0, penalty = 0, solvedN = 0, board!: Board, view: BoardView | null = null, prev = new Uint8Array(0), prevC = new Uint8Array(0), left = 0;
  let wanted = new Map<number, [number, number]>(), lineOnly: { kind: 'r' | 'c'; k: number } | null = null, peeking = false;
  const t0 = performance.now();
  const elapsed = () => performance.now() - t0 + penalty;
  const timeEl = h('b', { class: 'p-time' }, '00:00');
  const roundEl = h('span', { class: 'p-round' });
  const taskEl = h('p', { class: 'tut-text p-task' });
  const fromEl = h('small', { class: 'p-from' });
  const wrap = h('div', { class: 'boardwrap tut-board' });
  const palette = h('div', { class: 'palette' });
  const toolBtn = h('button', { class: 'rbtn tool-toggle', title: t('fill'), 'aria-label': t('fill'), onClick: () => setTool(view?.tool === 'fill' ? 'cross' : 'fill') }, toolSwitchArt());
  let tool: 'fill' | 'cross' = 'fill', color = 0;
  function setTool(x: 'fill' | 'cross') { tool = x; if (view) view.tool = x; toolBtn.classList.toggle('crossing', x === 'cross'); drawPalette(); }
  function drawPalette() {
    const cp = board?.color;
    if (!cp) { palette.replaceChildren(); toolBtn.style.removeProperty('--tf'); return; }
    toolBtn.style.setProperty('--tf', cp.palette[color]);
    palette.replaceChildren(...cp.palette.map((c, k) => h('button', { class: 'swatch' + (color === k && tool === 'fill' ? ' on' : ''), style: `--sw:${c}; --ink:${inkOn(c)}`,
      onClick: () => { color = k; if (view) view.color = k; setTool('fill'); } }, h('span', {}, ''))));
  }
  const tick = setInterval(() => {
    // left some other way than the back button: stop the clock (a sprint mustn't end on another screen)
    if (!wrap.isConnected && round > 0) { stop(); return; }
    if (game === 'sprint') {
      const rest = SPRINT_MS - elapsed();
      timeEl.textContent = formatTime(Math.max(0, rest));
      if (rest <= 0) finish();
    } else timeEl.textContent = formatTime(elapsed());
  }, 200);
  const ro = new ResizeObserver(() => { if (view && (wrap.clientWidth !== view.width || wrap.clientHeight !== view.height)) view.resize(wrap.clientWidth, wrap.clientHeight); });
  let over = false;
  const stop = () => { over = true; clearInterval(tick); ro.disconnect(); view?.destroy(); view = null; };
  const leave = () => { stop(); back(); };
  const wrong = () => { penalty += game === 'sprint' ? 5000 : 10_000; Snd.sfx('mistake'); taskEl.classList.remove('shake'); void taskEl.offsetWidth; taskEl.classList.add('shake'); };
  const apply = (b: Board, steps: Step[]) => { for (const [i, v, c] of steps) { b.cells[i] = v; b.colors[i] = c; } };

  function nextRound() {
    if (over) return;
    if (round >= rounds) { finish(); return; }
    round++;
    const e = game === 'sprint' ? sprintPuzzle() : list[round - 1];
    board = practiceBoard(e.pz, game === 'finish' || game === 'sprint' || game === 'memory' ? 'easy' : 'free');
    const n = board.w * board.h, all = e.passes.flat();
    const sol = new Map(all.map(([i, v, c]) => [i, [v, c] as [number, number]]));
    wanted = new Map(); lineOnly = null; let focus: BoardView['focus'] = null;
    if (game === 'errors') {
      // the whole picture, with a few cells wrong (each in its own row and column, so none hides another)
      board.hideDone = true;
      apply(board, all);
      const k = Math.min(1 + Math.floor(Math.random() * 3), Math.min(board.w, board.h));
      const rowsUsed = new Set<number>(), colsUsed = new Set<number>(), pairs = board.color?.palette.length ?? 1;
      for (let tries = 0; wanted.size < k && tries < 500; tries++) {
        const i = Math.floor(Math.random() * n), x = i % board.w, y = Math.floor(i / board.w);
        if (rowsUsed.has(y) || colsUsed.has(x)) continue;
        rowsUsed.add(y); colsUsed.add(x);
        const [v, c] = sol.get(i)!;
        wanted.set(i, [v, c]);
        // a filled cell becomes a ✕ or (colour) another colour; a ✕ becomes filled
        if (v === FILL && pairs > 1 && Math.random() < 0.5) board.colors[i] = (c + 1 + Math.floor(Math.random() * (pairs - 1))) % pairs;
        else if (v === FILL) { board.cells[i] = CROSS; board.colors[i] = 0; }
        else { board.cells[i] = FILL; board.colors[i] = Math.floor(Math.random() * pairs); }
      }
      left = wanted.size;
    } else if (game === 'finish') {
      const goal = n * (0.75 + Math.random() * 0.1);
      let done = 0;
      for (const p of e.passes) { if (done + p.length > goal && done) { apply(board, p.slice(0, Math.max(0, Math.floor(goal - done)))); break; } apply(board, p); done += p.length; }
    } else if (game === 'spot' || game === 'line') {
      // a moment in the middle of the solve; The next step: the one with the fewest cells to find
      const mid = e.passes.map((p, k) => k).filter(k => k >= e.passes.length * 0.25 && k <= e.passes.length * 0.8);
      const ks = mid.length ? mid : [Math.floor(e.passes.length / 2)];
      let at = ks[Math.floor(Math.random() * ks.length)];
      if (game === 'spot') { const least = Math.min(...ks.map(k => e.passes[k].length)); const c = ks.filter(k => e.passes[k].length === least); at = c[Math.floor(Math.random() * c.length)]; }
      for (let k = 0; k < at; k++) apply(board, e.passes[k]);
      board.touch();
      if (game === 'spot') for (const [i, v, c] of e.passes[at]) wanted.set(i, [v, c]);
      else {
        // One line: a row or column whose own clue decides at least two of its cells now
        const cands: Array<{ kind: 'r' | 'c'; k: number; cells: Map<number, [number, number]> }> = [];
        for (const kind of ['r', 'c'] as const) for (let k = 0; k < (kind === 'r' ? board.h : board.w); k++) {
          const cells = new Map<number, [number, number]>();
          for (let j = 0; j < (kind === 'r' ? board.w : board.h); j++) {
            const i = kind === 'r' ? k * board.w + j : j * board.w + k;
            if (board.cells[i] !== EMPTY) continue;
            const o = board.optionsAt(i, kind);
            if (o.length === 1) cells.set(i, o[0]);
          }
          if (cells.size >= 2) cands.push({ kind, k, cells });
        }
        const pick = cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
        if (pick) { lineOnly = { kind: pick.kind, k: pick.k }; wanted = pick.cells; focus = pick.kind === 'r' ? { rows: [pick.k], cols: [] } : { rows: [], cols: [pick.k] }; }
        else for (const [i, v, c] of e.passes[at]) wanted.set(i, [v, c]);
        left = wanted.size;
      }
    } else if (game === 'memory') {
      apply(board, all.filter(([, v]) => v === FILL));
      peeking = true;
      let s = 3;
      const count = () => { if (over) return; taskEl.textContent = t('p_memoryLook', { n: s }); if (s-- > 0) setTimeout(count, 1000); else { board.cells.fill(EMPTY); board.colors.fill(0); board.touch(); view?.invalidate(); peeking = false; taskEl.textContent = t('p_memoryTask'); prev = board.cells.slice(); prevC = board.colors.slice(); } };
      setTimeout(count, 0);
    }
    board.touch();
    prev = board.cells.slice(); prevC = board.colors.slice();
    roundEl.textContent = game === 'sprint' ? t('pSolvedN', { n: solvedN }) : t('pRound', { a: round, b: rounds });
    fromEl.textContent = e.from;
    if (game !== 'memory') taskEl.textContent = game === 'errors' ? t('p_errorsTask', { n: left }) : game === 'line' ? t('p_lineTask', { n: left }) : t('p_' + game + 'Task');
    view?.destroy();
    const canvas = h('canvas', {}) as HTMLCanvasElement;
    wrap.replaceChildren(canvas);
    view = new BoardView(canvas, board, { onChange: r => changed(r) });
    if (/[?&]debug/.test(location.search)) (window as any).__practice = { board, wanted, view };
    view.tool = tool; color = 0; view.color = 0; view.focus = focus;
    drawPalette();
    view.resize(wrap.clientWidth, wrap.clientHeight);
  }

  function changed(r: string) {
    if (!view || over) return;
    if (peeking) { board.cells.set(prev); board.colors.set(prevC); board.touch(); view.invalidate(); return; }
    if (game === 'finish' || game === 'sprint' || game === 'memory') {
      if (r === 'mistake') wrong(); else Snd.sfx('tap');
      if (board.checkSolved()) { solvedN++; Snd.sfx('clear'); setTimeout(nextRound, game === 'sprint' ? 250 : 700); }
      prev = board.cells.slice(); prevC = board.colors.slice();
      return;
    }
    // the other games: look at what the tap changed
    let hit = false, miss = false;
    for (let i = 0; i < board.cells.length; i++) {
      if (board.cells[i] === prev[i] && board.colors[i] === prevC[i]) continue;
      const want = wanted.get(i);
      const inLine = !lineOnly || (lineOnly.kind === 'r' ? ((i / board.w) | 0) === lineOnly.k : i % board.w === lineOnly.k);
      const ok = want !== undefined && (game === 'errors' || (board.cells[i] === want[0] && (want[0] !== FILL || !board.color || board.colors[i] === want[1])));
      if (ok) { board.cells[i] = want![0]; board.colors[i] = want![1]; wanted.delete(i); hit = true; left--; }
      else { board.cells[i] = prev[i]; board.colors[i] = prevC[i]; if (inLine) miss = true; }
    }
    board.touch(); view.invalidate();
    prev = board.cells.slice(); prevC = board.colors.slice();
    if (miss) wrong(); else if (hit) Snd.sfx('tap');
    if (game === 'errors') taskEl.textContent = t('p_errorsTask', { n: left });
    if (game === 'line') taskEl.textContent = t('p_lineTask', { n: left });
    if (hit && (game === 'spot' || !wanted.size)) { Snd.sfx('clear'); solvedN++; setTimeout(nextRound, 600); }
  }

  function finish() {
    if (over) return;
    const score = game === 'sprint' ? solvedN : Math.round(elapsed());
    stop();
    const isNew = (game !== 'sprint' || score > 0) && practiceRecord(game, score);
    const best = practiceBest()[practiceSlot(game)];
    if (isNew) Snd.sfx('clear');
    screen(header(t('p_' + game), back), h('div', { class: 'solved practice-done' },
      h('div', { class: 'stamp' }, isNew ? t('pNewBest') : t('pDone')),
      h('div', { class: 'result' },
        h('div', {}, game === 'sprint' ? t('pSolved') : t('time'), h('b', {}, practiceScoreText(game, score))),
        game !== 'sprint' && penalty ? h('div', {}, t('penalty'), h('b', {}, '+' + formatTime(penalty))) : null,
        best !== undefined ? h('div', {}, t('best'), h('b', {}, practiceScoreText(game, best))) : null),
      h('div', { class: 'row' }, h('button', { class: 'btn', onClick: back }, t('back')),
        h('button', { class: 'btn primary', onClick: () => practiceRun(game, back) }, t('pAgain')))));
  }

  themeRoot(null);
  screen(header(t('p_' + game), leave),
    h('div', { class: 'tut practice' },
      h('div', { class: 'tut-card card' }, h('div', { class: 'p-head' }, roundEl, timeEl), taskEl, fromEl),
      wrap, palette, h('nav', { class: 'tools tut-tools' }, toolBtn, h('span', { class: 'gap' }),
        game === 'finish' || game === 'sprint' || game === 'memory' ? h('button', { class: 'rbtn', title: t('undo'), 'aria-label': t('undo'), onClick: () => { if (board.undo()) { view?.invalidate(); prev = board.cells.slice(); prevC = board.colors.slice(); } } }, icon('undo')) : null)));
  ro.observe(wrap);
  setTool('fill');
  requestAnimationFrame(() => nextRound());
}
