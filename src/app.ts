// MomoGram UI: home, level/puzzle selection, play screen, solved screen, packs and options.
import { solutionCount } from './game/unique';
import { oggLength } from './audio/fsb5';
import { bcstmLength } from './audio/bcstm';
import { fullTitle } from './packs/importers/ctr-picross';
import { MegaPairs, generateMega, megaSolutionCount, MEGA_GEN } from './game/mega';
import { Board, formatTime, FILL, CROSS } from './game/board';
import { BoardView } from './game/view';
import { PictureAnimator, thumbnail, PckGetter, addPictures } from './game/picture';
import { Pack, PackLevel, PackPuzzle, PackTheme, Lang, pickText, pickAny, songsOf, roleSongs, setRoleSongs, SongRole } from './packs/format';
import { pckFile, dsFromPack, dsTheme, DsPackMeta } from './rom/picrossds';
import { readEntries, packRev, newRev } from './packs/io';
import { storage, settings, saveSettings, getProgress, recordClear, getQuickSave, saveBoard, clearBoard, getBoard, resetProgress, packProgress, Medal, makeSave, importSave, isSaveFile, progressSummary, profiles, activeProfile, switchProfile, createProfile, renameProfile, deleteProfile, SaveFile, QuickSave, localStats, Mode, unpointed, setPoints } from './store';
import { puzzleRating, performance as perfScore, points, RatedRules } from './game/rating';
import { choose, confirmBox, askText, message, panel } from './ui/dialog';
export { choose };
import { t, setLang, lang, LANG_NAMES, hasTexts } from './i18n';
import { Gamepads } from './input';
import { openPackManager, storePacks, filesToEntries } from './ui/packs';
import * as Sync from './sync';
import { Audio as Snd } from './audio';
import { packSave, unpackSave, download } from './util/files';
import { themeColors, applyThemeCss, ThemeColors } from './packs/theme';
import { STARTER } from './packs/starter';
import { unpackPictures } from './rom/jtex';
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
  // My Nintendo Picross (the Zelda one) read before its title was made complete
  for (const p of ctx.packs) if (p.id.startsWith('ctr-') && fullTitle(p.title as Record<string, string>)) await storage.savePack(p);
  // desktop app started with --rom <file> (shortcuts, RecompLauncher): import that game
  if (new URLSearchParams(location.search).has('rom')) {
    try {
      const r = await fetch('/__rom');
      const name = decodeURIComponent(r.headers.get('x-file-name') || '') || (r.headers.get('content-type')?.includes('zip') ? 'game.zip' : 'game.nds');
      if (r.ok) setTimeout(async () => openedFiles([{ name, data: new Uint8Array(await r.arrayBuffer()) }]), 0);
    } catch (e) { console.warn('game from command line', e); }
  }
  home();
  setTimeout(backfillPoints, 1500);
  // installed web app: .momopack files opened with it (File Handling API, Chromium)
  (window as any).launchQueue?.setConsumer(async (p: { files?: Array<{ getFile(): Promise<File> }> }) => {
    const files = [];
    for (const h of p.files ?? []) { const f = await h.getFile(); files.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }); }
    if (files.length) openedFiles(files);
  });
  // a MomoGram server keeps the profile the same on every device: when it brings news, show them
  Sync.startAutoSync(() => { if (document.querySelector('.home')) home(); });
  // which packs have a newer version on the server (badges in the library)
  if (Sync.account()) Sync.serverPacks().then(() => { if (document.querySelector('.home')) home(); }).catch(() => {});
}

const DS_GROUPS: Record<string, Pack['title']> = {
  easy: { en: 'Easy', de: 'Leicht', ja: 'かんたん' }, normal: { en: 'Normal', de: 'Normal', ja: 'ノーマル' }, free: { en: 'Free', de: 'Frei', ja: 'フリー' },
};

/** import games or packs without the pack screen (opened from outside the app, old storage); returns what came in */
async function addGameFiles(files: Array<{ name: string; data: Uint8Array }>): Promise<Pack[]> {
  const found: Pack[] = [];
  for (const f of files) {
    try { found.push(...(await readEntries(await filesToEntries(f), lang(), t, ctx.packs)).made); }
    catch (e) { console.warn('import', f.name, e); }
  }
  if (found.length) ctx.packs = await storePacks(ctx.packs, found);
  return found;
}

/** files opened with MomoGram (desktop: double click / command line; installed web app: file handler) */
async function openedFiles(files: Array<{ name: string; data: Uint8Array }>) {
  const made = await addGameFiles(files);
  if (made.length) { home(); void message(t('imported', { list: made.map(p => pickAny(p.title, packLang())).join(', ') })); }
}

/** extras a pack needs before its lists are shown (Picross DS: the solved-picture animations) */
async function loadExtras(pack: Pack): Promise<void> {
  if (ctx.pcks.has(pack.id)) return;
  // daily puzzles show the pictures of their own games
  const origins = new Set(pack.levels.flatMap(l => l.puzzles.map(z => z.origin?.slice(0, z.origin.lastIndexOf('/')).replace(/@mega$/, ''))).filter((x): x is string => !!x && x !== pack.id));
  for (const o of origins) { const op = ctx.packs.find(p => p.id === o); if (op) await loadExtras(op); }
  if (pack.theme?.pictures) {
    const d = await storage.loadAsset(pack.id, 'pictures.bin').catch(() => undefined);
    if (d) addPictures(pack.id.replace(/@mega$/, ''), unpackPictures(d));
  }
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
  return h('div', { class: 'logo' + (settings.mega ? ' mega' : '') }, g, h('div', {},
    // "MEGA" is a stamp over the name: the logo keeps its size and place in both modes
    h('div', { class: 'logo-text' }, settings.mega ? h('span', { class: 'logo-mega', 'aria-label': 'Mega' }, 'MEGA') : null,
      h('div', { class: 'logo-name' }, 'MomoGram'),
      h('div', { class: 'tagline' }, t('tagline')))));
}

/** points for puzzles solved before points existed (from their medal and times); a little at a time */
// ---------------------------------------------------------------- updates
// The home screen looks for a newer MomoGram (at most every ten minutes, and when the app comes back to the
// front). The web version (also installed on the home screen) reloads into it with one tap; the Android and
// desktop apps carry their files inside, so they link to the download.
let newVersion: string | null = null, lastCheck = 0;
const RELEASES = 'https://github.com/Emil007/MomoGram/releases/latest';
const isWeb = () => /^https?:$/.test(location.protocol) && !(window as any).Capacitor?.isNativePlatform?.();
const newer = (a: string, b: string) => { const x = a.split(/[.-]/).map(Number), y = b.split(/[.-]/).map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
async function checkUpdate(force = false): Promise<void> {
  const mine = (window as any).MOMOGRAM_VERSION as string;
  if (mine === 'dev' || (!force && Date.now() - lastCheck < 600000)) return;
  lastCheck = Date.now();
  try {
    const url = isWeb() ? 'version.json' : 'https://emil007.github.io/MomoGram/version.json';
    const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
    const v = (await r.json())?.version;
    if (typeof v === 'string' && newer(v, mine)) newVersion = v;
  } catch { /* offline */ }
}
function showUpdate(slot: HTMLElement) {
  const draw = () => {
    slot.replaceChildren();
    if (!newVersion) return;
    slot.append(h('button', { class: 'btn update-banner', onClick: async () => {
      if (!isWeb()) { window.open(RELEASES, '_blank'); return; }
      try { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update(); } catch { /* reload anyway */ }
      location.reload();
    } }, h('b', {}, '⬆ ' + t('updateReady', { v: newVersion })), h('small', {}, isWeb() ? t('updateTap') : t('updateDownload'))));
  };
  draw();
  checkUpdate().then(() => { if (slot.isConnected) draw(); });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const slot = document.querySelector<HTMLElement>('.update-slot');
  if (slot) { lastCheck = 0; showUpdate(slot); }
});

/** the profile button: the name, and below it the PixElo of the mode being played (provisional: fewer than 15 rated solves) */
function profileChip(): HTMLElement {
  const st = localStats(curMode());
  const prov = st.rated < 15;
  return h('button', { class: 'btn profile-chip', onClick: () => profileDialog(home), title: t('profile') + (st.rated ? ' · ' + `${st.points} ${t('pointsShort')}` : '') },
    h('span', {}, '👤 ' + activeProfile().name),
    h('small', { class: 'elo-line' + (prov ? ' prov' : ''), title: prov ? t('provisional') : '' }, 'PixElo ' + (st.rated ? st.elo + (prov ? '?' : '') : '–')));
}

async function backfillPoints() {
  const todo = unpointed();
  if (!todo.length) return;
  const find = new Map<string, PackPuzzle>();
  for (const p of [STARTER, ...ctx.packs]) for (const v of [p, megaView(p)]) for (const l of v.levels) for (const z of l.puzzles) find.set(p.id + '/' + z.id, z);
  const out: Array<[string, string, number]> = [];
  for (let i = 0; i < todo.length; i++) {
    const [pid, pzid, pr] = todo[i];
    const z = find.get(pid + '/' + pzid);
    if (!z) continue; // a game not on this device: counted once it is
    const mega = pzid.endsWith(MEGA);
    out.push([pid, pzid, points(z.rows, mega, pr.medal, pr.times?.[RULES_OF[pr.medal ?? 'bronze'] as 'easy'] ?? pr.best, puzzleRating(z.rows, mega).par)]);
    if (i % 50 === 49) await new Promise(r => setTimeout(r, 0));
  }
  setPoints(out);
}

/** the switch between normal and Mega puzzles for the whole game */
function megaSwitch(): HTMLElement {
  const b = h('button', { class: 'mega-switch' + (settings.mega ? ' on' : ''), role: 'switch', 'aria-checked': String(settings.mega), title: t('megaHelp'),
    onClick: () => { settings.mega = !settings.mega; saveSettings(); home(); } },
    h('span', { class: 'ms-opt' + (settings.mega ? '' : ' cur') }, t('megaOff')),
    h('span', { class: 'ms-opt' + (settings.mega ? ' cur' : '') }, t('megaOn')));
  return b;
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
  void hashTracks();
  dailyToGames();
  const q = getQuickSave(curMode());
  const qPack = q ? quickTarget(q)?.pack : null;
  const packs = allPacks();
  let solved = 0, total = 0;
  for (const p of packs) { const [a, b] = countPack(p); solved += a; total += b; }

  const top = h('section', { class: 'home-top' },
    h('div', { class: 'chips' },
      megaSwitch(),
      h('span', { class: 'gap' }),
      profileChip(),
      syncChip()),
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

  const upd = h('div', { class: 'update-slot' });
  showUpdate(upd);
  screen(h('div', { class: 'home' }, upd, top, quick,
    h('div', { class: 'section-row' }, h('h2', { class: 'section-title' }, t('library')), arrange), lib,
    h('div', { class: 'menu small' },
      Sync.account() ? h('button', { class: 'btn', onClick: () => scoresScreen() }, '🏆 ' + t('scores')) : null,
      h('button', { class: 'btn', onClick: () => editorScreen() }, '✎ ' + t('editor')),
      h('button', { class: 'btn', onClick: () => optionsScreen() }, '⚙ ' + t('options'))),
    nowPlaying()));
}

// ---------------------------------------------------------------- library: folders, order, hidden games

interface LibPrefs { order: string[]; hidden: string[]; group: 'series' | 'system' | 'none'; view?: 'cards' | 'tiles' | 'list' }
function libPrefs(): LibPrefs {
  try { return { order: [], hidden: [], group: 'series', ...JSON.parse(localStorage.getItem('momogram.library') || '{}') }; } catch { return { order: [], hidden: [], group: 'series' }; }
}
function setLibPrefs(p: LibPrefs) { localStorage.setItem('momogram.library', JSON.stringify(p)); }
let libEdit = false;

/** series of a game, from its title (all Picross e games together, the Mario games, …) */
function seriesOf(p: Pack): string {
  const n = pickAny(p.title, 'en');
  // Jupiter's other Switch games (special editions, LogiartGrimoire, Nazarick, Kemono Friends, …): a folder of their own
  if (p.source.platform === 'Nintendo Switch' && !/^picross (s\d*\+?|e\d*)$/i.test(n.trim())) return 'Picross S Specials';
  const rules: Array<[RegExp, string]> = [
    [/^picross e\d*$/i, 'Picross e'], [/^picross s/i, 'Picross S'], [/^picross np/i, 'Picross NP'], [/^picross ds/i, 'Picross DS'],
    [/mario|^picross 2$/i, 'Mario'], [/pok[eé]mon/i, 'Pokémon'], [/club nintendo|my ?nintendo/i, 'Nintendo rewards'], [/tamori/i, 'Tamori'],
    // the picture logic games of other makers (Hudson, Success, …)
    [/sanrio|hello kitty/i, 'Sanrio'], [/puzzle iro iro/i, 'Puzzle Iro Iro'],
    [/illust logic|illu-logi|ds puzzler|challenge me|oekaki|illust puzzle/i, 'Illust Logic'],
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
  // the icon sits in a row with the system and year (like the icons of a folder), so the title has the full width
  return h('button', { class: 'btn game', style: col ? `--game:${col}` : undefined, onClick: onOpen },
    h('b', {}, pickAny(p.title, packLang())),
    h('div', { class: 'game-meta' }, hasIcon(p) ? iconCanvas(p.icon!) : null,
      h('small', {}, [p.source.platform, p.source.year].filter(Boolean).join(' · ') + (p.theme?.music ? ' · ♪' : ''))),
    h('div', { class: 'bar-outer slim' }, h('div', { class: 'bar-inner', style: `width:${b ? (a / b) * 100 : 0}%` })),
    h('small', { class: 'count' }, t('solvedCount', { a, b })),
    (Sync.knownServerRevs().get(p.id) ?? 0) > packRev(p) ? h('span', { class: 'update-badge', title: t('updateAvailable') }, '⬆') : null);
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
  el.classList.remove('v-cards', 'v-tiles', 'v-list');
  el.classList.add('v-' + (pr.view ?? 'cards'));
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
    ...(['series', 'system', 'none'] as const).map(m => h('button', { class: 'tab' + (pr.group === m ? ' on' : ''), onClick: () => { setLibPrefs({ ...pr, group: m }); renderLibrary(el, folder); } }, t('group_' + m)))),
    h('div', { class: 'lib-group' }, h('span', {}, t('viewAs')),
      ...(['cards', 'tiles', 'list'] as const).map(m => h('button', { class: 'tab' + ((pr.view ?? 'cards') === m ? ' on' : ''), onClick: () => { setLibPrefs({ ...pr, view: m }); renderLibrary(el, folder); } }, t('view_' + m)))));
}

/** an icon with a picture on it (some files have a blank one: all white, or all one colour) */
const iconCache = new Map<string, boolean>();
function hasIcon(p: Pack): boolean {
  const ic = p.icon;
  if (!ic) return false;
  let v = iconCache.get(ic.rgba);
  if (v === undefined) {
    const bin = atob(ic.rgba);
    const seen = new Set<number>();
    for (let i = 0; i + 3 < bin.length && seen.size < 3; i += 4) {
      if (bin.charCodeAt(i + 3) < 32) continue;
      seen.add((bin.charCodeAt(i) >> 3) << 10 | (bin.charCodeAt(i + 1) >> 3) << 5 | bin.charCodeAt(i + 2) >> 3);
    }
    v = seen.size >= 3;
    iconCache.set(ic.rgba, v);
  }
  return v;
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
    h('div', { class: 'folder-tabs' }, ...packs.slice(0, 4).map(p => hasIcon(p) ? iconCanvas(p.icon!) : h('i', { style: p.theme?.palette ? `--game:${themeColors(p.theme.palette).accent}` : undefined }))),
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
  return h('div', { class: 'row' }, h('button', { class: 'btn ghost', onClick: async () => { if (await confirmBox(t('confirmReset'), t('resetProgress'), true)) { resetProgress(pack.id); rerender(); } } }, t('resetProgress')));
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
      h('small', {}, sizes.length === 1 ? sizes[0] : `${sizes[0]} – ${sizes[sizes.length - 1]}`),
      ...(megaLevelBadge(lv) ? [megaLevelBadge(lv)!] : []));
  };
  const showPuzzle = (p: PackPuzzle, i: number) => {
    const pr = getProgress(pack.id, p.id);
    const name = pr.cleared ? pickText(p.name, packLang()) : '';
    info.replaceChildren(pr.cleared ? thumbnail(p, pck, 48, pack.id) : h('span', { class: 'qmark' }, '?'),
      h('b', {}, `${t('puzzleNo')} ${i + 1}` + (name ? ` · ${name}` : '')),
      h('small', {}, `${p.width}×${p.height}` + (pr.best !== undefined ? ` · ${t('best')} ${formatTime(pr.best)}` : '') + (pr.underLimit ? ' ★' : '')),
      // the same small chip as the level summary, so the strip keeps its height
      ...(megaLevelBadge({ ...lv, puzzles: [p] }) ? [megaLevelBadge({ ...lv, puzzles: [p] })!] : []));
  };
  showLevel();
  lv.puzzles.forEach((p, i) => {
    const pr = getProgress(pack.id, p.id);
    const tile = h('button', { class: 'btn puzzle' + (pr.cleared ? ' cleared' : ''), onClick: () => puzzleStart(pack, lv, i, () => puzzleList(pack, lv, back)),
      onMouseenter: () => showPuzzle(p, i), onFocus: () => showPuzzle(p, i), onMouseleave: () => showLevel(),
      'aria-label': `${t('puzzleNo')} ${i + 1}` });
    if (pr.cleared) tile.append(thumbnail(p, pck, 64, pack.id));
    else tile.append(h('span', { class: 'qmark' }, '?'));
    tile.append(h('small', {}, pr.cleared ? (pickText(p.name, packLang()) || `${p.width}×${p.height}`) : `${p.width}×${p.height}`));
    if (pr.best !== undefined) tile.append(h('em', {}, formatTime(pr.best)));
    tile.append(h('span', { class: 'num' }, String(i + 1)));
    if (p.exclusive) tile.append(h('span', { class: 'excl', title: t('exclusive', { r: p.exclusive }) }, p.exclusive));
    if (getBoard(pack.id, lv.id, p.id)) tile.append(h('span', { class: 'inprogress', title: t('continue') }, '✎'));
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

/** whether a puzzle has more than one solution (worked out once per pattern) */
const solutionCounts = new Map<string, 0 | 1 | 2>();
function solutionCountOf(rows: string[], mega: MegaPairs | null = null): 0 | 1 | 2 {
  const k = rows.join('/') + (mega ? '|' + JSON.stringify(mega) : '');
  let c = solutionCounts.get(k);
  if (c === undefined) { c = mega ? megaSolutionCount(rows, mega, 400) : solutionCount(rows, 400); solutionCounts.set(k, c); }
  return c;
}

/** between the list and the board: the puzzle, its source, your results, the difficulty, Start */
function puzzleStart(pack: Pack, lv: PackLevel, i: number, back: () => void) {
  usePack(pack, 'menu');
  const pz = lv.puzzles[i];
  const pr = getProgress(pack.id, pz.id);
  const pck = pckOf(pack);
  const name = pr.cleared ? pickText(pz.name, packLang()) : '';
  const pic = pr.cleared ? thumbnail(pz, pck, 160, pack.id) : h('div', { class: 'qbig', style: `aspect-ratio:${pz.width}/${pz.height}` }, '?');
  const saved = getBoard(pack.id, lv.id, pz.id);
  const go = () => play(pack, lv, i, back);
  const nav = (d: number) => { const j = i + d; if (j >= 0 && j < lv.puzzles.length) puzzleStart(pack, lv, j, back); };
  const stat = (label: string, value: Node | string) => h('div', { class: 'stat' }, h('small', {}, label), h('b', {}, value));
  screen(header(pickAny(lv.title, packLang()), back), h('div', { class: 'pstart' },
    h('div', { class: 'pstart-pic' },
      h('button', { class: 'rbtn ghost', disabled: i === 0 ? true : undefined, 'aria-label': t('prev'), onClick: () => nav(-1) }, icon('prev')),
      h('button', { class: 'pic-frame', 'aria-label': t('start'), onClick: go }, pic),
      h('button', { class: 'rbtn ghost', disabled: i + 1 >= lv.puzzles.length ? true : undefined, 'aria-label': t('nextPuzzle'), onClick: () => nav(1) }, icon('next'))),
    h('h2', {}, `${t('puzzleNo')} ${i + 1}` + (name ? ` · ${name}` : '')),
    h('p', { class: 'pstart-from' }, (pz.from ?? `${pickAny(pack.title, packLang())} · ${pickAny(lv.title, packLang())}`) + (pz.exclusive ? ' · ' + t('exclusive', { r: pz.exclusive }) : '')),
    h('div', { class: 'stats' },
      stat(t('size'), `${pz.width}×${pz.height}`),
      stat(t('level'), h('span', { class: 'diff d' + puzzleLevel(pz) }, t('diff' + puzzleLevel(pz)))),
      stat(t('best'), pr.best !== undefined ? formatTime(pr.best) : '–'),
      stat(t('medal'), pr.medal ? medalEl(pr.medal, true) : '–')),
    fastestRow(pack.id, pz.id),
    difficultyPicker(lv, () => puzzleStart(pack, lv, i, back)),
    h('p', { class: 'rules' }, rulesText(rulesFor(lv))),
    solutionCountOf(pz.rows, megaPairsOf(pz)) === 2 ? h('p', { class: 'warn-multi' }, '⚠ ' + t('multiSolution')) : null,
    megaBadge(pz),
    h('button', { class: 'btn primary big start', onClick: go }, icon('play'), saved ? t('continue') + ' · ' + formatTime(saved.state.elapsedMs + saved.state.penaltyMs) : t('start')),
    saved ? h('button', { class: 'btn ghost', onClick: () => { clearBoard(pack.id, lv.id, pz.id); play(pack, lv, i, back, undefined, true); } }, t('restart')) : null));
}

/**
 * The fill/cross switch: the active tool big in the middle, the other one small in a circle at the upper right,
 * and an arrow from the small one to the big one. A tap swaps the two (CSS moves them).
 */
function toolSwitchArt(): Element {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="switch-art" viewBox="0 0 62 62" aria-hidden="true">
    <path class="arrow" d="M53.6 24.0L53.5 24.9L53.4 25.7L53.3 26.6L53.2 27.4L53.0 28.1L52.8 28.9L52.6 29.6L52.4 30.2L52.1 30.9L51.8 31.5L51.5 32.0L51.2 32.6L50.9 33.1L50.5 33.6L50.1 34.0L49.7 34.5L49.3 34.9L48.9 35.2L48.4 35.6L48.0 35.9L47.5 36.2L47.0 36.5L46.5 36.7L45.9 36.9L47.5 40.2L48.1 39.8L48.8 39.3L49.3 38.9L49.9 38.4L50.4 37.8L50.9 37.3L51.4 36.7L51.8 36.2L52.2 35.6L52.5 34.9L52.9 34.3L53.2 33.6L53.4 32.9L53.6 32.2L53.8 31.5L54.0 30.7L54.2 29.9L54.3 29.2L54.4 28.3L54.4 27.5L54.5 26.7L54.5 25.8L54.4 24.9L54.4 24.0ZM42 40L45.4 34.2L48.0 42.8Z"/>
    <circle class="badge" cx="50" cy="12" r="10.5"/>
    <g class="tool-f"><rect x="-11" y="-11" width="22" height="22" rx="4"/></g>
    <g class="tool-x"><path d="M-10 -10L10 10M10 -10L-10 10"/></g>
  </svg>`;
  return tpl.content.firstElementChild!;
}

/** home: is this profile in sync with the server? tap to sync now */
function syncChip(): HTMLElement | null {
  const gone = Sync.loggedOut();
  if (!Sync.account() && gone) return h('button', { class: 'btn sync-chip bad', onClick: () => optionsScreen() }, '⚠ ' + t('loggedOutChip'));
  if (!Sync.account()) return null;
  const b = h('button', { class: 'btn sync-chip', onClick: () => Sync.sync() });
  const draw = () => {
    const a = Sync.account(), s = Sync.syncState();
    if (!a) {
      // the server logged this profile out: say so (tap → Options)
      if (Sync.loggedOut()) { b.className = 'btn sync-chip bad'; b.textContent = '⚠ ' + t('loggedOutChip'); b.onclick = () => optionsScreen(); }
      else b.remove();
      return;
    }
    const ago = a.synced ? Math.round((Date.now() - Date.parse(a.synced)) / 60000) : -1;
    b.className = 'btn sync-chip' + (s.state === 'error' ? ' bad' : '');
    // short: "Sync", "OK", "5 min" (the details are in the tooltip)
    const err = s.state === 'error' ? serverError(new Sync.ServerError(s.error, 0)) : '';
    b.textContent = s.state === 'syncing' ? '☁ Sync' : s.state === 'error' ? '⚠ ' + t('syncErrShort') : '☁ ' + (ago < 0 ? '–' : ago < 1 ? 'OK' : ago < 60 ? ago + ' min' : ago < 48 * 60 ? Math.round(ago / 60) + ' h' : Math.round(ago / 1440) + ' d');
    b.title = t('loggedIn', { name: a.name }) + (err ? '\n' + err : ago >= 0 ? '\n' + (ago < 1 ? t('syncedNow') : t('syncedAgo', { n: ago < 60 ? ago + ' min' : Math.round(ago / 60) + ' h' })) : '');
  };
  draw();
  Sync.onSyncChange(() => { if (b.isConnected) draw(); });
  return b;
}

/** the best times of everyone on the server for one puzzle (this profile's own time from here, it may be newer) */
function fastestRow(packId: string, puzzleId: string): HTMLElement | null {
  const sc = Sync.scores(), me = Sync.account();
  if (!sc || !me) return null;
  const list = (sc.best[packId + '/' + puzzleId] ?? []).filter(([n]) => n !== me.name);
  const myProgress = getProgress(packId, puzzleId), mine = strictestTime(myProgress);
  if (mine) list.push([me.name, mine[0], mine[1], myProgress.medal ?? '']);
  if (!list.length) return null;
  // times under stricter rules come first: a fast Easy time doesn't beat a Hard one
  list.sort((a, b) => (RULE_RANK[a[2] ?? ''] ?? 3) - (RULE_RANK[b[2] ?? ''] ?? 3) || a[1] - b[1]);
  return h('p', { class: 'fastest' }, '🏆 ' + t('fastest') + ': ',
    ...list.slice(0, 3).map(([n, ms, r, m], k) => h('span', { class: n === me.name ? 'me' : '' }, `${k + 1}. ${n} ${formatTime(ms)}`,
      r ? h('i', { class: 'rule-tag r-' + r, title: rulesName(r as PlayRules) }, rulesName(r as PlayRules).slice(0, 1)) : null,
      m ? medalEl(m as Medal) : null)));
}
const RULE_RANK: Record<string, number> = { free: 0, hard: 0, normal: 1, easy: 2 };
/** a puzzle's best time under the strictest rules it was solved with (older progress: its best time, rules unknown) */
function strictestTime(p: { best?: number; times?: Partial<Record<string, number>> }): [number, string] | null {
  let pick: [number, string] | null = null;
  for (const [r, ms] of Object.entries(p.times ?? {})) if (ms !== undefined && (!pick || (RULE_RANK[r] ?? 3) < (RULE_RANK[pick[1]] ?? 3) || ((RULE_RANK[r] ?? 3) === (RULE_RANK[pick[1]] ?? 3) && ms < pick[0]))) pick = [ms, r];
  return pick ?? (p.best !== undefined ? [p.best, ''] : null);
}

/**
 * Everyone on the server (up to 10 players), for the mode that is on (normal and Mega are two games): ranked by
 * points, PixElo or puzzles solved; medals; and per game.
 */
let scoreSort: 'points' | 'elo' | 'solved' = 'points';
async function scoresScreen() {
  const body = h('div', { class: 'scores' });
  const mode = curMode();
  screen(header(t('scores') + (mode === 'mega' ? ' · MEGA' : ''), home), body);
  let sc = Sync.scores(), note = '';
  const draw = () => {
    body.innerHTML = '';
    const me = Sync.account()?.name;
    type Row = Sync.ScoreStats & { name: string };
    const of = (u: NonNullable<typeof sc>['users'][0]): Row => ({ name: u.name, ...(u.modes?.[mode] ?? (mode === 'normal' ? u : { solved: 0, medals: {}, packs: {}, time: 0 })) });
    let users: Row[] = sc ? sc.users.map(of) : [];
    // this profile's own numbers come from this device: they may be newer than the server's
    const mine: Row = { ...(users.find(u => u.name === me) ?? {}), ...localStats(mode), name: me ?? activeProfile().name };
    users = [...users.filter(u => u.name !== mine.name), mine];
    const key = (u: Row) => scoreSort === 'points' ? [u.points ?? 0, u.solved] : scoreSort === 'elo' ? [(u.rated ?? 0) ? u.elo ?? 0 : -1, u.rated ?? 0] : [u.solved, u.medals.platinum ?? 0, u.medals.gold ?? 0, -u.time];
    users.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; });
    body.append(h('div', { class: 'score-tabs' }, ...([['points', t('pointsTab')], ['elo', 'PixElo'], ['solved', t('solvedTab')]] as const).map(([k, label]) =>
      h('button', { class: 'chip' + (scoreSort === k ? ' on' : ''), onClick: () => { scoreSort = k; draw(); } }, label))));
    if (!users.some(u => u.solved)) { body.append(h('p', { class: 'fine' }, t('noScores'))); return; }
    const medal = (m: string, n: number | undefined) => n ? h('span', { class: 'mcount' }, medalEl(m as Medal, false), '×' + n) : null;
    const main = (u: Row) => scoreSort === 'points' ? String(u.points ?? 0) : scoreSort === 'elo' ? (u.rated ? String(u.elo) : '–') : String(u.solved);
    body.append(h('ol', { class: 'ranking' }, ...users.map((u, k) => h('li', { class: u.name === me ? 'me' : '' },
      h('span', { class: 'rank' }, String(k + 1)),
      h('div', { class: 'who' }, h('b', {}, u.name),
        h('small', {}, medal('platinum', u.medals.platinum), medal('gold', u.medals.gold), medal('silver', u.medals.silver), medal('bronze', u.medals.bronze)),
        h('small', { class: 'extra' }, [
          scoreSort !== 'points' ? `${u.points ?? 0} ${t('pointsShort')}` : '',
          scoreSort !== 'elo' && u.rated ? `PixElo ${u.elo}` : '',
          scoreSort === 'elo' && u.rated ? t('peakN', { n: u.peak ?? u.elo ?? 0 }) + (u.rated < 15 ? ' · ' + t('provisional') : '') : '',
          scoreSort !== 'solved' ? t('solvedN', { n: u.solved }) : '',
          u.week ? t('thisWeek', { n: u.week }) : '', u.records ? t('recordsN', { n: u.records }) : ''].filter(Boolean).join(' · '))),
      h('b', { class: 'num' }, main(u))))));
    // per game: the installed packs anyone has played (a column per player: up to 10, the table scrolls sideways)
    const packs = allPacks().filter(p => users.some(u => u.packs?.[p.id]));
    if (packs.length) {
      body.append(h('h2', { class: 'section-title' }, t('perGame')), h('div', { class: 'score-table' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}), ...users.map(u => h('th', { class: u.name === me ? 'me' : '', title: u.name }, u.name)))),
        h('tbody', {}, ...packs.map(p => {
          const total = countPack(p)[1];
          const top = Math.max(...users.map(u => u.packs?.[p.id] ?? 0));
          return h('tr', {}, h('th', {}, pickAny(p.title, packLang())),
            ...users.map(u => { const n = u.packs?.[p.id] ?? 0; return h('td', { class: (n && n === top ? 'top' : '') + (u.name === me ? ' me' : '') }, n ? `${n}/${total}` : '–'); }));
        })))));
    }
    if (note) body.append(h('p', { class: 'fine' }, note));
  };
  draw();
  if (!Sync.account()) return;
  try { await Sync.sync(); sc = await Sync.refreshScores(); note = ''; } catch { note = t('scoresOffline'); }
  if (body.isConnected) draw();
}

/** where a paused puzzle lives: its pack, or (daily puzzles) a pack made of the puzzle stored with the save */
function quickTarget(q: QuickSave): { pack: Pack; lv: PackLevel; i: number; lone: boolean } | null {
  const pack = allPacks().find(p => p.id === q.packId);
  const lv = pack?.levels.find(l => l.id === q.levelId);
  const i = lv?.puzzles.findIndex(p => p.id === q.puzzleId) ?? -1;
  if (pack && lv && i >= 0) return { pack, lv, i, lone: false };
  if (!q.puzzle) return null;
  const one: PackLevel = { id: q.levelId, title: q.level?.title ?? { en: '' }, rules: q.level?.rules ?? 'normal', puzzles: [q.puzzle] };
  return { pack: { format: 'momogram-pack', version: 1, id: q.packId, title: q.packTitle ?? { en: t('daily') }, source: { game: 'MomoGram', platform: 'MomoGram' }, levels: [one] }, lv: one, i: 0, lone: true };
}

async function resumeQuick() {
  const q = getQuickSave(curMode());
  if (!q) return home();
  const tg = quickTarget(q);
  // the game isn't on this device (yet): keep the save for when it is
  if (!tg) return home();
  await loadExtras(tg.pack);
  play(tg.pack, tg.lv, tg.i, tg.lone ? home : () => openPack(tg.pack, home), q.state);
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
function allPacks(): Pack[] { const ps = [STARTER, ...ctx.packs]; return ps.map(settings.mega ? megaView : plainView); }

// ---------------------------------------------------------------- Mega mode
// The whole game switches: every game shows its puzzles as Mega puzzles. A puzzle's Mega version is the game's
// own (PICROSS e6–e9, the Switch games, S+ for every e game) or chosen by MomoGram (game/mega.ts: the same on
// every device). Mega puzzles are puzzles of their own for progress and scores: their ids end in "@mega".
const MEGA = '@mega';
const curMode = (): Mode => (settings.mega ? 'mega' : 'normal');
/** which rules a medal is earned with (its time is what points look at) */
const RULES_OF: Record<string, string> = { bronze: 'easy', silver: 'normal', gold: 'free', platinum: 'free' };
const views = new WeakMap<Pack, Pack>(), megaViews = new WeakMap<Pack, Pack>(), originals = new WeakMap<Pack, Pack>();
const keep = (levels: PackLevel[]) => levels.filter(l => l.puzzles.length);
function plainView(p: Pack): Pack {
  if (!p.levels.some(l => l.puzzles.some(z => z.megaOnly))) return p;
  let v = views.get(p);
  if (!v) { v = { ...p, levels: keep(p.levels.map(l => ({ ...l, puzzles: l.puzzles.filter(z => !z.megaOnly) }))) }; views.set(p, v); originals.set(v, p); }
  return v;
}
function megaView(p: Pack): Pack {
  let v = megaViews.get(p);
  if (!v) {
    v = { ...p, levels: keep(p.levels.map(l => ({ ...l, puzzles: l.puzzles.map(z => ({ ...z, id: z.id + MEGA, origin: z.origin && z.origin + MEGA })) }))) };
    megaViews.set(p, v); originals.set(v, p);
  }
  return v;
}
/** the stored pack behind a view (for changes that are saved) */
const original = (p: Pack) => originals.get(p) ?? p;

/** where a Mega puzzle's mega numbers come from: the game itself, or MomoGram */
function megaBadge(pz: PackPuzzle): HTMLElement | null {
  if (!pz.id.endsWith(MEGA)) return null;
  const own = !!pz.mega, none = !own && !megaPairsOf(pz);
  return h('p', { class: 'mega-src ' + (own ? 'src-game' : 'src-momo'), title: own ? t('megaFromGameHelp') : t('megaByMomoHelp') },
    own ? '🎮 ' + t('megaFromGame') : none ? t('megaNone') : '✨ ' + t('megaByMomo'));
}
function megaLevelBadge(lv: PackLevel): HTMLElement | null {
  if (!lv.puzzles[0]?.id.endsWith(MEGA)) return null;
  const own = lv.puzzles.filter(z => z.mega).length;
  const k = own === lv.puzzles.length ? 'game' : own ? 'mixed' : 'momo';
  return h('span', { class: 'mega-src small src-' + k }, k === 'game' ? '🎮 ' + t('megaFromGame') : k === 'momo' ? '✨ ' + t('megaByMomo') : `🎮 ${own} · ✨ ${lv.puzzles.length - own}`);
}

/** the pairs a puzzle is played with in Mega mode: the game's own, else MomoGram's (kept on this device) */
const MEGA_KEY = 'momogram.megaPairs';
let megaCache: Record<string, MegaPairs | null> = (() => { try { return JSON.parse(localStorage.getItem(MEGA_KEY) || '{}'); } catch { return {}; } })();
function megaPairsOf(pz: PackPuzzle): MegaPairs | null {
  if (!pz.id.endsWith(MEGA)) return null;
  if (pz.mega) return pz.mega;
  // keyed by the picture (and the version of the choice), so it is shared by every game with this picture
  let hsh = 2166136261;
  for (const c of pz.rows.join('/')) { hsh ^= c.charCodeAt(0); hsh = Math.imul(hsh, 16777619); }
  const k = `${MEGA_GEN}:${pz.width}x${pz.height}:${(hsh >>> 0).toString(36)}`;
  if (!(k in megaCache)) {
    megaCache[k] = generateMega(pz.rows);
    try { localStorage.setItem(MEGA_KEY, JSON.stringify(megaCache)); } catch { /* full */ }
  }
  return megaCache[k];
}

// ---------------------------------------------------------------- music & colours of a game

type Track = { pack: Pack; ref: string };
/** in-game tracks a pack offers */
function packTracks(pack: Pack): Track[] {
  if (!pack.theme || !settings.packMusic) return [];
  return roleSongs(pack.theme, 'play').filter(ref => !isOff(pack, ref)).map(ref => ({ pack, ref }));
}
/** a song the player switched off in the sound test */
const isOff = (pack: Pack, ref: string) => !!pack.theme?.off?.includes(ref);
// ---- the same song in several games (every 3DS game has the same title music …) counts as one track ----
// A music file's content hash, per pack and file; computed once in the background, kept on this device.
const HASH_KEY = 'momogram.trackHash2';
let fileHash: Record<string, string> = (() => { try { return JSON.parse(localStorage.getItem(HASH_KEY) || '{}'); } catch { return {}; } })();
let hashing = false;
/** hash the music files not hashed yet (one at a time, so the app stays responsive) */
async function hashTracks() {
  if (hashing || !crypto.subtle) return;
  hashing = true;
  try {
    for (const p of allPacks()) {
      const files = new Set(songsOf(p.theme).map(r => r.split('#')[0]));
      for (const f of files) {
        const k = p.id + '/' + f;
        const rev = String(packRev(p));
        if (fileHash[k]?.startsWith(rev + '|')) continue; // a new version of a pack may have other music
        // stored files are linked by their content hash: no need to read them
        let sum = await storage.assetHash(p.id, f).catch(() => undefined);
        if (!sum) {
          const d = await storage.loadAsset(p.id, f).catch(() => undefined);
          if (!d) continue;
          sum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', d as BufferSource)), b => b.toString(16).padStart(2, '0')).join('');
          await new Promise(r => setTimeout(r, 50));
        }
        fileHash[k] = rev + '|' + sum.slice(0, 16);
        try { localStorage.setItem(HASH_KEY, JSON.stringify(fileHash)); } catch { /* full */ }
      }
    }
    // files stored before linking: linked once, so copies in several games take the space of one
    if (!localStorage.getItem('momogram.assetsLinked')) {
      await storage.linkAssets();
      localStorage.setItem('momogram.assetsLinked', '1');
    }
  } finally { hashing = false; }
}
/** what a track sounds like: equal for the same song in different games */
function trackKey(packId: string, ref: string): string {
  const [file, seq] = ref.split('#');
  return (fileHash[packId + '/' + file]?.split('|')[1] ?? packId + '/' + file) + (seq ? '#' + seq : '');
}
const idKey = (id: string) => { const i = id.indexOf('/'); return i < 0 ? id : trackKey(id.slice(0, i), id.slice(i + 1)); };
/** one entry per song (the first game that has it) */
function uniqTracks(list: Track[]): Track[] {
  const seen = new Set<string>();
  return list.filter(x => { const k = trackKey(x.pack.id, x.ref); if (seen.has(k)) return false; seen.add(k); return true; });
}
/** the games that have this song */
function gamesWith(id: string): Pack[] {
  const k = idKey(id);
  return allPacks().filter(p => songsOf(p.theme).some(ref => trackKey(p.id, ref) === k));
}

let lastTrack = '';
/** music while playing: random from this game (default), random from all games, or the game's main track */
function playMusicFor(pack: Pack) {
  applyThemeCss(root(), packColors(pack));
  let pool: Track[];
  if (settings.musicMode === 'fixed') pool = packTracks(pack).slice(0, 1);
  else if (settings.musicMode === 'random-all' || !packTracks(pack).length) pool = allPacks().flatMap(packTracks); // games without music borrow
  else pool = packTracks(pack);
  pool = uniqTracks(pool);
  if (!pool.length) { Snd.stop(); return; }
  const choices = pool.length > 1 ? pool.filter(x => trackKey(x.pack.id, x.ref) !== lastTrack) : pool;
  const tr = choices[Math.floor(Math.random() * choices.length)];
  lastTrack = trackKey(tr.pack.id, tr.ref);
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
  // several songs for a role: one of them at random
  const refs = roleSongs(pack?.theme, role).filter(r => pack && !isOff(pack, r));
  const ref = refs[Math.floor(Math.random() * refs.length)];
  if (pack && ref && settings.packMusic) Snd.playPack(pack.id, ref, loop);
}

/** readable name of a track ref: "stage_jazz_SEQ" → "stage jazz", "Bgm_Home.bcstm" → "Bgm Home", "x#gb:5" → "Song 5" */
function trackName(ref: string): string {
  const [file, seq] = ref.split('#');
  const m = seq?.match(/^(gb|spc|snes):(\d+)/i);
  if (m) return `Song ${m[1] === 'gb' ? +m[2] : (+m[2] & 0x3f) + 1}`;
  return (seq ?? file).replace(/\.(bcstm|sdat|gbsnd|spc|ogg)$/i, '').replace(/_SEQ$/i, '').replace(/[_-]+/g, ' ').trim();
}

/** "♪ track · game" on the home screen; tapping it skips to another track from all games */
function nowPlaying(): HTMLElement {
  const el = h('button', { class: 'now-playing', title: t('skipTrack'), onClick: () => {
    const cur = idKey(Snd.current());
    const pool = uniqTracks(allPacks().flatMap(p => [...menuTracks(p), ...packTracks(p)])).filter(x => trackKey(x.pack.id, x.ref) !== cur);
    if (!pool.length) return;
    const tr = pool[Math.floor(Math.random() * pool.length)];
    Snd.playPack(tr.pack.id, tr.ref);
  } });
  const show = (id: string) => {
    const i = id.indexOf('/'), pack = allPacks().find(p => p.id === id.slice(0, i));
    el.hidden = !id || !pack;
    // the same song in other games: "PICROSS e2 +4"
    const others = id && pack ? gamesWith(id).filter(p => p.id !== pack.id).length : 0;
    el.title = id && pack && others ? t('skipTrack') + '\n' + gamesWith(id).map(p => pickAny(p.title, packLang())).join(', ') : t('skipTrack');
    el.replaceChildren(h('span', { class: 'np-note' }, '♪'), h('b', {}, id ? trackName(id.slice(i + 1)) : ''), h('small', {}, pack ? pickAny(pack.title, packLang()) + (others ? ` +${others}` : '') : ''), h('span', { class: 'np-skip' }, '⏭'));
  };
  // drawn at once (the element isn't on the page yet), then on every change while it is shown
  show(Snd.current());
  const on = (id: string) => { if (el.isConnected) show(id); else Snd.offChange(on); };
  queueMicrotask(() => Snd.onChange(on));
  return el;
}

/** title and menu tracks of a game */
function menuTracks(pack: Pack): Track[] {
  if (!pack.theme || !settings.packMusic) return [];
  return [...new Set([...roleSongs(pack.theme, 'title'), ...roleSongs(pack.theme, 'menu')].filter(r => !isOff(pack, r)))].map(ref => ({ pack, ref }));
}

/**
 * Menu music: a random title / menu track — from the game whose screens are open (unless "random from all
 * games" is set), on the home screen from all games. A track that fits keeps playing between menus.
 */
function menuMusic(pack: Pack | null = null, fresh = false) {
  let pool = pack && settings.musicMode !== 'random-all' ? menuTracks(pack) : [];
  if (!pool.length) pool = allPacks().flatMap(menuTracks);
  if (!pool.length) { Snd.stop(); return; }
  // the same song from another game also fits: it keeps playing
  const cur = idKey(Snd.current());
  if (!fresh && pool.some(x => trackKey(x.pack.id, x.ref) === cur)) return;
  pool = uniqTracks(pool);
  if (fresh && pool.length > 1) pool = pool.filter(x => trackKey(x.pack.id, x.ref) !== cur);
  const tr = pool[Math.floor(Math.random() * pool.length)];
  Snd.playPack(tr.pack.id, tr.ref);
}

// ---------------------------------------------------------------- daily nonogram

/** seeded random numbers (the same daily selection all day) */
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

/** every puzzle of the visible games, with where it comes from */
function puzzlePool(stable = false): Array<{ pack: Pack; lv: PackLevel; i: number }> {
  const out: Array<{ pack: Pack; lv: PackLevel; i: number }> = [];
  // the daily puzzles must not change when the library is arranged differently: then the packs go by id
  const packs = stable ? libraryPacks().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : libraryPacks();
  for (const p of packs) for (const lv of p.levels) lv.puzzles.forEach((z, i) => { if (z.rows.some(r => r.includes('#'))) out.push({ pack: p, lv, i }); });
  return out;
}

/** n puzzles of a measured difficulty, drawn at random (difficulty is computed only for the ones looked at) */
function drawPuzzles(rand: () => number, level: 1 | 2 | 3, n: number, skip = new Set<string>(), stable = false) {
  const pool = puzzlePool(stable);
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

/** a short id for a puzzle's pattern (FNV-1a, 2 × 32 bit) */
function patternId(rows: string[]): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ rows.length;
  for (const ch of rows.join('/')) { const c = ch.charCodeAt(0); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c, 0x5bd1e995) >>> 0; }
  return a.toString(36) + b.toString(36);
}

const fromText = (e: { pack: Pack; lv: PackLevel }) => `${pickAny(e.pack.title, packLang())} · ${pickAny(e.lv.title, packLang())}`;

/**
 * Daily puzzles solved before they counted in their own game too (MomoGram < 0.13): find the game's puzzle by
 * its pattern and record the solve there. Runs once per profile and game list change; does nothing twice.
 */
let dailyChecked = '';
function dailyToGames() {
  const done = packProgress('daily').filter(([, p]) => p.cleared && p.best !== undefined);
  const key = activeProfile().id + ':' + allPacks().length + ':' + done.length;
  if (!done.length || key === dailyChecked) return;
  dailyChecked = key;
  const byPattern = new Map<string, [string, string]>();
  for (const pk of allPacks()) if (pk.id !== 'daily') for (const lv of pk.levels) for (const pz of lv.puzzles) {
    const k = patternId(pz.rows);
    if (!byPattern.has(k)) byPattern.set(k, [pk.id, pz.id]);
  }
  for (const [id, p] of done) {
    const m = id.match(/^daily-\d+-(.+)$/), target = m && byPattern.get(m[1]);
    if (!target || getProgress(target[0], target[1]).cleared) continue;
    const rules = (['hard', 'normal', 'easy'] as const).find(r => p.times?.[r] !== undefined);
    recordClear(target[0], target[1], rules ? p.times![rules]! : p.best!, !!p.underLimit, p.medal, rules);
  }
}

/** 15 puzzles a day, 5 per difficulty, from all visible games; solved ones are saved for the day */
async function daily() {
  const d = new Date();
  const seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const rand = rng(seed), seen = new Set<string>();
  const levels: PackLevel[] = ([1, 2, 3] as const).map(level => ({
    id: `daily-${seed}-d${level}`, title: { en: t('diff' + level) }, rules: 'normal' as const,
    // a daily puzzle is known by its pattern: the same puzzle has the same id on every device and for everyone
    // (each device draws from its own games, so the lists can differ)
    puzzles: drawPuzzles(rand, level, 5, seen, true).map(e => ({ ...e.lv.puzzles[e.i], id: `daily-${seed}-${patternId(e.lv.puzzles[e.i].rows)}`, from: fromText(e), origin: `${e.pack.id}/${e.lv.puzzles[e.i].id}`, name: undefined })),
  })).filter(l => l.puzzles.length);
  if (!levels.length) return;
  // coloured pictures of the games the puzzles come from
  for (const p of libraryPacks()) if (p.theme?.pictures) await loadExtras(p);
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

function play(pack: Pack, lv: PackLevel, index: number, back: () => void, restore?: any, fresh = false) {
  const pz = lv.puzzles[index];
  // a board left earlier is picked up again
  if (!restore && !fresh) restore = getBoard(pack.id, lv.id, pz.id)?.state;
  const rules = rulesFor(lv);
  const board = new Board(pz.rows, rules, megaPairsOf(pz));
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
  const toolBtn = h('button', { class: 'rbtn tool-toggle', title: t('fill'), 'aria-label': t('fill'), onClick: () => setTool(view.tool === 'mark' ? lastTool : view.tool === 'fill' ? 'cross' : 'fill') },
    toolSwitchArt());
  // zoom: a tap zooms in or out; held and moved, the button steers the zoomed view like a joystick (the further
  // from where it was pressed, the faster)
  const lensBtn = h('button', { class: 'rbtn', title: t('zoomHold'), 'aria-label': t('zoom') }, icon('zoom'));
  {
    let start: { x: number; y: number; id: number } | null = null, stick = { x: 0, y: 0 }, steering = false, raf = 0;
    const tick = () => {
      const d = Math.hypot(stick.x, stick.y), dead = 10;
      if (d > dead) { const sp = Math.min(1, (d - dead) / 70) * 18; view.panBy(stick.x / d * sp, stick.y / d * sp); }
      raf = requestAnimationFrame(tick);
    };
    lensBtn.addEventListener('pointerdown', e => {
      start = { x: e.clientX, y: e.clientY, id: e.pointerId }; stick = { x: 0, y: 0 }; steering = false;
      lensBtn.setPointerCapture(e.pointerId);
    });
    lensBtn.addEventListener('pointermove', e => {
      if (!start || e.pointerId !== start.id) return;
      stick = { x: e.clientX - start.x, y: e.clientY - start.y };
      if (!steering && Math.hypot(stick.x, stick.y) > 12) {
        steering = true;
        if (!view.zoomed) view.toggleZoom();
        lensBtn.classList.add('on', 'steering');
        raf = requestAnimationFrame(tick);
      }
    });
    const end = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      cancelAnimationFrame(raf);
      if (!steering && e.type === 'pointerup') view.toggleZoom();
      start = null; steering = false;
      lensBtn.classList.remove('steering');
      lensBtn.classList.toggle('on', view.zoomed);
    };
    lensBtn.addEventListener('pointerup', end);
    lensBtn.addEventListener('pointercancel', end);
    // keyboard, gamepad (clicks without a pointer: detail 0)
    lensBtn.addEventListener('click', e => { if (e.detail === 0) { view.toggleZoom(); lensBtn.classList.toggle('on', view.zoomed); } });
  }
  const boardWrap = h('section', { class: 'boardwrap' }, canvas);
  const tbtn = (ico: string, label: string, fn: () => void) => h('button', { class: 'rbtn small', title: label, 'aria-label': label, onClick: fn }, icon(ico), h('small', {}, label));
  const undoBtn = tbtn('undo', t('undo'), () => { if (board.undo()) { view.invalidate(); updateInfo(); } });
  const trialBtn = rules === 'free' ? tbtn('trial', t('tryIt'), () => trialToggle()) : null;
  const trialLabel = trialBtn?.querySelector('small') ?? h('small');
  // logic hints (blue clue numbers): switched in the game menu
  let logicOn = settings.logicHints && (rules !== 'free' || !!restore?.usedHints);
  async function setLogic(on: boolean) {
    // on Hard, the first switch-on of a puzzle costs the platinum medal: asked first
    if (on && rules === 'free' && !usedHints && !(await confirmBox(t('logicHardAsk'), t('logicHardYes')))) return false;
    logicOn = on; view.logicHints = on; if (on) usedHints = true;
    settings.logicHints = on; saveSettings();
    view.invalidate();
    return true;
  }
  const menuBtn = h('button', { class: 'rbtn hud-menu', title: t('menu'), 'aria-label': t('menu'), onClick: () => pauseMenu() }, icon('menu'));
  // third tool: the player's own marks, which stay while the rest is filled and crossed
  const markBtn = h('button', { class: 'rbtn mark-tool', title: t('mark'), 'aria-label': t('mark'), 'aria-pressed': 'false', onClick: () => toggleMark() }, icon('mark'));
  const tools = h('nav', { class: 'tools' }, h('div', { class: 'tool-main' }, toolBtn, markBtn, lensBtn), h('span', { class: 'gap' }), h('div', { class: 'tool-side' }, undoBtn, trialBtn));

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
  view.logicHints = logicOn;
  // medal: bronze on Easy, silver on Normal, gold on Hard, platinum on Hard without logic hints. Whether hints
  // were on at any moment of this puzzle is kept (with the saved board too), not only whether they are on at the end.
  let usedHints = logicOn || !!restore?.usedHints;
  // roulette spins (PixElo counts each as extra time)
  let roulette = (restore as any)?.roulette ?? 0;
  if (/[?&]debug/.test(location.search)) (window as any).__play = {
    board, view,
    solve() { for (let y = 0; y < board.h; y++) for (let x = 0; x < board.w; x++) board.cells[y * board.w + x] = board.solution[y * board.w + x] ? FILL : CROSS; board.touch(); view.invalidate(); if (board.checkSolved()) solved(); },
  };

  view.onLayout = () => {
    lensBtn.classList.toggle('on', view.zoomed);
    updateInfo();
  };

  let lastTool: 'fill' | 'cross' = 'fill';
  function setTool(tool: 'fill' | 'cross' | 'mark') {
    view.tool = tool;
    if (tool !== 'mark') lastTool = tool;
    markBtn.classList.toggle('on', tool === 'mark'); markBtn.setAttribute('aria-pressed', String(tool === 'mark'));
    toolBtn.classList.toggle('idle', tool === 'mark');
    if (toolBtn.classList.contains('crossing') !== (lastTool === 'cross')) {
      toolBtn.classList.add('swapping'); setTimeout(() => toolBtn.classList.remove('swapping'), 160);
    }
    toolBtn.classList.toggle('crossing', lastTool === 'cross');
    const l = lastTool === 'fill' ? t('fill') : t('cross');
    toolBtn.title = l; toolBtn.setAttribute('aria-label', l);
  }
  function toggleMark() { setTool(view.tool === 'mark' ? lastTool : 'mark'); }

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
    if ((k === 'z' || k === ' ' || k === 'Enter') && !e.repeat) { held = view.pressAtCursor(view.tool === 'mark' ? 'mark' : 'fill'); }
    else if (k === 'v' && !e.repeat) { held = view.pressAtCursor('mark'); }
    else if ((k === 'x' || k === 'Shift') && !e.repeat) { held = view.pressAtCursor('cross'); }
    else if (k === 'c') view.toggleZoom();
    else if (k === 'Escape') pauseMenu();
    else if ((k === 'u' || (k === 'z' && (e.ctrlKey || e.metaKey)))) { if (board.undo()) view.invalidate(); }
  };
  const keyUp = (e: KeyboardEvent) => { if (['z', 'x', 'v', ' ', 'Enter', 'Shift'].includes(e.key)) held = null; };
  window.addEventListener('keydown', key);
  window.addEventListener('keyup', keyUp);
  const gp = Gamepads.onPlay({
    move: (dx, dy) => view.moveCursor(dx, dy, held as any),
    a: down => { held = down ? view.pressAtCursor(view.tool === 'mark' ? 'mark' : 'fill') : null; },
    b: down => { held = down ? view.pressAtCursor('cross') : null; },
    y: () => view.toggleZoom(),
    start: () => pauseMenu(),
    l: () => { if (board.undo()) view.invalidate(); },
    r: () => trialBtn ? trialToggle() : toggleMark(),
  });

  /** keep the board as it is, to come back to (pause menu, or when the app is put away) */
  function keepBoard() {
    if (finished) return;
    saveBoard({ packId: pack.id, levelId: lv.id, puzzleId: pz.id, state: { ...board.snapshot(), usedHints, roulette } as any,
      puzzle: pz, level: { title: lv.title, rules: lv.rules }, packTitle: pack.title });
  }
  const onHide = () => { if (document.visibilityState === 'hidden' && board.elapsedMs > 0) keepBoard(); };
  const onLeave = () => { if (board.elapsedMs > 0) keepBoard(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onLeave);

  function cleanup() {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onLeave);
    finished = true;
    clearTimeout(timerId);
    ro.disconnect();
    view.destroy();
    window.removeEventListener('keydown', key);
    window.removeEventListener('keyup', keyUp);
    gp();
  }

  /** the game menu: stays open for music and hints; "End" asks whether to keep the board */
  async function pauseMenu() {
    running = false;
    await new Promise<void>(done => panel((box, close) => {
      const end = () => { close(); done(); };
      const btn = (label: string, fn: () => void, cls = 'btn') => { const b = h('button', { class: cls, onClick: fn }, label); return b; };
      const draw = () => {
        box.replaceChildren(h('h3', {}, t('menu')));
        box.append(btn(t('resume'), end, 'btn primary'));
        if (board.hasMarks()) {
          box.append(btn(t('fillMarks'), () => { end(); board.pushUndo(); if (board.fillMarks()) Snd.sfx('mistake'); view.invalidate(); updateInfo(); if (board.checkSolved()) solved(); }));
          box.append(btn(t('clearMarks'), () => { end(); board.pushUndo(); board.clearMarks(); view.invalidate(); updateInfo(); }));
        }
        // music: pause / continue the same song, or the next one; the menu stays open
        const playing = settings.music && !Snd.paused() && !!Snd.current();
        box.append(h('div', { class: 'menu-row' },
          btn(playing ? '⏸ ' + t('musicPause') : '▶ ' + t('musicPlay'), () => {
            if (!settings.music) { settings.music = true; saveSettings(); playMusicFor(pack); }
            else if (Snd.paused()) Snd.resume();
            else if (!Snd.current()) playMusicFor(pack);
            else Snd.pause();
            setTimeout(draw, 30);
          }),
          btn('⏭ ' + t('musicNext'), () => { if (!settings.music) { settings.music = true; saveSettings(); } playMusicFor(pack); setTimeout(draw, 30); })));
        box.append(btn('💡 ' + (logicOn ? t('logicOff') : t('logicOnBtn')) + (rules === 'free' && !usedHints && !logicOn ? ' · ' + t('noPlatinum') : ''), async () => { await setLogic(!logicOn); draw(); }));
        box.append(btn(t('restart'), () => { end(); cleanup(); clearBoard(pack.id, lv.id, pz.id); play(pack, lv, index, back, undefined, true); }));
        box.append(btn(t('endGame'), async () => {
          end();
          // keep the board (continue later) or throw it away; nothing to ask about an untouched board
          if (board.elapsedMs < 3000 && board.cells.every(v => v === 0)) { cleanup(); back(); return; }
          let choice = 'stay' as 'save' | 'drop' | 'stay';
          await choose(t('endAsk'), [[t('endSave'), () => { choice = 'save'; }], [t('endDrop'), () => { choice = 'drop'; }], [t('back'), () => {}]]);
          if (choice === 'save') { keepBoard(); cleanup(); back(); }
          else if (choice === 'drop') { cleanup(); clearBoard(pack.id, lv.id, pz.id); back(); }
          else { last = performance.now(); running = true; }
        }));
      };
      draw();
      return end; // back: continue playing
    }));
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
      roulette++;
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
    if (roleSongs(pack.theme, 'clear').length && settings.packMusic) usePack(pack, 'clear', false);
    else { Snd.stop(); Snd.sfx('clear'); }
    const under = board.totalMs < TIME_LIMIT;
    const medal: Medal = rules === 'easy' ? 'bronze' : rules === 'normal' ? 'silver' : usedHints ? 'gold' : 'platinum';
    // points and PixElo (the first solve under these rules is rated); a daily puzzle counts in its own game
    const mode = curMode(), mega = pz.id.endsWith(MEGA);
    const { pr, par } = puzzleRating(pz.rows, mega);
    const before = localStats(mode);
    const extra = {
      rated: { pr, s: perfScore(board.totalMs, par, rules as RatedRules, { logic: usedHints, roulette }) },
      pts: (p: { medal?: Medal; times?: Partial<Record<string, number>> }) => points(pz.rows, mega, p.medal, p.times?.[RULES_OF[p.medal ?? 'bronze']], par),
    };
    const target = pz.origin ? [pz.origin.slice(0, pz.origin.lastIndexOf('/')), pz.origin.slice(pz.origin.lastIndexOf('/') + 1)] : [pack.id, pz.id];
    const wasRated = !!getProgress(target[0], target[1]).rated?.[rules as RatedRules];
    let newMedal = recordClear(target[0], target[1], board.totalMs, under, medal, rules, extra);
    if (pz.origin) newMedal = recordClear(pack.id, pz.id, board.totalMs, under, medal, rules) || newMedal;
    const after = localStats(mode);
    clearBoard(pack.id, lv.id, pz.id);
    cleanup();
    showSolved(pack, lv, index, board, under, pckOf(pack), back, medal, newMedal, { elo: after.elo - before.elo, rated: !wasRated, points: after.points - before.points, total: after.points, now: after.elo });
  }
}

function medalEl(m: Medal, big = false) {
  return h('span', { class: 'medal ' + m + (big ? ' big' : ''), title: t(m) }, big ? t(m) : '');
}

function showSolved(pack: Pack, lv: PackLevel, index: number, board: Board, under: boolean, pck: PckGetter | null, back: () => void, medal?: Medal, newMedal = false,
  score?: { elo: number; rated: boolean; points: number; total: number; now: number }) {
  const pz = lv.puzzles[index];
  const cv = h('canvas', { class: 'solved-pic' });
  const anim = new PictureAnimator(pz as any, pck, pack.id);
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
    score ? h('div', { class: 'score-gain' },
      h('span', { class: 'pts' + (score.points ? ' up' : '') }, (score.points ? '+' + score.points : '±0') + ' ' + t('pointsShort')),
      h('span', { class: 'elo' + (score.elo > 0 ? ' up' : score.elo < 0 ? ' down' : '') }, score.rated ? `${score.elo >= 0 ? '+' : ''}${score.elo} PixElo · ${score.now}` : t('unratedReplay'))) : null,
    fastestRow(pack.id, pz.id),
    h('div', { class: 'row' }, h('button', { class: 'btn', onClick: () => { stop(); back(); } }, t('toList')), next)));
  setTimeout(() => { Snd.stop(); usePack(pack, 'menu'); }, roleSongs(pack.theme, 'clear').length ? 4500 : 1500);
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

/** yes / no */
function confirmChoice(question: string, yes: string): Promise<boolean> { return confirmBox(question, yes); }

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

function packsScreen(back: () => void = home) {
  applyThemeCss(root(), null);
  openPackManager({
    root: root(),
    packs: () => ctx.packs,
    setPacks: p => { ctx.packs = p; for (const id of [...ctx.pcks.keys()]) if (!p.some(x => x.id === id)) ctx.pcks.delete(id); },
    header: (title: string) => header(title, back),
    screen,
    openPack: (p: Pack) => openPack(p, () => packsScreen(back)),
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
    if (!s) { await message(t('notASave')); return; }
    const r = importSave(s);
    await message(r.created ? t('saveNewProfile', { name: r.profile }) : t('saveMerged', { name: r.profile, a: r.packsTaken, b: r.packsKept }));
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

export function serverError(e: any): string {
  const code = e instanceof Sync.ServerError ? e.code : String(e?.message || e);
  const s = t('err.' + code);
  return s === 'err.' + code ? t('err.other', { code }) : s;
}

/** the server: its address (this device), and the active profile's account there */
function serverSection(): HTMLElement {
  const box = h('div', { class: 'server-box' });
  const msg = h('p', { class: 'fine left server-msg' });
  const say = (s: string, bad = false) => { msg.textContent = s; msg.classList.toggle('bad', bad); };
  const url = h('input', { type: 'url', class: 'text', placeholder: 'https://…', value: Sync.serverUrl(), 'aria-label': t('serverUrl'), autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const connect = async () => {
    Sync.setServerUrl(url.value); url.value = Sync.serverUrl();
    if (!url.value) { draw(); return; }
    draw();
    try { await Sync.serverInfo(); say(t('serverOk')); } catch (e) { say(serverError(e), true); }
  };
  const draw = () => {
    box.innerHTML = '';
    box.append(h('label', { class: 'field' }, h('span', {}, t('serverUrl')), h('div', { class: 'row' }, url, h('button', { class: 'btn', onClick: connect }, t('serverConnect')))));
    const a = Sync.account();
    if (a) {
      const st = Sync.syncState();
      const when = a.synced ? new Date(a.synced).toLocaleString() : '–';
      box.append(
        h('p', { class: 'fine left' }, '☁ ' + t('loggedIn', { name: a.name }) + ' · ' + (st.state === 'syncing' ? t('syncing') : t('syncedAt', { when }))),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn primary', onClick: async () => { say(t('syncing')); const c = await Sync.sync(); const s = Sync.syncState(); say(s.error ? serverError(new Sync.ServerError(s.error, 0)) : t('syncedAt', { when: new Date().toLocaleString() }), !!s.error); if (c) optionsScreen(); else draw(); } }, '⟳ ' + t('syncNow')),
          h('button', { class: 'btn', onClick: async () => { await Sync.signOut(); draw(); } }, t('logout'))));
      if (st.error) say(serverError(new Sync.ServerError(st.error, 0)), true);
      if (a.admin) box.append(h('button', { class: 'btn ghost', onClick: () => accountsDialog() }, '👥 ' + t('accounts')));
    } else if (Sync.serverUrl()) {
      if (Sync.loggedOut()) say(t('loggedOutMsg', { name: Sync.loggedOut()! }), true);
      const name = h('input', { type: 'text', class: 'text', autocomplete: 'username', value: Sync.loggedOut() ?? activeProfile().name, 'aria-label': t('accName') }) as HTMLInputElement;
      const pass = h('input', { type: 'password', class: 'text', autocomplete: 'current-password', 'aria-label': t('accPassword') }) as HTMLInputElement;
      const invite = h('input', { type: 'text', class: 'text', placeholder: t('accInviteNote'), autocapitalize: 'off', 'aria-label': t('accInvite') }) as HTMLInputElement;
      const ask = (q: { local: string; remote: string }) => new Promise<'merge' | 'separate'>(res =>
        choose(t('mergeAsk', q), [[t('mergeYes'), () => res('merge')], [t('mergeNo'), () => res('separate')]]));
      const go = async (register: boolean) => {
        say('…');
        try {
          Sync.setServerUrl(url.value);
          await Sync.signIn(name.value.trim(), pass.value, register ? invite.value.trim() : undefined, ask);
          optionsScreen();
        } catch (e) { say(serverError(e), true); }
      };
      box.append(
        h('label', { class: 'field' }, h('span', {}, t('accName')), name),
        h('label', { class: 'field' }, h('span', {}, t('accPassword')), pass),
        h('label', { class: 'field' }, h('span', {}, t('accInvite')), invite),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn primary', onClick: () => go(false) }, t('login')),
          h('button', { class: 'btn', onClick: () => go(true) }, t('register'))));
    }
    box.append(msg, h('p', { class: 'fine left' }, t('serverHelp')));
  };
  draw();
  return box;
}

/** admin: the server's accounts; set a new password for someone who forgot theirs */
async function accountsDialog() {
  let users: Array<{ name: string; admin: boolean }> = [];
  try { users = await Sync.serverUsers(); } catch (e) { await message(serverError(e)); return; }
  choose(t('accounts'), [...users.map(u => [(u.admin ? '★ ' : '') + u.name + ' · ' + t('newPassword'), async () => {
    const pw = await askText(t('newPasswordFor', { name: u.name }), '');
    if (!pw) return;
    try { await Sync.setPassword(u.name, pw); await message(t('passwordSet', { name: u.name })); } catch (e) { await message(serverError(e)); }
  }] as [string, () => void]), [t('back'), () => {}]]);
}

/** switch, create, rename or delete profiles */
function profileDialog(after: () => void) {
  const me = activeProfile();
  const opts: Array<[string, () => void]> = profiles().map(p => [(p.id === me.id ? '✓ ' : '') + p.name, () => { switchProfile(p.id); }]);
  opts.push(['✚ ' + t('newProfile'), async () => { const n = await askText(t('profileName'), ''); if (n) createProfile(n); }]);
  opts.push(['✎ ' + t('renameProfile'), async () => { const n = await askText(t('profileName'), me.name); if (n) renameProfile(n); }]);
  if (profiles().length > 1) opts.push(['🗑 ' + t('deleteProfile', { name: me.name }), async () => { if (await confirmBox(t('deleteProfile', { name: me.name }) + '?', t('delete'), true)) deleteProfile(me.id); }]);
  opts.push([t('back'), () => {}]);
  choose(t('profile'), opts).then(() => { after(); if (Sync.account()) Sync.sync().then(c => { if (c) after(); }); });
}

// ---------------------------------------------------------------- options

/** every game's songs, with what they play for; tap one to hear it */
/** where a song file comes from, for games with the songs of several releases (3DS and Switch) */
function songPlatform(ref: string): string {
  const f = ref.split('#')[0].toLowerCase();
  return f.endsWith('.bcstm') ? '3DS' : f.endsWith('.ogg') ? 'Switch' : f.endsWith('.sdat') ? 'DS' : f.endsWith('.gbsnd') ? 'Game Boy' : f.endsWith('.spcsnap') ? 'Super Famicom' : '';
}

/** change where a game plays its songs (sound test): saved in the pack as a new revision, so it goes to the server */
async function editSongs(view: Pack, fn: (th: PackTheme) => void) {
  const p = original(view);
  const th: PackTheme = p.theme = { ...(p.theme ?? {}) };
  th.music = { ...(th.music ?? {}) };
  fn(th);
  for (const k of Object.keys(th.music) as Array<keyof NonNullable<PackTheme['music']>>) if (!th.music[k]) delete th.music[k];
  th.edited = Date.now();
  p.rev = newRev();
  view.theme = th; view.rev = p.rev;
  await storage.savePack(p);
}

// song lengths (streams only: sequenced music has no fixed length), kept on this device by content
const LEN_KEY = 'momogram.songLength';
const songLen: Record<string, [number, number?, number?]> = (() => { try { return JSON.parse(localStorage.getItem(LEN_KEY) || '{}'); } catch { return {}; } })();
async function lengthOf(p: Pack, ref: string): Promise<[number, number?, number?] | null> {
  const [file, seq] = ref.split('#');
  if (seq || !/\.(ogg|bcstm)$/i.test(file)) return null;
  const k = trackKey(p.id, ref);
  if (songLen[k]) return songLen[k];
  const d = await storage.loadAsset(p.id, file).catch(() => undefined);
  if (!d) return null;
  const r = /\.ogg$/i.test(file) ? oggLength(d) : bcstmLength(d);
  if (!r) return null;
  songLen[k] = r.loop ? [r.sec, r.loop[0], r.loop[1]] : [r.sec];
  try { localStorage.setItem(LEN_KEY, JSON.stringify(songLen)); } catch { /* full */ }
  return songLen[k];
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/**
 * Every song of every game, playable. The buttons beside a song set where the games play it (title, menu,
 * puzzle, clear; several songs per role are fine) or switch it off. A song that several games have is one song:
 * its tags apply in all of them.
 */
function soundTest(filter: 'all' | 'once' | 'off' = 'all') {
  const body = h('div', { class: 'soundtest' });
  screen(header(t('soundTest'), optionsScreen), body);
  if (!settings.music || !settings.packMusic) body.append(h('p', { class: 'fine' }, t('soundTestOff')));
  body.append(h('p', { class: 'fine' }, t('soundTestHelp2')));
  const ROLES: Array<[SongRole, string]> = [['title', t('roleTitle')], ['menu', t('roleMenu')], ['play', t('rolePlay')], ['clear', t('roleClear')]];
  const buttons: Array<[string, HTMLElement]> = [];
  body.append(h('div', { class: 'st-bar' },
    h('button', { class: 'btn ghost', onClick: () => Snd.stop() }, '■ ' + t('stop')),
    h('span', { class: 'gap' }),
    ...([['all', t('stAll')], ['once', t('stOnce')], ['off', t('stOff')]] as const).map(([f, label]) =>
      h('button', { class: 'chip' + (filter === f ? ' on' : ''), onClick: () => soundTest(f) }, label))));
  // every game that has each song (by content), and the first one in library order
  const games = new Map<string, Array<{ p: Pack; ref: string }>>();
  for (const p of allPacks()) for (const ref of songsOf(p.theme)) {
    const k = trackKey(p.id, ref);
    const l = games.get(k) ?? [];
    if (!l.some(x => x.p === p)) l.push({ p, ref });
    games.set(k, l);
  }
  const lengths: Array<() => Promise<void>> = [];
  for (const p of allPacks()) {
    const songs = songsOf(p.theme);
    if (!songs.length) continue;
    const several = new Set(songs.map(songPlatform)).size > 1;
    const list = h('div', { class: 'tracks' });
    const draw = () => {
      list.replaceChildren();
      const seen = new Set<string>();
      for (const ref of songsOf(p.theme)) {
        const key = trackKey(p.id, ref);
        if (seen.has(key)) continue; // the same song twice in one game
        seen.add(key);
        const all = games.get(key) ?? [{ p, ref }];
        const first = all[0].p !== p ? all[0].p : null;
        const off = isOff(p, ref);
        if (filter === 'once' && first) continue;
        if (filter === 'off' && !off) continue;
        const has = (role: SongRole) => roleSongs(p.theme, role).includes(ref);
        const lenEl = h('small', { class: 'len' });
        const others = all.filter(x => x.p !== p);
        const note = [several ? songPlatform(ref) : '', first ? t('sameAs', { game: pickAny(first.title, packLang()) }) : others.length ? t('alsoIn', { n: others.length }) : ''].filter(Boolean).join(' · ');
        const playBtn = h('button', { class: 'btn track', title: others.length ? t('alsoInList') + '\n' + others.map(x => pickAny(x.p.title, packLang())).join('\n') : '',
          onClick: () => { void Snd.playPack(p.id, ref, !has('clear') && !/jingle|jng|_j_|jg_\d/i.test(ref)); } },
          h('b', {}, '▶ ' + trackName(ref)), lenEl, note ? h('small', {}, note) : null);
        lengths.push(async () => {
          const l = await lengthOf(p, ref);
          if (l) lenEl.textContent = mmss(l[0]) + (l[1] !== undefined && (l[1] > 0.5 || (l[2] ?? l[0]) < l[0] - 0.5) ? ` · ↻ ${mmss(l[1])}–${mmss(l[2] ?? l[0])}` : l[1] !== undefined ? ' · ↻' : '');
        });
        buttons.push([p.id + '/' + ref, playBtn]);
        // a change applies to this song in every game that has it
        const everywhere = async (fn: (th: PackTheme, r: string) => void) => { for (const x of all) await editSongs(x.p, th => fn(th, x.ref)); };
        const chips = h('div', { class: 'chips' }, ...ROLES.map(([role, label]) => h('button', {
          class: 'chip' + (has(role) ? ' on' : ''), 'aria-pressed': String(has(role)), disabled: p === STARTER || off ? true : undefined,
          onClick: async () => {
            const on = !has(role);
            await everywhere((th, r) => {
              const cur = roleSongs(th, role).filter(x => x !== r);
              setRoleSongs(th, role, on ? [...cur, r] : cur);
            });
            soundTest(filter);
          } }, label)),
          h('button', { class: 'chip off' + (off ? ' on' : ''), title: t('songOffTitle'), 'aria-pressed': String(off), disabled: p === STARTER ? true : undefined,
            onClick: async () => { await everywhere((th, r) => { const o = new Set(th.off ?? []); if (off) o.delete(r); else o.add(r); th.off = [...o]; if (!th.off.length) delete th.off; }); soundTest(filter); } }, '⊘ ' + t('songOff')));
        list.append(h('div', { class: 'song' + (first ? ' dup' : '') + (off ? ' is-off' : '') }, playBtn, chips));
      }
      mark(Snd.current());
    };
    draw();
    if (list.childElementCount) body.append(h('section', { class: 'opt-card' }, h('h2', {}, pickAny(p.title, packLang())), list));
  }
  if (!buttons.length) body.append(h('p', { class: 'fine' }, t('soundTestNone')));
  function mark(cur: string) { for (const [id, b] of buttons) b.classList.toggle('on', id === cur); }
  mark(Snd.current());
  const on = (id: string) => { if (body.isConnected) mark(id); else Snd.offChange(on); };
  queueMicrotask(() => Snd.onChange(on));
  // lengths: read one file after the other in the background (they're kept on this device after that)
  (async () => { for (const f of lengths) { if (!body.isConnected) return; await f(); } })();
}

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
    ...[['', 'Auto'], ...(Object.entries(LANG_NAMES) as Array<[string, string]>)].map(([v, l]) => h('option', { value: v, selected: (settings.lang ?? '') === v ? true : undefined },
      // only English and German have all texts; the others change the games' titles and names
      v && !hasTexts(v as Lang) ? `${l} (${t('titlesOnly')})` : l)));
  const row = (label: string, ctl: Node, note?: string) => h('div', { class: 'opt' }, h('div', { class: 'opt-label' }, h('span', {}, label), note ? h('small', {}, note) : null), ctl);
  const card = (title: string, ...rows: Array<Node | null>) => h('section', { class: 'opt-card' }, h('h2', {}, title), ...rows);
  screen(header(t('options'), home), h('div', { class: 'options' },
    h('button', { class: 'btn big opt-packs', onClick: () => packsScreen(optionsScreen) }, h('b', {}, '📦 ' + t('packs')), h('small', {}, t('packsHelp'))),
    card(t('secSound'),
      row(t('music'), toggle('music', () => settings.music ? menuMusic(null, true) : Snd.stop())),
      settings.music ? row(t('volume'), vol) : null,
      settings.music ? row(t('musicMode'), seg('musicMode', [['random-pack', t('musicRandomPack')], ['random-all', t('musicRandomAll')], ['fixed', t('musicFixed')]])) : null,
      row(t('sfx'), toggle('sfx')),
      row(t('soundTest'), h('button', { class: 'btn', onClick: () => soundTest() }, '♪ ' + t('open')))),
    card(t('secPlay'),
      row(t('hints'), seg('hints', [['ask', t('ask')], ['always', t('always')], ['never', t('never')]])),
      row(t('logicDefault'), toggle('logicHints')),
      row(t('unlockAll'), toggle('unlockAll'))),
    card(t('secLook'),
      row(t('packColors'), toggle('packColors')),
      row(t('toolsRight'), toggle('toolsRight')),
      row(t('language'), langSel)),
    card(t('secSave'), saveSection()),
    card(t('secServer'), serverSection()),
    card(t('secAbout'),
      row(t('version'), h('b', { class: 'version' }, 'MomoGram ' + (window as any).MOMOGRAM_VERSION)),
      h('p', { class: 'fine left' }, t('controls')),
      h('p', { class: 'fine left' }, t('musicNote')),
      h('button', { class: 'btn', onClick: () => galleryScreen() }, '🔍 ' + t('gallery')),
      /[?&]debug/.test(location.search) ? h('button', { class: 'btn', onClick: () => textureInspector(screen, header('3DS textures', optionsScreen)) }, '3DS textures (debug)') : null,
      h('p', { class: 'fine left' }, 'MomoGram ' + (window as any).MOMOGRAM_VERSION + ' · MIT · ' + t('noGameData')))));
}

/**
 * Check every game at a glance (debug): per game a few puzzles, each as a half-solved board in the game's look and
 * as its solved picture. Tap a picture to look at it big (pinch, wheel or the buttons zoom; drag moves).
 */
function galleryScreen() {
  const body = h('div', { class: 'gallery' });
  screen(header(t('gallery'), optionsScreen), body);
  body.append(h('p', { class: 'fine' }, t('galleryHelp')));
  const io = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); (e.target as any).__load?.(); } }, { rootMargin: '400px' });
  for (const pack of allPacks()) {
    const puzzles = pack.levels.flatMap(l => l.puzzles.map((z, i) => ({ l, z, i })));
    if (!puzzles.length) continue;
    const pick = [...new Set([0, Math.floor(puzzles.length / 2), puzzles.length - 1])].map(i => puzzles[i]);
    const row = h('div', { class: 'gal-row' });
    const card = h('section', { class: 'opt-card gal-card' }, h('h2', {}, pickAny(pack.title, packLang()) + ` · ${pack.source.platform}`), row);
    (card as any).__load = async () => {
      await loadExtras(pack);
      for (const { l, z } of pick) {
        const cell = h('div', { class: 'gal-item' });
        row.append(cell);
        cell.append(await boardShot(pack, z), thumbnail(z, pckOf(pack), 160, pack.id), h('small', {}, `${pickAny(l.title, packLang())} · ${z.width}×${z.height}`));
        for (const el of cell.querySelectorAll('img, canvas')) el.addEventListener('click', () => zoomView(el as HTMLElement));
      }
    };
    io.observe(card);
    body.append(card);
  }
}

/** a picture of a puzzle's board, half solved (filled and crossed cells, greyed clues), in its game's look */
async function boardShot(pack: Pack, pz: PackPuzzle): Promise<HTMLImageElement> {
  const board = new Board(pz.rows, 'free', megaPairsOf(pz));
  for (let y = 0; y < board.h; y++) for (let x = 0; x < board.w; x++) {
    if (y >= board.h / 2 && (x + y) % 3) continue;
    board.cells[y * board.w + x] = board.solution[y * board.w + x] ? FILL : CROSS;
  }
  board.touch();
  const cv = h('canvas') as HTMLCanvasElement;
  const host = h('div', { style: 'position:fixed;left:-2000px;top:0;width:360px;height:360px' }, cv);
  document.body.append(host);
  const view = new BoardView(cv, board, { onChange: () => {} });
  view.setTheme(packColors(pack)?.board ?? null);
  view.resize(360, 360);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const img = h('img', { class: 'gal-board', alt: '' }) as HTMLImageElement;
  img.src = cv.toDataURL();
  view.destroy(); host.remove();
  return img;
}

/** a picture big, with zoom (pinch, wheel, buttons) and moving by dragging */
function zoomView(src: HTMLElement) {
  const img = (src instanceof HTMLCanvasElement ? Object.assign(h('img') as HTMLImageElement, { src: src.toDataURL() }) : h('img', { src: (src as HTMLImageElement).src })) as HTMLImageElement;
  img.className = 'zoom-img';
  let k = 1, x = 0, y = 0;
  const apply = () => { img.style.transform = `translate(${x}px, ${y}px) scale(${k})`; };
  const by = (f: number) => { k = Math.max(0.5, Math.min(16, k * f)); apply(); };
  const pts = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  const stage = h('div', { class: 'zoom-stage' }, img);
  stage.addEventListener('pointerdown', e => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); } });
  stage.addEventListener('pointermove', e => {
    const p = pts.get(e.pointerId); if (!p) return;
    if (pts.size === 1) { x += e.clientX - p.x; y += e.clientY - p.y; apply(); }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); if (pinch) by(d / pinch); pinch = d; }
  });
  const up = (e: PointerEvent) => { pts.delete(e.pointerId); pinch = 0; };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', e => { e.preventDefault(); by(e.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
  const m = h('div', { class: 'modal zoom-modal' }, stage,
    h('div', { class: 'zoom-bar' },
      h('button', { class: 'btn', onClick: () => by(1 / 1.5) }, '−'),
      h('button', { class: 'btn', onClick: () => { k = 1; x = 0; y = 0; apply(); } }, '1:1'),
      h('button', { class: 'btn', onClick: () => by(1.5) }, '+'),
      h('button', { class: 'btn primary', onClick: () => m.remove() }, '✕')));
  document.body.append(m);
  // start as big as fits
  requestAnimationFrame(() => { const r = stage.getBoundingClientRect(), w = img.naturalWidth || 160, hh = img.naturalHeight || 160; k = Math.max(1, Math.min(r.width / w, r.height / hh) * 0.95); apply(); });
}

export { ctx, CROSS };
