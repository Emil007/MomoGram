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
  board: { bg: string; grid: string; grid5: string; cell: string; fill: string; cross: string; clueBg: string; clueBgAlt: string; clue: string; clueDone: string };
}

/** full set of colours for the screens and the board, from a pack palette */
export function themeColors(p: NonNullable<PackTheme['palette']>): ThemeColors {
  if (p.style === 'dmg') {
    // the four shades of the original Game Boy screen
    const c0 = p.cell ?? '#c4cfa1', c1 = '#8b956d', c2 = p.grid ?? '#4d533c', c3 = p.fill ?? '#1f1f1f';
    return {
      accent: '#4d533c', accentDark: '#2c3024', bg: '#d7deb8', panel: '#eef2dc', top: '#b5c08e', topLine: '#4d533c',
      board: { bg: '#d7deb8', grid: c1, grid5: c2, cell: c0, fill: c3, cross: c2, clueBg: '#b5c08e', clueBgAlt: '#a7b282', clue: c3, clueDone: c1 },
    };
  }
  const [h, s] = hexToHsl(p.accent);
  const sat = Math.min(0.65, Math.max(0.35, s));
  return {
    accent: hsl(h, sat, 0.38), accentDark: hsl(h, sat, 0.26), bg: hsl(h, sat * 0.6, 0.91), panel: hsl(h, sat * 0.4, 0.97),
    top: hsl(h, sat * 0.7, 0.8), topLine: hsl(h, sat, 0.38),
    board: {
      bg: hsl(h, sat * 0.5, 0.94), grid: hsl(h, sat * 0.4, 0.74), grid5: hsl(h, sat, 0.36), cell: p.cell ?? '#ffffff',
      fill: p.fill ?? hsl(h, sat * 0.8, 0.24), cross: hsl(h, sat * 0.25, 0.55),
      clueBg: hsl(h, sat * 0.55, 0.87), clueBgAlt: hsl(h, sat * 0.55, 0.82), clue: hsl(h, sat * 0.6, 0.16), clueDone: hsl(h, sat * 0.3, 0.68),
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
