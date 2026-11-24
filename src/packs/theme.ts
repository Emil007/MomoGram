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
  board: { bg: string; grid: string; grid5: string; cell: string; cellDither: string; fill: string; fillDither: string; cross: string; clueBg: string; clueBgAlt: string; clue: string; clueDone: string; outline: string; cursor?: string; hl?: string; hint?: string } & Partial<BoardShape>;
}

/** the shape settings of a skin (see Theme in game/view.ts) */
export interface BoardShape {
  clueBands: 'fade' | 'stripes' | 'flat'; clueArea: string; clueAreaAlt: string; clueFocusBg: string; crossWidth: number; crossCap: CanvasLineCap;
  crossMargin: number; grid5Width: number; cursorBox: string; clueFont: string; mark: string; mistake: string; trialFill: string;
  cellStyle: 'dither' | 'solid' | 'bevel'; fillStyle: 'dither' | 'solid' | 'inset' | 'bevel' | 'gloss'; cellBevel: [string, string]; fillBevel: [string, string];
}

function parseHex(c: string): RGB | null {
  const m = c.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function relLum([r, g, b]: RGB) {
  const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastOf(a: RGB, b: RGB) {
  const x = relLum(a), y = relLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** an error colour that stays readable on this board (a red theme must not hide red mistakes) */
function standOut(against: string[], current: string): string {
  const bgs = against.map(parseHex).filter((c): c is RGB => !!c);
  if (!bgs.length) return current;
  const score = (hex: string) => { const c = parseHex(hex); return c ? Math.min(...bgs.map(b => contrastOf(c, b))) : 0; };
  if (score(current) >= 3) return current;
  const cands = ['#00c8f0', '#ffe14a', '#3ddc6a', '#ffffff', '#111111', '#6aa2ff', '#ff5ad8'];
  return cands.reduce((best, c) => score(c) > score(best) ? c : best);
}

/** a skin, then the game's exact values over it */
function finish(c: ThemeColors, p: NonNullable<PackTheme['palette']>): ThemeColors {
  if (p.board) Object.assign(c.board, p.board);
  if (p.screen) { if (p.screen.bg) c.bg = p.screen.bg; if (p.screen.panel) c.panel = p.screen.panel; if (p.screen.top) c.top = p.screen.top; }
  const b = c.board;
  b.mistake = standOut([b.fill, b.cell, b.cross, b.bg], b.mistake ?? '#e03030');
  return c;
}

/** full set of colours for the screens and the board, from a pack palette */
export function themeColors(p: NonNullable<PackTheme['palette']>): ThemeColors {
  return finish(skinColors(p), p);
}

/** the Game Boy games' board: full stripes behind the clues, filled cells as inset squares, small crosses */
const GB = { clueBands: 'stripes' as const, cellStyle: 'solid' as const, fillStyle: 'inset' as const, crossWidth: 0.09, crossCap: 'butt' as const, crossMargin: 0.3, grid5Width: 0.09, clueFont: '800', hl: 'rgba(0, 0, 0, 0.12)' };

function skinColors(p: NonNullable<PackTheme['palette']>): ThemeColors {
  const plain = { cellStyle: 'solid' as const, fillStyle: 'solid' as const };
  if (p.style === 'switch') {
    // the Switch games' design: white board, flat clue areas, solid dark cells, orange crosses, green guide lines
    // every 5 cells; the colours come from the game's own colour table (IdxRes_PuzzleColorDef)
    // (colours checked against screenshots: light grey cells and clue lines in two shades, a blue bar for the
    // cursor's line in the clues, a cyan cursor box; filled cells dark, or blue in PICROSS S and S2)
    const fill = p.fill ?? '#333333', grid5 = p.grid5 ?? '#00e626';
    return {
      accent: p.accent, accentDark: shade(p.accent, -0.12), bg: '#eef1f2', panel: '#fafbfb', top: '#ffffff', topLine: '#333333',
      board: {
        ...plain, bg: '#ffffff', grid: p.grid ?? '#606060', grid5, cell: '#ececec', cellDither: '#ececec', fill, fillDither: fill, cross: p.cross ?? '#ff7f00',
        clueBg: '#f8f8f8', clueBgAlt: '#efefef', clue: '#303030', clueDone: '#a0a0a0', outline: '#606060',
        cursor: '#303030', hint: '#0085eb', hl: 'rgba(0, 0, 0, 0)',
        clueBands: 'flat', clueArea: '#f8f8f8', clueAreaAlt: '#efefef', clueFocusBg: '#2fb6ef', crossWidth: 0.13, crossCap: 'butt', crossMargin: 0.27,
        grid5Width: 0.07, cursorBox: '#2fc4f4', clueFont: '800', mark: p.mark ?? '#808080', mistake: p.mistake ?? '#ff0000', trialFill: '#0085eb',
      },
    };
  }
  if (p.style === '3ds') {
    // the 3DS games' design: light grey cells, solid filled cells in the game's colour, small dark crosses, flat
    // clue lines in two shades, the cursor's line in the game's colour, thin orange guide lines every 5
    const fill = p.fill ?? hsl(hexToHsl(p.accent)[0], 0.85, 0.6), cur = p.cursor ?? fill;
    return {
      accent: p.accent, accentDark: shade(p.accent, -0.12), bg: shade(fill, 0.34), panel: '#fbfbfb', top: '#ffffff', topLine: shade(fill, -0.2),
      board: {
        ...plain, bg: '#ffffff', grid: '#b8b8b8', grid5: p.grid5 ?? '#f0a020', cell: p.cell ?? '#e8e8e8', cellDither: p.cell ?? '#e8e8e8', fill, fillDither: fill,
        cross: p.cross ?? '#505050', clueBg: '#f8f8f8', clueBgAlt: '#ececec', clue: p.clue ?? '#202020', clueDone: '#b0b0b0', outline: '#606060',
        cursor: '#202020', hint: p.hint ?? '#0085ea', hl: 'rgba(0, 0, 0, 0)',
        clueBands: 'flat', clueArea: '#f8f8f8', clueAreaAlt: '#ececec', clueFocusBg: cur + '99', crossWidth: 0.1, crossCap: 'butt', crossMargin: 0.26,
        grid5Width: 0.07, cursorBox: cur, clueFont: '800', mistake: '#e03030', trialFill: '#f0a040',
      },
    };
  }
  if (p.style === 'stone') {
    // a carved stone tablet: sandstone cells with an edge, dark stones,
    // dark stone stripes behind the clues, thin green guide lines, the cursor's line green, a red cursor box
    return {
      accent: '#6a5a30', accentDark: '#4a3e20', bg: '#cfc195', panel: '#efe7c6', top: '#c0b078', topLine: '#504830',
      board: {
        bg: '#c0b078', grid: '#a09058', grid5: '#30c050', cell: '#c8b880', cellDither: '#c8b880', fill: '#686040', fillDither: '#686040',
        cross: '#605030', clueBg: '#807858', clueBgAlt: '#c0b078', clue: '#201808', clueDone: '#8a7c58', outline: '#504830',
        cursor: '#201808', hint: '#1e50c0', hl: 'rgba(0, 0, 0, 0)',
        clueBands: 'stripes', clueArea: '#c0b078', clueFocusBg: '#80c080', cellStyle: 'bevel', fillStyle: 'bevel',
        cellBevel: ['#e8e0a8', '#a09058'], fillBevel: ['#807858', '#403820'],
        crossWidth: 0.1, crossCap: 'butt', crossMargin: 0.22, grid5Width: 0.06, cursorBox: '#e02020', clueFont: '800', mistake: '#e02020', trialFill: '#4060c0',
      },
    };
  }
  if (p.style === 'notebook') {
    // a notebook page: white cells, light blue grid, blue guide lines, maroon filled cells, clue
    // stripes in the volume's colour (accent) and white
    const stripe = p.accent;
    return {
      accent: shade(stripe, -0.25), accentDark: shade(stripe, -0.38), bg: '#efe8d4', panel: '#fbf8ee', top: shade(stripe, 0.12), topLine: '#7a5a3a',
      board: {
        ...plain, bg: '#f8f8f8', grid: '#a8d0e0', grid5: p.grid5 ?? '#3070d0', cell: '#f8f8f8', cellDither: '#f8f8f8', fill: p.fill ?? '#985858', fillDither: '#985858',
        cross: '#606878', clueBg: stripe, clueBgAlt: '#f2f6ee', clue: '#202020', clueDone: '#a8a8a0', outline: '#506070',
        cursor: '#c02020', hint: '#1e50c0', hl: 'rgba(240, 220, 60, 0.35)',
        clueBands: 'stripes', clueArea: '#f2f6ee', crossWidth: 0.09, crossCap: 'butt', crossMargin: 0.24, grid5Width: 0.07, clueFont: '700', trialFill: '#e09030',
      },
    };
  }
  if (p.style === 'ds') {
    // glossy blocks in the game's colour, striped clue bands
    const fill = p.fill ?? '#1f6fd0';
    return {
      accent: p.accent, accentDark: shade(p.accent, -0.12), bg: shade(fill, 0.42), panel: '#fafcff', top: shade(fill, 0.3), topLine: shade(fill, -0.15),
      board: {
        bg: '#ffffff', grid: shade(fill, 0.3), grid5: p.grid5 ?? '#f39a2c', cell: p.cell ?? shade(fill, 0.47), cellDither: shade(p.cell ?? shade(fill, 0.47), -0.03),
        fill, fillDither: shade(fill, -0.1), cross: p.cross ?? shade(fill, 0.1), clueBg: shade(fill, 0.35), clueBgAlt: shade(fill, 0.35),
        clue: '#1d2a36', clueDone: '#a9b7c2', outline: '#1a1a1a', cursor: p.cursor ?? '#f08a10', hint: '#1565e0',
        fillStyle: 'gloss', fillBevel: [shade(fill, 0.22), shade(fill, -0.18)],
      },
    };
  }
  if (p.style === 'logic') {
    // a plain logic-puzzle design: white cells, black filled cells, a light grid, the cursor's lines
    // as coloured beams
    const cur = p.cursor ?? '#f0b020';
    return {
      accent: p.accent, accentDark: shade(p.accent, -0.12), bg: shade(p.accent, 0.45), panel: '#ffffff', top: shade(p.accent, 0.32), topLine: shade(p.accent, -0.2),
      board: {
        ...plain, bg: '#ffffff', grid: p.grid ?? '#b0b0b0', grid5: p.grid5 ?? '#606060', cell: p.cell ?? '#ffffff', cellDither: p.cell ?? '#ffffff',
        fill: p.fill ?? '#202020', fillDither: p.fill ?? '#202020', cross: p.cross ?? '#707070', clueBg: '#ffffff', clueBgAlt: '#f0f0f0',
        clue: '#202020', clueDone: '#b0b0b0', outline: '#404040', cursor: '#d02020', hint: '#1e50c0', hl: cur + '55',
        clueBands: 'flat', clueArea: '#ffffff', clueAreaAlt: '#f2f2f2', clueFocusBg: cur + '88', crossWidth: 0.09, crossCap: 'butt', crossMargin: 0.22,
        grid5Width: 0.08, cursorBox: '#d02020', clueFont: '700', trialFill: '#e09030',
      },
    };
  }
  if (p.style === 'dmg') {
    // the four shades of the original Game Boy screen
    const c0 = p.cell ?? '#c4cfa1', c1 = '#8b956d', c2 = p.grid ?? '#4d533c', c3 = p.fill ?? '#1f1f1f';
    return {
      accent: '#4d533c', accentDark: '#2c3024', bg: '#d7deb8', panel: '#eef2dc', top: '#b5c08e', topLine: '#4d533c',
      board: { ...GB, bg: c0, grid: c1, grid5: c3, cell: c0, cellDither: c0, fill: c3, fillDither: c3, cross: c2, clueBg: c1, clueBgAlt: c0, clueArea: c0, clue: c3, clueDone: c1, outline: c3, cursorBox: c3 },
    };
  }
  if (p.style === 'gbc' && p.cell && p.fill && p.grid) {
    // four colours of a Super Game Boy / Game Boy Color palette: lightest, two mid tones (grid and the most
    // saturated one, the accent), darkest; used like the four shades of the dmg look
    const [c1, c2] = hexToHsl(p.grid)[2] >= hexToHsl(p.accent)[2] ? [p.grid, p.accent] : [p.accent, p.grid];
    const c0 = p.cell, c3 = p.fill;
    return {
      accent: shade(p.accent, -0.05), accentDark: shade(p.accent, -0.18), bg: shade(c0, -0.06), panel: shade(c0, 0.03), top: shade(c1, 0.12), topLine: c2,
      board: { ...GB, bg: c0, grid: c1, grid5: c3, cell: c0, cellDither: c0, fill: c3, fillDither: c3, cross: c2, clueBg: c1, clueBgAlt: c0, clueArea: c0, clue: c3, clueDone: c1, outline: c3, cursorBox: c3 },
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
  // dark mode: the menus stay dark, only the game's accent colour comes along (its board is drawn as it is)
  if (document.body.classList.contains('dark')) for (const k of ['--bg', '--panel', '--top', '--top-line', '--board-bg']) delete vars[k];
  for (const k of ['--accent', '--accent-dark', '--bg', '--panel', '--top', '--top-line', '--board-bg']) {
    if (vars[k]) el.style.setProperty(k, vars[k]); else el.style.removeProperty(k);
  }
  el.classList.toggle('themed', !!c);
}
