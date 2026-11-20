// MomoGram UI: home, level/puzzle selection, play screen, solved screen, packs and options.
import { Board, formatTime, FILL, CROSS } from './game/board';
import { BoardView } from './game/view';
import { PictureAnimator, thumbnail, PckGetter } from './game/picture';
import { Pack, PackLevel, PackPuzzle, Lang, pickText, pickAny } from './packs/format';
import { pckFile, dsFromPack, dsTheme, DsPackMeta } from './rom/picrossds';
import { importGameFile } from './packs/importers/index';
import './packs/importers/all';
import { storage, settings, saveSettings, getProgress, recordClear, getQuickSave, setQuickSave, resetProgress, Medal, makeSave, importSave, isSaveFile, progressSummary, profiles, activeProfile, switchProfile, createProfile, renameProfile, deleteProfile, SaveFile } from './store';
import { t, setLang, lang, LANG_NAMES } from './i18n';
import { Gamepads } from './input';
import { openPackManager, storePacks } from './ui/packs';
import { Audio as Snd } from './audio';
import { unzipFirst, packSave, unpackSave, download } from './util/files';
import { themeColors, applyThemeCss, ThemeColors } from './packs/theme';
import { STARTER } from './packs/starter';
import { icon } from './ui/icons';
import { editorHome } from './ui/editor';
import { textureInspector } from './ui/texinspect';
import { puzzleLevel } from './game/difficulty';

const TIME_LIMIT = 60 * 60_000;

interface Ctx {
  packs: Pack[];
  /** solved-picture animation data per pack (Picross DS), loaded when the pack is opened */
  pcks: Map<string, PckGetter | null>;
}

const ctx: Ctx = { packs: [], pcks: new Map() };
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

// ---------------------------------------------------------------- start

export async function boot() {
  const want = (settings.lang || navigator.language.slice(0, 2)) as Lang;
  setLang(['en', 'de', 'fr', 'it', 'es', 'ja', 'ko'].includes(want) ? want : 'en');
  storage.persist();
  ctx.packs = (await storage.allPacks().catch(() => [])) ?? [];
  // older versions: a stored Picross DS ROM becomes a pack once, then the ROM is removed
  try {
    const rom = await storage.loadRom('picross-ds');
    if (rom) { await addGameFiles([{ name: 'rom.nds', data: rom }]); await storage.deleteRom('picross-ds'); }
  } catch (e) { console.warn(e); }
  // packs from before the music playlists: Picross DS gets its nine in-game styles
  for (const p of ctx.packs as Array<Pack & { ds?: unknown }>) {
    if (p.ds && !p.theme?.tracks) { p.theme = dsTheme(); p.levels = p.levels.map(l => ({ ...l, groupTitle: l.groupTitle ?? (l.group ? DS_GROUPS[l.group] : undefined) })); await storage.savePack(p); }
  }
  // desktop app started with --rom <file> (shortcuts, RecompLauncher): import that game
  if (new URLSearchParams(location.search).has('rom')) {
    try {
      const r = await fetch('/__rom');
      if (r.ok) await addGameFiles([{ name: r.headers.get('content-type')?.includes('zip') ? 'game.zip' : 'game.nds', data: new Uint8Array(await r.arrayBuffer()) }]);
    } catch (e) { console.warn('game from command line', e); }
  }
  home();
}

const DS_GROUPS: Record<string, Pack['title']> = {
  easy: { en: 'Easy', de: 'Leicht', ja: 'かんたん' }, normal: { en: 'Normal', de: 'Normal', ja: 'ノーマル' }, free: { en: 'Free', de: 'Frei', ja: 'フリー' },
};

/** import game files without the pack screen (command line, old storage) */
async function addGameFiles(files: Array<{ name: string; data: Uint8Array }>) {
  const found: Pack[] = [];
  for (let { name, data } of files) {
    if (/\.zip$/i.test(name) || (data[0] === 0x50 && data[1] === 0x4b)) {
      const inner = await unzipFirst(data, /\.(nds|gbc?|sfc|smc|bs|3ds|cia|cxi)$/i);
      if (!inner) continue;
      data = inner as Uint8Array<ArrayBuffer>;
    }
    const r = await importGameFile(name, data);
    if (r.ok) found.push(...r.packs);
  }
  if (found.length) ctx.packs = await storePacks(ctx.packs, found);
}

/** extras a pack needs before its lists are shown (Picross DS: the solved-picture animations) */
async function loadExtras(pack: Pack): Promise<void> {
  if (ctx.pcks.has(pack.id)) return;
  const p = pack as Pack & { ds?: DsPackMeta };
  if (!p.ds) { ctx.pcks.set(pack.id, null); return; }
  const pck = await storage.loadAsset(pack.id, 'anim.pck').catch(() => undefined);
  const ds = dsFromPack(p, null, pck ?? null);
  const fits = !!ds?.pck && ds.pckOffsets.length > 0 && ds.pckOffsets[ds.pckOffsets.length - 1] <= ds.pck.length && ds.pck.length - ds.pckOffsets[ds.pckOffsets.length - 1] < 0x10000;
  if (ds?.pck && !fits) console.warn('animation data does not match this pack: re-add the game to restore them');
  ctx.pcks.set(pack.id, fits ? (i => pckFile(ds!, i)) : null);
}
const pckOf = (pack: Pack) => ctx.pcks.get(pack.id) ?? null;

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

// ---------------------------------------------------------------- home: the game library

function countPack(pack: Pack): [number, number] {
  let a = 0, b = 0;
  for (const l of pack.levels) for (const p of l.puzzles) { b++; if (getProgress(pack.id, p.id).cleared) a++; }
  return [a, b];
}

/** the pack played last (its menu music plays on the home screen) */
function lastPack(): Pack | null {
  const id = localStorage.getItem('momogram.lastPack');
  return allPacks().find(p => p.id === id) ?? null;
}

export function home() {
  applyThemeCss(root(), null);
  // whatever plays keeps playing; only a silent start picks a random track from all games
  if (!Snd.current()) menuMusic(null, true);
  const q = getQuickSave();
  const qPack = q ? allPacks().find(p => p.id === q.packId) : null;
  const packs = allPacks();
  let solved = 0, total = 0;
  for (const p of packs) { const [a, b] = countPack(p); solved += a; total += b; }

  const top = h('section', { class: 'home-top' },
    h('button', { class: 'btn profile-chip', onClick: () => profileDialog(home), title: t('profile') }, '👤 ' + activeProfile().name),
    logo(),
    h('div', { class: 'home-progress' },
      h('div', { class: 'bar-outer' }, h('div', { class: 'bar-inner', style: `width:${total ? (solved / total) * 100 : 0}%` })),
      h('small', {}, t('solvedCount', { a: solved, b: total }))));

  const quick = h('div', { class: 'menu' },
    qPack ? h('button', { class: 'btn primary big', onClick: () => resumeQuick() }, h('b', {}, '▶ ' + t('continue')), h('small', {}, pickAny(qPack.title, packLang()))) : null,
    h('button', { class: 'btn big mode daily', onClick: () => daily() }, h('b', {}, t('daily'))),
    h('button', { class: 'btn big mode random', onClick: () => randomPuzzle() }, h('b', {}, t('random'))));

  const lib = h('div', { class: 'library' });
  renderLibrary(lib, null);
  const arrange = h('button', { class: 'btn ghost arrange', onClick: () => { libEdit = !libEdit; renderLibrary(lib, null); arrange.classList.toggle('on', libEdit); } }, t('arrange'));

  screen(h('div', { class: 'home' }, top, quick,
    h('div', { class: 'section-row' }, h('h2', { class: 'section-title' }, t('library')), arrange), lib,
    h('div', { class: 'menu small' },
      h('button', { class: 'btn', onClick: () => packsScreen() }, '📦 ' + t('packs')),
      h('button', { class: 'btn', onClick: () => editorScreen() }, '✎ ' + t('editor')),
      h('button', { class: 'btn', onClick: () => optionsScreen() }, '⚙ ' + t('options'))),
    h('footer', { class: 'fine' }, t('noGameData'))));
}

// ---------------------------------------------------------------- library: folders, order, hidden games

interface LibPrefs { order: string[]; hidden: string[]; group: 'series' | 'system' | 'none' }
function libPrefs(): LibPrefs {
  try { return { order: [], hidden: [], group: 'series', ...JSON.parse(localStorage.getItem('momogram.library') || '{}') }; } catch { return { order: [], hidden: [], group: 'series' }; }
}
function setLibPrefs(p: LibPrefs) { localStorage.setItem('momogram.library', JSON.stringify(p)); }
let libEdit = false;

/** series of a game, from its title (all Picross e games together, the Mario games, …) */
function seriesOf(p: Pack): string {
  const n = pickAny(p.title, 'en');
  const rules: Array<[RegExp, string]> = [
    [/^picross e\d*$/i, 'Picross e'], [/^picross s/i, 'Picross S'], [/^picross np/i, 'Picross NP'], [/^picross ds/i, 'Picross DS'],
    [/mario/i, 'Mario'], [/pok[eé]mon/i, 'Pokémon'], [/club nintendo|my nintendo/i, 'Nintendo rewards'], [/tamori/i, 'Tamori'],
  ];
  for (const [re, name] of rules) if (re.test(n)) return name;
  return n;
}
const groupKey = (p: Pack, mode: LibPrefs['group']) => p.id === 'momogram-starter' ? '' : mode === 'system' ? p.source.platform : mode === 'series' ? seriesOf(p) : '';

/** visible games in the player's order (hidden ones only while arranging) */
function libraryPacks(includeHidden = false): Pack[] {
  const pr = libPrefs();
  const idx = (id: string) => { const i = pr.order.indexOf(id); return i < 0 ? 1e6 : i; };
  return allPacks().filter(p => includeHidden || !pr.hidden.includes(p.id)).sort((a, b) => idx(a.id) - idx(b.id));
}

function gameCard(p: Pack, onOpen: () => void): HTMLElement {
  const [a, b] = countPack(p);
  const col = p.theme?.palette && settings.packColors ? themeColors(p.theme.palette).accent : null;
  return h('button', { class: 'btn game' + (p.icon ? ' has-icon' : ''), style: col ? `--game:${col}` : undefined, onClick: onOpen },
    p.icon ? iconCanvas(p.icon) : null,
    h('b', {}, pickAny(p.title, packLang())),
    h('small', {}, [p.source.platform, p.source.year].filter(Boolean).join(' · ') + (p.theme?.music ? ' · ♪' : '')),
    h('div', { class: 'bar-outer slim' }, h('div', { class: 'bar-inner', style: `width:${b ? (a / b) * 100 : 0}%` })),
    h('small', { class: 'count' }, t('solvedCount', { a, b })));
}

/**
 * The library grid: single games as cards, several games of a series (or system) as a folder. While arranging,
 * every entry gets arrows to move it and an eye to hide it.
 */
function renderLibrary(el: HTMLElement, folder: string | null) {
  const pr = libPrefs();
  const packs = libraryPacks(libEdit);
  const entries: Array<{ key: string; packs: Pack[] }> = [];
  for (const p of packs) {
    const k = folder !== null ? p.id : groupKey(p, pr.group) || p.id;
    if (folder !== null && (groupKey(p, pr.group) || p.id) !== folder) continue;
    const e = entries.find(x => x.key === k);
    if (e) e.packs.push(p); else entries.push({ key: k, packs: [p] });
  }
  el.replaceChildren();
  const move = (e: { packs: Pack[] }, d: number) => {
    // order is kept per game; moving an entry moves all games in it past the neighbour entry
    const flat = entries.flatMap(x => x.packs.map(p => p.id));
    const i = entries.indexOf(e as any), j = i + d;
    if (j < 0 || j >= entries.length) return;
    [entries[i], entries[j]] = [entries[j], entries[i]];
    const order = entries.flatMap(x => x.packs.map(p => p.id));
    const rest = pr.order.filter(id => !flat.includes(id));
    setLibPrefs({ ...pr, order: [...order, ...rest] });
    renderLibrary(el, folder);
  };
  for (const e of entries) {
    const hidden = e.packs.every(p => pr.hidden.includes(p.id));
    const card = e.packs.length === 1
      ? gameCard(e.packs[0], () => openPack(e.packs[0], folder !== null ? () => folderScreen(folder) : home))
      : folderCard(e.key, e.packs);
    const wrap = h('div', { class: 'lib-entry' + (hidden ? ' hidden' : '') }, card);
    if (libEdit) {
      card.setAttribute('tabindex', '-1');
      wrap.append(h('div', { class: 'lib-tools' },
        h('button', { class: 'rbtn ghost', 'aria-label': t('moveLeft'), onClick: () => move(e, -1) }, icon('prev')),
        h('button', { class: 'btn eye', onClick: () => {
          const ids = e.packs.map(p => p.id);
          setLibPrefs({ ...pr, hidden: hidden ? pr.hidden.filter(id => !ids.includes(id)) : [...pr.hidden, ...ids] });
          renderLibrary(el, folder);
        } }, hidden ? t('show') : t('hide')),
        h('button', { class: 'rbtn ghost', 'aria-label': t('moveRight'), onClick: () => move(e, 1) }, icon('next'))));
    }
    el.append(wrap);
  }
  if (libEdit && folder === null) el.append(h('div', { class: 'lib-group' }, h('span', {}, t('groupBy')),
    ...(['series', 'system', 'none'] as const).map(m => h('button', { class: 'tab' + (pr.group === m ? ' on' : ''), onClick: () => { setLibPrefs({ ...pr, group: m }); renderLibrary(el, folder); } }, t('group_' + m)))));
}

/** a game's own icon (read from the user's file), drawn pixel-sharp */
function iconCanvas(ic: NonNullable<Pack['icon']>): HTMLCanvasElement {
  const c = h('canvas', { class: 'game-icon', width: ic.w, height: ic.h, 'aria-hidden': 'true' });
  const bin = atob(ic.rgba), px = new Uint8ClampedArray(bin.length);
  for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
  c.getContext('2d')!.putImageData(new ImageData(px, ic.w, ic.h), 0, 0);
  return c;
}

function folderCard(key: string, packs: Pack[]): HTMLElement {
  let a = 0, b = 0;
  for (const p of packs) { const [x, y] = countPack(p); a += x; b += y; }
  return h('button', { class: 'btn game folder', onClick: () => folderScreen(key) },
    h('b', {}, key), h('small', {}, t('gamesCount', { n: packs.length })),
    h('div', { class: 'folder-tabs' }, ...packs.slice(0, 4).map(p => p.icon ? iconCanvas(p.icon) : h('i', { style: p.theme?.palette ? `--game:${themeColors(p.theme.palette).accent}` : undefined }))),
    h('div', { class: 'bar-outer slim' }, h('div', { class: 'bar-inner', style: `width:${b ? (a / b) * 100 : 0}%` })),
    h('small', { class: 'count' }, t('solvedCount', { a, b })));
}

function folderScreen(key: string) {
  applyThemeCss(root(), null);
  const lib = h('div', { class: 'library' });
  renderLibrary(lib, key);
  screen(header(key, home), h('div', { class: 'home' }, lib));
}

function progressText(pack: Pack, levels: PackLevel[]) {
  let a = 0, b = 0;
  for (const l of levels) for (const p of l.puzzles) { b++; if (getProgress(pack.id, p.id).cleared) a++; }
  return t('solvedCount', { a, b });
}

// ---------------------------------------------------------------- a game: modes → levels → puzzles

async function openPack(pack: Pack, back: () => void) {
  await loadExtras(pack);
  localStorage.setItem('momogram.lastPack', pack.id);
  packLevels(pack, back);
}

function packLevels(pack: Pack, back: () => void = home) {
  usePack(pack, 'menu');
  if (pack.levels.length === 1) return puzzleList(pack, pack.levels[0], back);
  const groups = [...new Set(pack.levels.map(l => l.group ?? ''))];
  if (groups.length === 1) return groupLevels(pack, groups[0], back, back);
  const self = () => packLevels(pack, back);
  const list = h('div', { class: 'levels' });
  for (const g of groups) {
    const lvs = pack.levels.filter(l => (l.group ?? '') === g);
    // a mode with a single level (Picross DS "Easy") opens its puzzles directly
    const open = () => lvs.length === 1 ? puzzleList(pack, lvs[0], self) : groupLevels(pack, g, self, back);
    list.append(h('button', { class: 'btn level mode-' + g, onClick: open }, h('b', {}, groupTitle(pack, g)), h('small', {}, progressText(pack, lvs))));
  }
  screen(header(pickAny(pack.title, packLang()), back), packInfo(pack), list, packFooter(pack, self));
}

function packInfo(pack: Pack): HTMLElement {
  const s = pack.source;
  return h('p', { class: 'pack-info' }, [s.game !== pickAny(pack.title, 'en') ? s.game : '', s.platform, s.region, s.developer, s.year].filter(Boolean).join(' · '));
}

function packFooter(pack: Pack, rerender: () => void): HTMLElement {
  return h('div', { class: 'row' }, h('button', { class: 'btn ghost', onClick: () => { if (confirm(t('confirmReset'))) { resetProgress(pack.id); rerender(); } } }, t('resetProgress')));
}

function groupTitle(pack: Pack, g: string) {
  const lv = pack.levels.find(l => (l.group ?? '') === g);
  return lv?.groupTitle ? pickAny(lv.groupTitle, packLang()) : g ? g[0].toUpperCase() + g.slice(1) : pickAny(pack.title, packLang());
}

function groupLevels(pack: Pack, g: string, back: () => void, packBack: () => void) {
  usePack(pack, 'menu');
  const self = () => groupLevels(pack, g, back, packBack);
  const levels = pack.levels.filter(l => (l.group ?? '') === g);
  const list = h('div', { class: 'levels' });
  for (const lv of levels) {
    const open = levelUnlocked(pack, lv);
    const done = lv.puzzles.filter(p => getProgress(pack.id, p.id).cleared).length;
    const sizes = [...new Set(lv.puzzles.map(p => `${p.width}×${p.height}`))];
    const sz = sizes.length === 1 ? sizes[0] : `${sizes[0]}–${sizes[sizes.length - 1]}`;
    const hint = lv.extra ? t('extraHint') : t('unlockHint', { n: lv.unlockAfter ?? 0 });
    list.append(h('button', {
      class: 'btn level' + (open ? '' : ' locked') + (done === lv.puzzles.length ? ' complete' : ''),
      disabled: open ? undefined : true, title: open ? '' : hint,
      onClick: () => puzzleList(pack, lv, self),
    }, h('b', {}, pickAny(lv.title, packLang())), h('small', {}, open ? `${sz} · ${done}/${lv.puzzles.length}` : '🔒 ' + hint)));
  }
  const title = g ? `${pickAny(pack.title, packLang())} · ${groupTitle(pack, g)}` : pickAny(pack.title, packLang());
  screen(header(title, back), list, back === packBack ? packFooter(pack, self) : null);
}

function puzzleList(pack: Pack, lv: PackLevel, back: () => void) {
  usePack(pack, 'menu');
  const grid = h('div', { class: 'puzzles' });
  const pck = pckOf(pack);
  // info strip: the focused puzzle, otherwise the level summary
  const info = h('div', { class: 'puzzle-info' });
  const showLevel = () => {
    const done = lv.puzzles.filter(p => getProgress(pack.id, p.id).cleared).length;
    const sizes = [...new Set(lv.puzzles.map(p => `${p.width}×${p.height}`))];
    const stars = lv.puzzles.filter(p => getProgress(pack.id, p.id).underLimit).length;
    info.replaceChildren(h('div', { class: 'ring', style: `--p:${(done / lv.puzzles.length) * 100}%` }, h('span', {}, String(done))),
      h('b', {}, `${done} / ${lv.puzzles.length} ${t('puzzles')}` + (stars ? `  ★ ${stars}` : '')),
      h('small', {}, sizes.length === 1 ? sizes[0] : `${sizes[0]} – ${sizes[sizes.length - 1]}`));
  };
  const showPuzzle = (p: PackPuzzle, i: number) => {
    const pr = getProgress(pack.id, p.id);
    const name = pr.cleared ? pickText(p.name, packLang()) : '';
    info.replaceChildren(pr.cleared ? thumbnail(p, pck, 48) : h('span', { class: 'qmark' }, '?'),
      h('b', {}, `${t('puzzleNo')} ${i + 1}` + (name ? ` · ${name}` : '')),
      h('small', {}, `${p.width}×${p.height}` + (pr.best !== undefined ? ` · ${t('best')} ${formatTime(pr.best)}` : '') + (pr.underLimit ? ' ★' : '')));
  };
  showLevel();
  lv.puzzles.forEach((p, i) => {
    const pr = getProgress(pack.id, p.id);
    const tile = h('button', { class: 'btn puzzle' + (pr.cleared ? ' cleared' : ''), onClick: () => puzzleStart(pack, lv, i, () => puzzleList(pack, lv, back)),
      onMouseenter: () => showPuzzle(p, i), onFocus: () => showPuzzle(p, i), onMouseleave: () => showLevel(),
      'aria-label': `${t('puzzleNo')} ${i + 1}` });
    if (pr.cleared) tile.append(thumbnail(p, pck, 64));
    else tile.append(h('span', { class: 'qmark' }, '?'));
    tile.append(h('small', {}, pr.cleared ? (pickText(p.name, packLang()) || `${p.width}×${p.height}`) : `${p.width}×${p.height}`));
    if (pr.best !== undefined) tile.append(h('em', {}, formatTime(pr.best)));
    tile.append(h('span', { class: 'num' }, String(i + 1)));
    if (p.exclusive) tile.append(h('span', { class: 'excl', title: t('exclusive', { r: p.exclusive }) }, p.exclusive));
    if (pr.medal) tile.append(medalEl(pr.medal));
    else if (pr.underLimit) tile.append(h('span', { class: 'star', title: '< 60:00' }, '★'));
    grid.append(tile);
  });
  // level tabs for quick switching within the same mode
  const sib = lv.group ? pack.levels.filter(l => l.group === lv.group) : [];
  const tabs = sib.length > 1 ? h('div', { class: 'tabs' }, ...sib.map(l => {
    const open = levelUnlocked(pack, l);
    const label = pickAny(l.title, packLang()).replace(/^\D+\s(?=\d)/, '').replace(/^.*Extra$/, 'EX');
    return h('button', { class: 'tab' + (l === lv ? ' on' : ''), disabled: open ? undefined : true, onClick: () => puzzleList(pack, l, back) }, open ? label : '🔒');
  })) : null;
  screen(header(pickAny(lv.title, packLang()), back), tabs, info, grid,
    difficultyPicker(lv, () => puzzleList(pack, lv, back)),
    h('p', { class: 'rules' }, rulesText(rulesFor(lv))));
}

/** between the list and the board: the puzzle, its source, your results, the difficulty, Start */
function puzzleStart(pack: Pack, lv: PackLevel, i: number, back: () => void) {
  usePack(pack, 'menu');
  const pz = lv.puzzles[i];
  const pr = getProgress(pack.id, pz.id);
  const pck = pckOf(pack);
  const name = pr.cleared ? pickText(pz.name, packLang()) : '';
  const pic = pr.cleared ? thumbnail(pz, pck, 160) : h('div', { class: 'qbig', style: `aspect-ratio:${pz.width}/${pz.height}` }, '?');
  const go = () => play(pack, lv, i, back);
  const nav = (d: number) => { const j = i + d; if (j >= 0 && j < lv.puzzles.length) puzzleStart(pack, lv, j, back); };
  const stat = (label: string, value: Node | string) => h('div', { class: 'stat' }, h('small', {}, label), h('b', {}, value));
  screen(header(pickAny(lv.title, packLang()), back), h('div', { class: 'pstart' },
    h('div', { class: 'pstart-pic' },
      h('button', { class: 'rbtn ghost', disabled: i === 0 ? true : undefined, 'aria-label': t('prev'), onClick: () => nav(-1) }, icon('prev')),
      h('div', { class: 'pic-frame' }, pic),
      h('button', { class: 'rbtn ghost', disabled: i + 1 >= lv.puzzles.length ? true : undefined, 'aria-label': t('nextPuzzle'), onClick: () => nav(1) }, icon('next'))),
    h('h2', {}, `${t('puzzleNo')} ${i + 1}` + (name ? ` · ${name}` : '')),
    h('p', { class: 'pstart-from' }, (pz.from ?? `${pickAny(pack.title, packLang())} · ${pickAny(lv.title, packLang())}`) + (pz.exclusive ? ' · ' + t('exclusive', { r: pz.exclusive }) : '')),
    h('div', { class: 'stats' },
      stat(t('size'), `${pz.width}×${pz.height}`),
      stat(t('level'), h('span', { class: 'diff d' + puzzleLevel(pz) }, t('diff' + puzzleLevel(pz)))),
      stat(t('best'), pr.best !== undefined ? formatTime(pr.best) : '–'),
      stat(t('medal'), pr.medal ? medalEl(pr.medal, true) : '–')),
    difficultyPicker(lv, () => puzzleStart(pack, lv, i, back)),
    h('p', { class: 'rules' }, rulesText(rulesFor(lv))),
    h('button', { class: 'btn primary big start', onClick: go }, icon('play'), t('start'))));
}

async function resumeQuick() {
  const q = getQuickSave();
  if (!q) return home();
  const pack = allPacks().find(p => p.id === q.packId);
  const lv = pack?.levels.find(l => l.id === q.levelId);
  const i = lv?.puzzles.findIndex(p => p.id === q.puzzleId) ?? -1;
  if (!pack || !lv || i < 0) { setQuickSave(null); return home(); }
  await loadExtras(pack);
  play(pack, lv, i, home, q.state);
}

/** puzzles within a level are lettered A, B, C … (numbers past Z) */
function levelLetter(i: number): string { return i < 26 ? String.fromCharCode(65 + i) : String(i + 1); }

/** the rules a level is played with: its own, or the difficulty the player picked */
type PlayRules = 'easy' | 'normal' | 'free';
function rulesFor(lv: PackLevel): PlayRules {
  const d = settings.difficulty;
  return d === 'easy' ? 'easy' : d === 'normal' ? 'normal' : d === 'hard' ? 'free' : lv.rules;
}
function rulesText(r: PlayRules) { return r === 'easy' ? t('rulesEasy') : r === 'normal' ? t('rulesNormal') : t('rulesHard'); }
function rulesName(r: PlayRules) { return r === 'easy' ? t('easy') : r === 'normal' ? t('normal') : t('hard'); }

function difficultyPicker(lv: PackLevel, rerender: () => void): HTMLElement {
  const cur = rulesFor(lv);
  const opts: Array<[PlayRules, 'easy' | 'normal' | 'hard']> = [['easy', 'easy'], ['normal', 'normal'], ['free', 'hard']];
  return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': t('difficulty') }, ...opts.map(([r, key]) =>
    h('button', { class: 'segbtn ' + key + (cur === r ? ' on' : ''), role: 'radio', 'aria-checked': cur === r ? 'true' : 'false',
      onClick: () => { settings.difficulty = r === lv.rules ? 'auto' : key; saveSettings(); rerender(); } },
      rulesName(r) + (r === lv.rules ? ' ·' : ''))));
}

/** every game in the library: MomoGram's starter puzzles first, then the imported games */
function allPacks(): Pack[] { return [STARTER, ...ctx.packs]; }

// ---------------------------------------------------------------- music & colours of a game

type Track = { pack: Pack; ref: string };
/** in-game tracks a pack offers */
function packTracks(pack: Pack): Track[] {
  const m = pack.theme?.music;
  if (!m || !settings.packMusic) return [];
  const refs = pack.theme?.tracks?.length ? pack.theme.tracks : [...new Set([m.play, m.play2].filter((r): r is string => !!r))];
  return refs.map(ref => ({ pack, ref }));
}
let lastTrack = '';
/** music while playing: random from this game (default), random from all games, or the game's main track */
function playMusicFor(pack: Pack) {
  applyThemeCss(root(), packColors(pack));
  let pool: Track[];
  if (settings.musicMode === 'fixed') pool = packTracks(pack).slice(0, 1);
  else if (settings.musicMode === 'random-all' || !packTracks(pack).length) pool = allPacks().flatMap(packTracks); // games without music borrow
  else pool = packTracks(pack);
  if (!pool.length) { Snd.stop(); return; }
  const choices = pool.length > 1 ? pool.filter(x => x.pack.id + x.ref !== lastTrack) : pool;
  const tr = choices[Math.floor(Math.random() * choices.length)];
  lastTrack = tr.pack.id + tr.ref;
  Snd.playPack(tr.pack.id, tr.ref);
}

/** colours of the pack's original game (or null for MomoGram's own) */
function packColors(pack: Pack | null): ThemeColors | null {
  return pack?.theme?.palette && settings.packColors ? themeColors(pack.theme.palette) : null;
}

/** a game's look and one of its tracks ('menu', 'clear' …) */
function usePack(pack: Pack | null, role: 'menu' | 'play' | 'clear', loop = true) {
  applyThemeCss(root(), packColors(pack));
  if (role === 'menu') return menuMusic(pack);
  const ref = pack?.theme?.music?.[role];
  if (pack && ref && settings.packMusic) Snd.playPack(pack.id, ref, loop);
}

/** title and menu tracks of a game */
function menuTracks(pack: Pack): Track[] {
  const m = pack.theme?.music;
  if (!m || !settings.packMusic) return [];
  return [...new Set([m.title, m.menu].filter((r): r is string => !!r))].map(ref => ({ pack, ref }));
}

/**
 * Menu music: a random title / menu track — from the game whose screens are open (unless "random from all
 * games" is set), on the home screen from all games. A track that fits keeps playing between menus.
 */
function menuMusic(pack: Pack | null = null, fresh = false) {
  let pool = pack && settings.musicMode !== 'random-all' ? menuTracks(pack) : [];
  if (!pool.length) pool = allPacks().flatMap(menuTracks);
  if (!pool.length) { Snd.stop(); return; }
  if (!fresh && pool.some(x => x.pack.id + '/' + x.ref === Snd.current())) return;
  if (fresh && pool.length > 1) pool = pool.filter(x => x.pack.id + '/' + x.ref !== Snd.current());
  const tr = pool[Math.floor(Math.random() * pool.length)];
  Snd.playPack(tr.pack.id, tr.ref);
}

// ---------------------------------------------------------------- daily nonogram

/** seeded random numbers (the same daily selection all day) */
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

/** every puzzle of the visible games, with where it comes from */
function puzzlePool(): Array<{ pack: Pack; lv: PackLevel; i: number }> {
  const out: Array<{ pack: Pack; lv: PackLevel; i: number }> = [];
  for (const p of libraryPacks()) for (const lv of p.levels) lv.puzzles.forEach((z, i) => { if (z.rows.some(r => r.includes('#'))) out.push({ pack: p, lv, i }); });
  return out;
}

/** n puzzles of a measured difficulty, drawn at random (difficulty is computed only for the ones looked at) */
function drawPuzzles(rand: () => number, level: 1 | 2 | 3, n: number, skip = new Set<string>()) {
  const pool = puzzlePool();
  const out: Array<{ pack: Pack; lv: PackLevel; i: number }> = [];
  for (let tries = 0; tries < 4000 && out.length < n && pool.length; tries++) {
    const k = Math.floor(rand() * pool.length);
    const e = pool[k]; pool.splice(k, 1);
    const pz = e.lv.puzzles[e.i];
    if (skip.has(pz.rows.join('/'))) continue;
    if (puzzleLevel(pz) === level) { out.push(e); skip.add(pz.rows.join('/')); }
  }
  return out;
}

const fromText = (e: { pack: Pack; lv: PackLevel }) => `${pickAny(e.pack.title, packLang())} · ${pickAny(e.lv.title, packLang())}`;

/** 15 puzzles a day, 5 per difficulty, from all visible games; solved ones are saved for the day */
function daily() {
  const d = new Date();
  const seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const rand = rng(seed), seen = new Set<string>();
  const levels: PackLevel[] = ([1, 2, 3] as const).map(level => ({
    id: `daily-${seed}-d${level}`, title: { en: t('diff' + level) }, rules: 'normal' as const,
    puzzles: drawPuzzles(rand, level, 5, seen).map((e, k) => ({ ...e.lv.puzzles[e.i], id: `daily-${seed}-d${level}-${k}`, from: fromText(e), name: undefined })),
  })).filter(l => l.puzzles.length);
  if (!levels.length) return;
  const pack: Pack = { format: 'momogram-pack', version: 1, id: 'daily', title: { en: t('daily') }, source: { game: 'MomoGram', platform: 'MomoGram' }, levels };
  packLevels(pack, home);
}

/** "Surprise me": pick a difficulty, then a random puzzle of it from the whole library */
function randomPuzzle() {
  const go = async (level: 1 | 2 | 3) => {
    const [e] = drawPuzzles(Math.random, level, 1);
    if (!e) return;
    await loadExtras(e.pack);
    puzzleStart(e.pack, e.lv, e.i, home);
  };
  choose(t('randomFrom'), [[t('diff1'), () => go(1)], [t('diff2'), () => go(2)], [t('diff3'), () => go(3)], [t('back'), () => {}]]);
}

// ---------------------------------------------------------------- play

function play(pack: Pack, lv: PackLevel, index: number, back: () => void, restore?: any) {
  const pz = lv.puzzles[index];
  const rules = rulesFor(lv);
  const board = new Board(pz.rows, rules);
  if (restore) board.restore(restore); else board.crossEmptyLines();
  playMusicFor(pack);

  // slim status bar instead of a second screen: picture, level, LCD timer; the board gets the rest
  const timeEl = h('span', { class: 'time' }, '00:00');
  const mistakesEl = h('span', { class: 'mist' });
  const preview = h('canvas', { class: 'preview' });
  const top = h('section', { class: 'hud' },
    h('div', { class: 'hud-pic' }, preview),
    h('div', { class: 'hud-info' },
      h('div', { class: 'hud-lvl' }, h('span', { class: 'badge ' + rules }, rulesName(rules).slice(0, 1)), h('b', {}, pickAny(lv.title, packLang()) + ' · ' + levelLetter(index))),
      h('div', { class: 'hud-size' }, `${pz.width}×${pz.height} · ${pz.from ?? pickAny(pack.title, packLang())}`, mistakesEl)),
    h('div', { class: 'lcd' }, timeEl));
  const canvas = h('canvas', { class: 'board' });
  // bottom bar: one tool button that switches between filling and crossing out, zoom, then hints / undo / try it
  const toolBtn = h('button', { class: 'rbtn tool-toggle', title: t('fill'), 'aria-label': t('fill'), onClick: () => setTool(view.tool === 'fill' ? 'cross' : 'fill') },
    h('span', { class: 'face fill-face' }, icon('fill')), h('span', { class: 'face cross-face' }, icon('cross')));
  const lensBtn = h('button', { class: 'rbtn', title: t('zoom'), 'aria-label': t('zoom'), onClick: () => { view.toggleZoom(); lensBtn.classList.toggle('on', view.zoomed); } }, icon('zoom'));
  const boardWrap = h('section', { class: 'boardwrap' }, canvas);
  const tbtn = (ico: string, label: string, fn: () => void) => h('button', { class: 'rbtn small', title: label, 'aria-label': label, onClick: fn }, icon(ico), h('small', {}, label));
  const undoBtn = tbtn('undo', t('undo'), () => { if (board.undo()) { view.invalidate(); updateInfo(); } });
  const trialBtn = rules === 'free' ? tbtn('trial', t('tryIt'), () => trialToggle()) : null;
  const trialLabel = trialBtn?.querySelector('small') ?? h('small');
  const logicBtn = tbtn('hint', t('logic'), () => {
    settings.logicHints = !settings.logicHints; saveSettings(); view.logicHints = settings.logicHints; if (settings.logicHints) usedHints = true;
    view.invalidate(); logicBtn.classList.toggle('on', settings.logicHints); logicBtn.setAttribute('aria-pressed', String(settings.logicHints));
  });
  logicBtn.classList.toggle('on', settings.logicHints);
  logicBtn.setAttribute('aria-pressed', String(settings.logicHints));
  const menuBtn = h('button', { class: 'rbtn hud-menu', title: t('menu'), 'aria-label': t('menu'), onClick: () => pauseMenu() }, icon('menu'));
  const tools = h('nav', { class: 'tools' }, h('div', { class: 'tool-main' }, toolBtn, lensBtn), h('span', { class: 'gap' }), h('div', { class: 'tool-side' }, logicBtn, undoBtn, trialBtn));

  top.append(menuBtn);
  screen(h('div', { class: 'play side-bottom' + (settings.toolsRight ? ' tools-right' : '') }, top, boardWrap, tools));
  const colors = packColors(pack);

  const view = new BoardView(canvas, board, {
    onChange: r => {
      if (r === 'mistake') Snd.sfx('mistake'); else Snd.sfx('tap');
      updateInfo();
      if (board.checkSolved()) solved();
    },
  });

  view.setTheme(colors ? colors.board : null);
  view.logicHints = settings.logicHints;
  // medal: bronze on Easy, silver on Normal, gold on Hard, platinum on Hard without logic hints
  let usedHints = settings.logicHints || !!restore?.usedHints;
  if (/[?&]debug/.test(location.search)) (window as any).__play = {
    board, view,
    solve() { for (let y = 0; y < board.h; y++) for (let x = 0; x < board.w; x++) board.cells[y * board.w + x] = board.solution[y * board.w + x] ? FILL : CROSS; board.touch(); view.invalidate(); if (board.checkSolved()) solved(); },
  };

  view.onLayout = () => {
    lensBtn.classList.toggle('on', view.zoomed);
    updateInfo();
  };

  function setTool(tool: 'fill' | 'cross') {
    view.tool = tool;
    toolBtn.classList.toggle('crossing', tool === 'cross');
    const l = tool === 'fill' ? t('fill') : t('cross');
    toolBtn.title = l; toolBtn.setAttribute('aria-label', l);
  }

  function trialToggle() {
    if (!board.trial) { board.startTrial(); trialLabel.textContent = t('keep') + '?'; trialBtn?.classList.add('on'); }
    else {
      choose(t('tryIt'), [[t('keep'), () => board.commitTrial()], [t('discard'), () => board.discardTrial()], [t('back'), () => { /* stay */ }]]).then(() => {
        if (!board.trial) { trialLabel.textContent = t('tryIt'); trialBtn?.classList.remove('on'); }
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
    const sc = Math.min(W / board.w, H / board.h);
    pc.fillStyle = '#ffffff'; pc.fillRect(0, 0, W, H);
    const ox = (W - board.w * sc) / 2, oy = (H - board.h * sc) / 2;
    for (let y = 0; y < board.h; y++) for (let x = 0; x < board.w; x++) {
      const v = board.at(x, y);
      if (v === FILL) { pc.fillStyle = board.isTrialCell(x, y) ? '#e08a2c' : '#1a1a1a'; pc.fillRect(ox + x * sc, oy + y * sc, Math.ceil(sc), Math.ceil(sc)); }
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
    if (Math.floor(r.width) !== view.width || Math.floor(r.height) !== view.height) view.resize(Math.floor(r.width), Math.floor(r.height));
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
      [t('stopSave'), () => { setQuickSave({ packId: pack.id, levelId: lv.id, puzzleId: pz.id, state: { ...board.snapshot(), usedHints } as any }); cleanup(); back(); }],
      [t('restart'), () => { cleanup(); setQuickSave(null); play(pack, lv, index, back); }],
      [t('quit'), () => { cleanup(); setQuickSave(null); back(); }],
    ]);
    last = performance.now();
    running = true;
  }

  // hint roulette at a fresh start: always on Easy, as set in the options on Normal, never on Hard
  if (!restore && rules !== 'free' && pz.width * pz.height > 25) {
    const ask = settings.hints; // asked on Easy too (the default), never on Hard
    const go = async () => {
      running = false;
      const row = Math.floor(Math.random() * board.h), col = Math.floor(Math.random() * board.w);
      await view.roulette(row, col, () => Snd.sfx('tap'));
      board.pushUndo(); board.revealHint(Math.random, row, col);
      Snd.sfx('clear');
      view.invalidate(); updateInfo();
      last = performance.now(); running = true;
    };
    if (ask === 'always') setTimeout(go, 350);
    else if (ask === 'ask') { running = false; choose(t('useHints'), [[t('yes'), () => { go(); }], [t('no'), () => {}]]).then(() => { last = performance.now(); if (!view.spinning) running = true; }); }
  }

  function solved() {
    finished = true;
    if (pack.theme?.music?.clear && settings.packMusic) usePack(pack, 'clear', false);
    else { Snd.stop(); Snd.sfx('clear'); }
    const under = board.totalMs < TIME_LIMIT;
    const medal: Medal = rules === 'easy' ? 'bronze' : rules === 'normal' ? 'silver' : usedHints ? 'gold' : 'platinum';
    const newMedal = recordClear(pack.id, pz.id, board.totalMs, under, medal);
    setQuickSave(null);
    cleanup();
    showSolved(pack, lv, index, board, under, pckOf(pack), back, medal, newMedal);
  }
}

function medalEl(m: Medal, big = false) {
  return h('span', { class: 'medal ' + m + (big ? ' big' : ''), title: t(m) }, big ? t(m) : '');
}

function showSolved(pack: Pack, lv: PackLevel, index: number, board: Board, under: boolean, pck: PckGetter | null, back: () => void, medal?: Medal, newMedal = false) {
  const pz = lv.puzzles[index];
  const cv = h('canvas', { class: 'solved-pic' });
  const anim = new PictureAnimator(pz as any, pck);
  const best = getProgress(pack.id, pz.id).best;
  const next = index + 1 < lv.puzzles.length ? h('button', { class: 'btn primary', onClick: () => { stop(); play(pack, lv, index + 1, back); } }, t('next') + ' ›') : null;
  screen(h('div', { class: 'solved' },
    h('div', { class: 'stamp' }, t('cleared')),
    medal ? h('div', { class: 'medal-row' + (newMedal ? ' new' : '') }, medalEl(medal, true)) : null,
    under ? h('div', { class: 'pic-frame' }, cv) : h('p', { class: 'over' }, t('overLimit')),
    h('h2', {}, pickText(pz.name, packLang()) || `${pz.width}×${pz.height}`),
    h('div', { class: 'result' },
      h('div', {}, t('time'), h('b', {}, formatTime(board.totalMs))),
      board.mistakes ? h('div', {}, t('penalty'), h('b', {}, '+' + formatTime(board.penaltyMs))) : null,
      best !== undefined ? h('div', {}, t('best'), h('b', {}, formatTime(best))) : null),
    h('div', { class: 'row' }, h('button', { class: 'btn', onClick: () => { stop(); back(); } }, t('toList')), next)));
  setTimeout(() => { Snd.stop(); usePack(pack, 'menu'); }, pack.theme?.music?.clear ? 4500 : 1500);
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

function editorScreen() {
  applyThemeCss(root(), null);
  editorHome({
    packs: () => ctx.packs,
    setPacks: p => { ctx.packs = p.sort((a, b) => pickAny(a.title, 'en').localeCompare(pickAny(b.title, 'en'))); },
    header: (title, back) => header(title, back),
    screen, home, choose,
    test: (pack, lv, i, back) => play(pack, lv, i, back),
    author: activeProfile().name,
  });
}

function packsScreen() {
  applyThemeCss(root(), null);
  openPackManager({
    root: root(),
    packs: () => ctx.packs,
    setPacks: p => { ctx.packs = p; for (const id of [...ctx.pcks.keys()]) if (!p.some(x => x.id === id)) ctx.pcks.delete(id); },
    header: (title: string) => header(title, home),
    screen,
    openPack: (p: Pack) => openPack(p, () => packsScreen()),
  });
}

// ---------------------------------------------------------------- save file

/** older save files (one unnamed save, no per-pack times) → current format */
function upgradeSave(x: any): SaveFile | null {
  if (isSaveFile(x)) return x;
  if (x?.format !== 'momogram-save' || x.version !== 1) return null;
  const packs: SaveFile['packs'] = {};
  for (const [k, v] of Object.entries<any>(x.progress ?? {})) {
    const i = k.lastIndexOf('/'), id = k.slice(0, i);
    (packs[id] ??= { updated: x.saved ?? '1970-01-01T00:00:00.000Z', progress: {} }).progress[k.slice(i + 1)] = v;
  }
  return { format: 'momogram-save', version: 2, profile: { id: 'v1-' + (x.name || 'player').toLowerCase().replace(/\W+/g, '-'), name: x.name || 'Player' }, saved: x.saved, packs, quick: x.quick ?? null, settings: x.settings };
}

/** the active profile's save: export it (compressed) and import saves from other devices */
function saveSection(): HTMLElement {
  const me = activeProfile();
  const sum = progressSummary();
  const total = [...sum.values()].reduce((a, b) => a + b, 0);
  const known = new Set(allPacks().map(p => p.id));
  const waiting = [...sum.entries()].filter(([id, n]) => n && !known.has(id) && id !== 'daily').length;
  const exportSave = () => {
    const file = me.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-') || 'MomoGram';
    download(`${file}.momosave`, packSave(makeSave()), 'application/octet-stream');
  };
  const importFile = async () => {
    const f = await pickFile('.momosave,.json,application/octet-stream');
    if (!f) return;
    let s: SaveFile | null = null;
    try { s = upgradeSave(unpackSave(new Uint8Array(await f.arrayBuffer()))); } catch { s = null; }
    if (!s) { alert(t('notASave')); return; }
    const r = importSave(s);
    alert(r.created ? t('saveNewProfile', { name: r.profile }) : t('saveMerged', { name: r.profile, a: r.packsTaken, b: r.packsKept }));
    optionsScreen();
  };
  return h('div', { class: 'save-box' },
    h('div', { class: 'opt' }, h('span', {}, t('profile')), h('button', { class: 'btn', onClick: () => profileDialog(optionsScreen) }, '👤 ' + me.name)),
    h('p', { class: 'fine' }, `${total} ${t('puzzlesSolved')}` + (waiting ? ' · ' + t('saveWaiting', { n: waiting }) : '')),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn primary', onClick: exportSave }, '⤓ ' + t('saveExport')),
      h('button', { class: 'btn', onClick: importFile }, '⤒ ' + t('saveImport'))),
    h('p', { class: 'fine' }, t('saveHelp')));
}

/** switch, create, rename or delete profiles */
function profileDialog(after: () => void) {
  const me = activeProfile();
  const opts: Array<[string, () => void]> = profiles().map(p => [(p.id === me.id ? '✓ ' : '') + p.name, () => { switchProfile(p.id); }]);
  opts.push(['✚ ' + t('newProfile'), () => { const n = prompt(t('profileName'), ''); if (n !== null && n.trim()) createProfile(n); }]);
  opts.push(['✎ ' + t('renameProfile'), () => { const n = prompt(t('profileName'), me.name); if (n !== null && n.trim()) renameProfile(n); }]);
  if (profiles().length > 1) opts.push(['🗑 ' + t('deleteProfile', { name: me.name }), () => { if (confirm(t('deleteProfile', { name: me.name }) + '?')) deleteProfile(me.id); }]);
  opts.push([t('back'), () => {}]);
  choose(t('profile'), opts).then(after);
}

// ---------------------------------------------------------------- options

function optionsScreen() {
  const redraw = () => optionsScreen();
  // switch, segmented choice and slider in one consistent style
  const toggle = (key: keyof typeof settings, after?: () => void) => {
    const b = h('button', { class: 'switch' + (settings[key] ? ' on' : ''), role: 'switch', 'aria-checked': String(!!settings[key]),
      onClick: () => { (settings as any)[key] = !settings[key]; saveSettings(); b.classList.toggle('on', !!settings[key]); b.setAttribute('aria-checked', String(!!settings[key])); after?.(); } }, h('i'));
    return b;
  };
  const seg = (key: keyof typeof settings, opts: Array<[string, string]>, after?: () => void) => h('div', { class: 'seg mini' }, ...opts.map(([v, l]) =>
    h('button', { class: 'segbtn' + (String(settings[key]) === v ? ' on' : ''), onClick: () => { (settings as any)[key] = v; saveSettings(); after?.(); redraw(); } }, l)));
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: settings.musicVolume, 'aria-label': t('volume'),
    onInput: (e: Event) => { settings.musicVolume = +(e.target as HTMLInputElement).value; saveSettings(); Snd.setVolume(settings.musicVolume); } });
  const langSel = h('select', { 'aria-label': t('language'), onChange: (e: Event) => { settings.lang = (e.target as HTMLSelectElement).value as any; saveSettings(); setLang((settings.lang || navigator.language.slice(0, 2)) as Lang); redraw(); } },
    ...[['', 'Auto'], ...(Object.entries(LANG_NAMES) as Array<[string, string]>)].map(([v, l]) => h('option', { value: v, selected: (settings.lang ?? '') === v ? true : undefined }, l)));
  const row = (label: string, ctl: Node, note?: string) => h('div', { class: 'opt' }, h('div', { class: 'opt-label' }, h('span', {}, label), note ? h('small', {}, note) : null), ctl);
  const card = (title: string, ...rows: Array<Node | null>) => h('section', { class: 'opt-card' }, h('h2', {}, title), ...rows);
  screen(header(t('options'), home), h('div', { class: 'options' },
    card(t('secSound'),
      row(t('music'), toggle('music', () => settings.music ? menuMusic(null, true) : Snd.stop())),
      settings.music ? row(t('volume'), vol) : null,
      settings.music ? row(t('musicMode'), seg('musicMode', [['random-pack', t('musicRandomPack')], ['random-all', t('musicRandomAll')], ['fixed', t('musicFixed')]])) : null,
      row(t('sfx'), toggle('sfx'))),
    card(t('secPlay'),
      row(t('hints'), seg('hints', [['ask', t('ask')], ['always', t('always')], ['never', t('never')]])),
      row(t('logicDefault'), toggle('logicHints')),
      row(t('unlockAll'), toggle('unlockAll'))),
    card(t('secLook'),
      row(t('packColors'), toggle('packColors')),
      row(t('toolsRight'), toggle('toolsRight')),
      row(t('language'), langSel)),
    card(t('secSave'), saveSection()),
    card(t('secAbout'),
      h('p', { class: 'fine left' }, t('controls')),
      h('p', { class: 'fine left' }, t('musicNote')),
      /[?&]debug/.test(location.search) ? h('button', { class: 'btn', onClick: () => textureInspector(screen, header('3DS textures', optionsScreen)) }, '3DS textures (debug)') : null,
      h('p', { class: 'fine left' }, 'MomoGram ' + (window as any).MOMOGRAM_VERSION + ' · MIT · ' + t('noGameData')))));
}

export { ctx, CROSS };
