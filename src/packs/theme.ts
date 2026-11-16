// Pack colours: pick an accent from the original game's own colours and derive a full, readable palette from it.
import type { PackTheme } from './format';

type RGB = [number, number, number];

function rgb2hsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
export function hsl(h: number, s: number, l: number): string {
  const f = (n: number) => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
}
/** lighten (+) or darken (−) a hex colour */
export function shade(hex: string, amount: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hsl(h, s, Math.max(0, Math.min(1, l + amount)));
}
export function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return rgb2hsl([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
}

/** most common saturated hue (weighted by saturation), as a mid-dark accent colour */
export function accentFromColors(px: RGB[]): string | null {
  const bins = new Float64Array(36);
  for (const p of px) {
    const [h, s, l] = rgb2hsl(p);
    if (s < 0.3 || l < 0.15 || l > 0.9) continue;
    bins[Math.floor(h / 10) % 36] += s * (1 - Math.abs(l - 0.5));
  }
  let best = -1, bv = 0;
  for (let i = 0; i < 36; i++) { const v = bins[i] + 0.5 * (bins[(i + 35) % 36] + bins[(i + 1) % 36]); if (v > bv) { bv = v; best = i; } }
  if (best < 0 || bv < 20) return null;
  let hue = best * 10 + 5;
  if (hue > 42 && hue < 75) hue = 38; // pure yellow turns olive when darkened: use gold instead
  return hsl(hue, 0.55, 0.38);
}

export interface ThemeColors {
  accent: string; accentDark: string; bg: string; panel: string; top: string; topLine: string;
  board: { bg: string; grid: string; grid5: string; cell: string; cellDither: string; fill: string; fillDither: string; cross: string; clueBg: string; clueBgAlt: string; clue: string; clueDone: string; outline: string; cursor?: string; hl?: string; hint?: string };
}

/** full set of colours for the screens and the board, from a pack palette */
export function themeColors(p: NonNullable<PackTheme['palette']>): ThemeColors {
  if (p.style === 'dmg') {
    // the four shades of the original Game Boy screen
    const c0 = p.cell ?? '#c4cfa1', c1 = '#8b956d', c2 = p.grid ?? '#4d533c', c3 = p.fill ?? '#1f1f1f';
    return {
      accent: '#4d533c', accentDark: '#2c3024', bg: '#d7deb8', panel: '#eef2dc', top: '#b5c08e', topLine: '#4d533c',
      board: { bg: '#e3e9c8', grid: c1, grid5: c2, cell: c0, cellDither: '#b9c595', fill: c3, fillDither: '#33372a', cross: c2, clueBg: '#b5c08e', clueBgAlt: '#b5c08e', clue: c3, clueDone: c1, outline: c3 },
    };
  }
  if (p.style === 'gbc' && p.cell && p.fill && p.grid) {
    // four colours of a Super Game Boy / Game Boy Color palette: lightest, two mid tones (grid and the most
    // saturated one, the accent), darkest; used like the four shades of the dmg look
    const [c1, c2] = hexToHsl(p.grid)[2] >= hexToHsl(p.accent)[2] ? [p.grid, p.accent] : [p.accent, p.grid];
    const c0 = p.cell, c3 = p.fill;
    return {
      accent: shade(p.accent, -0.05), accentDark: shade(p.accent, -0.18), bg: shade(c0, -0.06), panel: shade(c0, 0.03), top: shade(c1, 0.12), topLine: c2,
      board: { bg: shade(c0, -0.03), grid: c1, grid5: c2, cell: c0, cellDither: shade(c0, -0.06), fill: c3, fillDither: shade(c3, 0.06), cross: c2, clueBg: shade(c1, 0.12), clueBgAlt: shade(c1, 0.12), clue: c3, clueDone: c1, outline: c3 },
    };
  }
  const [h, s] = hexToHsl(p.accent);
  const sat = Math.min(0.65, Math.max(0.35, s));
  return {
    accent: hsl(h, sat, 0.38), accentDark: hsl(h, sat, 0.26), bg: hsl(h, sat * 0.6, 0.91), panel: hsl(h, sat * 0.4, 0.97),
    top: hsl(h, sat * 0.7, 0.8), topLine: hsl(h, sat, 0.38),
    // same structure as MomoGram's own look, in the game's hue
    board: {
      bg: '#ffffff', grid: hsl(h, 0.6, 0.78), grid5: '#f39a2c', cell: p.cell ?? hsl(h, 0.8, 0.93), cellDither: hsl(h, 0.75, 0.89),
      fill: p.fill ?? hsl(h, 0.65, 0.42), fillDither: hsl(h, 0.65, 0.37), cross: hsl(h, 0.55, 0.68),
      clueBg: hsl(h, 0.75, 0.84), clueBgAlt: hsl(h, 0.75, 0.84), clue: p.clue ?? '#1d2a36', clueDone: hsl(h, 0.15, 0.75), outline: '#1a1a1a',
      // colours read from the game's own board textures, where it has them
      ...(p.cross ? { cross: p.cross } : {}),
      ...(p.cursor ? { cursor: shade(p.cursor, -0.15), hl: p.cursor + '66' } : {}),
      ...(p.hint ? { hint: p.hint } : {}),
      ...(p.cell ? { cellDither: shade(p.cell, -0.04) } : {}),
      ...(p.fill ? { fillDither: shade(p.fill, -0.08) } : {}),
    },
  };
}

/** apply to the document (CSS variables used by the screens); null resets to MomoGram's own colours */
export function applyThemeCss(el: HTMLElement, c: ThemeColors | null) {
  const vars: Record<string, string> = c ? {
    '--accent': c.accent, '--accent-dark': c.accentDark, '--bg': c.bg, '--panel': c.panel, '--top': c.top, '--top-line': c.topLine,
    '--board-bg': c.board.bg,
  } : {};
  for (const k of ['--accent', '--accent-dark', '--bg', '--panel', '--top', '--top-line', '--board-bg']) {
    if (vars[k]) el.style.setProperty(k, vars[k]); else el.style.removeProperty(k);
  }
  el.classList.toggle('themed', !!c);
}
