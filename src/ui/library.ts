// The game library on the home screen: game cards, folders, order and hidden games, update and Mega marks.
import { t } from '../i18n';
import { Pack, PackLevel, pickAny, safeColor } from '../packs/format';
import { seriesOf } from '../packs/importers/series';
import { packRev } from '../packs/io';
import { themeColors } from '../packs/theme';
import { getProgress, settings } from '../store';
import * as Sync from '../sync';
import { confirmBox, message } from './dialog';
import { icon } from './icons';
import { fetchServerPacks } from './packs';
import { allPacks, countPack, ctx, curMode, h, header, home, openPack, packLang, screen, serverError, themeRoot } from '../app';

// ---------------------------------------------------------------- library: folders, order, hidden games

interface LibPrefs { order: string[]; hidden: string[]; group: 'series' | 'system' | 'none'; view?: 'cards' | 'tiles' | 'list' }
export function libPrefs(): LibPrefs {
  try { return { order: [], hidden: [], group: 'series', ...JSON.parse(localStorage.getItem('momogram.library') || '{}') }; } catch { return { order: [], hidden: [], group: 'series' }; }
}
function setLibPrefs(p: LibPrefs) { localStorage.setItem('momogram.library', JSON.stringify(p)); }
export let libEdit = false;
/** arranging on or off (the home screen's button) */
export function toggleLibEdit(): boolean { libEdit = !libEdit; return libEdit; }

const groupKey = (p: Pack, mode: LibPrefs['group']) => p.id === 'momogram-starter' ? '' : mode === 'system' ? p.source.platform : mode === 'series' ? seriesOf(p) : '';

/** visible games in the player's order (hidden ones only while arranging) */
export function libraryPacks(includeHidden = false): Pack[] {
  const pr = libPrefs();
  const idx = (id: string) => { const i = pr.order.indexOf(id); return i < 0 ? 1e6 : i; };
  return allPacks().filter(p => includeHidden || !pr.hidden.includes(p.id)).sort((a, b) => idx(a.id) - idx(b.id));
}


const hasGameMega = (p: Pack) => p.levels.some(l => l.puzzles.some(z => z.mega));
function megaOrb(packs: Pack[]): HTMLElement | null {
  if (curMode() !== 'mega' || settings.megaMark !== 'mark' || !packs.some(hasGameMega)) return null;
  return h('span', { class: 'mega-orb', title: t('megaFromGameHelp'), 'aria-label': t('megaFromGame') });
}
/** the same dot on a game's modes and levels, so the way to its own Mega puzzles is marked all along */
export function megaOrbLevels(lvs: PackLevel[]): HTMLElement | null {
  return megaOrb([{ levels: lvs } as Pack]);
}

/** a newer version of this game is on the server (someone imported it again) */
const hasUpdate = (p: Pack) => (Sync.knownServerRevs().get(p.id) ?? 0) > packRev(p);
/** opening a game with a newer version on the server: asks first whether to download it */
async function offerUpdate(p: Pack, open: () => void) {
  if (!hasUpdate(p) || !Sync.account() || !(await confirmBox(t('updateAsk', { name: pickAny(p.title, packLang()) }), t('update')))) { open(); return; }
  const note = h('p', { class: 'update-note' }, '⬆ ' + t('update') + ' …');
  const box = h('div', { class: 'modal' }, h('div', { class: 'card' }, note));
  document.body.append(box);
  try {
    const sp = (await Sync.serverPacks()).find(x => x.id === p.id);
    if (sp) await fetchServerPacks({ packs: () => ctx.packs, setPacks: ps => { ctx.packs = ps; ctx.pcks.delete(p.id); } }, [sp], text => { note.textContent = '⬆ ' + text; });
  } catch (e) { message(serverError(e)); }
  finally { box.remove(); }
  open();
}
function gameCard(p: Pack, onOpen: () => void): HTMLElement {
  const [a, b] = countPack(p);
  const col = p.theme?.palette && settings.packColors ? safeColor(themeColors(p.theme.palette).accent, '') || null : null;
  // the icon sits in a row with the system and year (like the icons of a folder), so the title has the full width
  return h('button', { class: 'btn game', style: col ? `--game:${col}` : undefined, onClick: onOpen },
    h('b', {}, pickAny(p.title, packLang()), megaOrb([p]), hasUpdate(p) ? h('span', { class: 'update-orb', title: t('updateAvailable'), 'aria-label': t('updateAvailable') }) : null),
    h('div', { class: 'game-meta' }, hasIcon(p) ? iconCanvas(p.icon!) : null,
      h('small', {}, [p.source.platform, p.source.year].filter(Boolean).join(' · ') + (p.theme?.music ? ' · ♪' : ''))),
    h('div', { class: 'bar-outer slim' }, h('div', { class: 'bar-inner', style: `width:${b ? (a / b) * 100 : 0}%` })),
    h('small', { class: 'count' }, t('solvedCount', { a, b })),
    null);
}

/**
 * The library grid: single games as cards, several games of a series (or system) as a folder. While arranging,
 * every entry gets arrows to move it and an eye to hide it.
 */
export function renderLibrary(el: HTMLElement, folder: string | null) {
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
      ? gameCard(e.packs[0], () => offerUpdate(e.packs[0], () => openPack(allPacks().find(x => x.id === e.packs[0].id) ?? e.packs[0], folder !== null ? () => folderScreen(folder) : home)))
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
  if (libEdit && folder === null) el.prepend(h('div', { class: 'lib-group' }, h('span', {}, t('groupBy')),
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
    h('b', {}, key, megaOrb(packs)), h('small', {}, t('gamesCount', { n: packs.length })),
    h('div', { class: 'folder-tabs' }, ...packs.slice(0, 4).map(p => hasIcon(p) ? iconCanvas(p.icon!) : h('i', { style: p.theme?.palette ? `--game:${themeColors(p.theme.palette).accent}` : undefined }))),
    h('div', { class: 'bar-outer slim' }, h('div', { class: 'bar-inner', style: `width:${b ? (a / b) * 100 : 0}%` })),
    h('small', { class: 'count' }, t('solvedCount', { a, b })));
}

function folderScreen(key: string) {
  themeRoot(null);
  const lib = h('div', { class: 'library' });
  renderLibrary(lib, key);
  screen(header(key, home), h('div', { class: 'home' }, lib));
}

export function progressText(pack: Pack, levels: PackLevel[]) {
  let a = 0, b = 0;
  for (const l of levels) for (const p of l.puzzles) { b++; if (getProgress(pack.id, p.id).cleared) a++; }
  return t('solvedCount', { a, b });
}
