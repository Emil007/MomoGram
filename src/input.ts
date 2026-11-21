// Gamepad support (Steam Deck, controllers): menu navigation by focus, and in-game handlers.

interface PlayHandlers {
  move(dx: number, dy: number): void;
  a(down: boolean): void;
  b(down: boolean): void;
  y(): void;
  start(): void;
  l(): void;
  r(): void;
}

let play: PlayHandlers | null = null;
const modals: HTMLElement[] = [];
const prev = new Map<number, boolean[]>();
const repeatAt = new Map<string, number>();
let started = false;

function focusables(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('button:not([disabled]), select, input, [tabindex="0"]')].filter(e => e.offsetParent !== null);
}

function moveFocus(dx: number, dy: number) {
  const scope: ParentNode = modals[modals.length - 1] ?? document;
  const list = focusables(scope);
  if (!list.length) return;
  const cur = document.activeElement as HTMLElement;
  if (!cur || !list.includes(cur)) { list[0].focus(); return; }
  const r = cur.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best: HTMLElement | null = null, bestD = Infinity;
  for (const e of list) {
    if (e === cur) continue;
    const q = e.getBoundingClientRect();
    const ex = q.left + q.width / 2, ey = q.top + q.height / 2;
    const ddx = ex - cx, ddy = ey - cy;
    if (dx && Math.sign(ddx) !== dx) continue;
    if (dy && Math.sign(ddy) !== dy) continue;
    if (dx && Math.abs(ddx) < 4) continue;
    if (dy && Math.abs(ddy) < 4) continue;
    const d = dx ? Math.abs(ddx) + Math.abs(ddy) * 3 : Math.abs(ddy) + Math.abs(ddx) * 3;
    if (d < bestD) { bestD = d; best = e; }
  }
  best?.focus();
  best?.scrollIntoView({ block: 'nearest' });
}

function poll() {
  requestAnimationFrame(poll);
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const now = performance.now();
  for (const p of pads) {
    if (!p) continue;
    const btn = p.buttons.map(b => b.pressed);
    const ax = p.axes;
    // treat stick as d-pad
    btn[12] = btn[12] || (ax[1] ?? 0) < -0.6;
    btn[13] = btn[13] || (ax[1] ?? 0) > 0.6;
    btn[14] = btn[14] || (ax[0] ?? 0) < -0.6;
    btn[15] = btn[15] || (ax[0] ?? 0) > 0.6;
    const old = prev.get(p.index) ?? [];
    const pressed = (i: number) => btn[i] && !old[i];
    const released = (i: number) => !btn[i] && old[i];
    const rep = (i: number) => {
      const k = p.index + ':' + i;
      if (pressed(i)) { repeatAt.set(k, now + 280); return true; }
      if (btn[i] && now >= (repeatAt.get(k) ?? Infinity)) { repeatAt.set(k, now + 70); return true; }
      return false;
    };
    const dirs: Array<[number, number, number]> = [[12, 0, -1], [13, 0, 1], [14, -1, 0], [15, 1, 0]];
    if (play && !modals.length) {
      for (const [i, dx, dy] of dirs) if (rep(i)) play.move(dx, dy);
      // standard mapping: 0 = A (bottom), 1 = B (right), 2 = X (left), 3 = Y (top)
      if (pressed(0)) play.a(true); if (released(0)) play.a(false);
      if (pressed(1) || pressed(2)) play.b(true); if (released(1) || released(2)) play.b(false);
      if (pressed(3)) play.y();
      if (pressed(9)) play.start();
      if (pressed(4)) play.l();
      if (pressed(5)) play.r();
    } else {
      for (const [i, dx, dy] of dirs) if (rep(i)) moveFocus(dx, dy);
      if (pressed(0)) (document.activeElement as HTMLElement)?.click();
      if (pressed(1)) {
        const back = (modals[modals.length - 1] ?? document).querySelector<HTMLElement>('.back, .dialog button:last-child');
        back?.click();
      }
    }
    prev.set(p.index, btn);
  }
}

export const Gamepads = {
  start() { if (!started) { started = true; poll(); } },
  onPlay(h: PlayHandlers): () => void { play = h; return () => { if (play === h) play = null; }; },
  pushModal(el: HTMLElement) { modals.push(el); focusables(el)[0]?.focus(); },
  popModal() { modals.pop(); },
  /**
   * "Back" (Android back button, the browser's back, Esc): closes the top window (as its cancel would), opens
   * the menu while playing, or goes back a screen. False on the home screen: nothing left to go back to.
   */
  back(): boolean {
    const ms = document.querySelectorAll<HTMLElement>('.modal');
    const top = ms[ms.length - 1];
    if (top) { const d = (top as any).dismiss; if (typeof d === 'function') d(); else top.remove(); return true; }
    if (play) { play.start(); return true; }
    const b = document.querySelector<HTMLElement>('.back');
    if (b) { b.click(); return true; }
    return false;
  },
  focusFirst(scope: HTMLElement) {
    // only grab focus when a gamepad/keyboard user is likely (avoids focus rings for touch users)
    if (document.body.classList.contains('kbd')) focusables(scope)[0]?.focus();
  },
};

window.addEventListener('keydown', e => {
  if (e.key.startsWith('Arrow') || e.key === 'Tab') document.body.classList.add('kbd');
  if (!play && e.key.startsWith('Arrow') && !(document.activeElement instanceof HTMLSelectElement) && !(document.activeElement instanceof HTMLInputElement)) {
    const m: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    e.preventDefault();
    moveFocus(...m[e.key]);
  }
  if (e.key === 'Escape' && (!play || document.querySelector('.modal'))) { Gamepads.back(); e.preventDefault(); }
});
window.addEventListener('pointerdown', () => document.body.classList.remove('kbd'));
window.addEventListener('gamepadconnected', () => document.body.classList.add('kbd'));
