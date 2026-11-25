// Persistent storage: the user's ROM and packs in IndexedDB, progress/settings in localStorage.
import { replay } from './game/rating';
import type { Pack } from './packs/format';
import { compressAsset, decompressAsset, sha1 } from './util/files';
import type { BoardSnapshot } from './game/board';

const DB = 'momogram';
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['roms', 'packs', 'assets']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

/** remove stored files no pack links to any more (only the small links are read, never the files) */
async function sweepAssets() {
  const d = await db();
  await new Promise<void>((res, rej) => {
    const t = d.transaction('assets', 'readwrite'), s = t.objectStore('assets');
    const used = new Set<string>();
    const add = (r: IDBRequest<unknown[]>) => { r.onsuccess = () => { for (const v of r.result) if (typeof v === 'string') used.add(v); }; };
    add(s.getAll(IDBKeyRange.upperBound('@', true)));
    add(s.getAll(IDBKeyRange.lowerBound('@\uffff', true)));
    const files = s.getAllKeys(IDBKeyRange.bound('@', '@\uffff'));
    files.onsuccess = () => { for (const k of files.result) if (!used.has(String(k))) s.delete(k); };
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

/** once: files stored before linking become links, so copies in several packs take the space of one */
async function linkAssets(): Promise<number> {
  const d = await db();
  const keys = await tx<IDBValidKey[]>('assets', 'readonly', s => s.getAllKeys());
  let saved = 0;
  for (const k of keys.map(String).filter(k => !k.startsWith('@'))) {
    const v = await tx<Uint8Array | string | undefined>('assets', 'readonly', s => s.get(k));
    if (!(v instanceof Uint8Array)) continue;
    const raw = decompressAsset(v), ref = '@' + await sha1(raw);
    const had = await tx<IDBValidKey | undefined>('assets', 'readonly', s => s.getKey(ref)) !== undefined;
    if (had) saved += v.length;
    await new Promise<void>((res, rej) => {
      const t = d.transaction('assets', 'readwrite'), s = t.objectStore('assets');
      if (!had) s.put(v, ref);
      s.put(ref, k);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  }
  return saved;
}

export const storage = {
  savePack: (p: Pack) => tx('packs', 'readwrite', s => s.put(p, p.id)),
  deletePack: (id: string) => tx('packs', 'readwrite', s => s.delete(id)),
  allPacks: () => tx<Pack[]>('packs', 'readonly', s => s.getAll()),
  // music and other binary files of a pack, keyed "packId/name". The same file in several packs (every game of a
  // series has the same title music; the Switch and 3DS versions of a game share pictures) is kept once: the
  // file itself is stored under "@<sha1>" and "packId/name" holds the string "@<sha1>". Files are compressed where
  // that saves space and unpacked transparently when loaded. Older entries (the file itself) still load.
  saveAsset: async (packId: string, name: string, data: Uint8Array) => {
    const ref = '@' + await sha1(data);
    if (await tx<IDBValidKey | undefined>('assets', 'readonly', s => s.getKey(ref)) === undefined) {
      const z = await compressAsset(data);
      await tx('assets', 'readwrite', s => s.put(z, ref));
    }
    await tx('assets', 'readwrite', s => s.put(ref, packId + '/' + name));
  },
  loadAsset: async (packId: string, name: string) => {
    let d = await tx<Uint8Array | string | undefined>('assets', 'readonly', s => s.get(packId + '/' + name));
    if (typeof d === 'string') d = await tx<Uint8Array | undefined>('assets', 'readonly', s => s.get(d as string));
    return d && decompressAsset(d);
  },
  /** a stored file by its content hash (any pack's), or undefined */
  loadBlob: async (sha1hex: string) => {
    const d = await tx<Uint8Array | undefined>('assets', 'readonly', s => s.get('@' + sha1hex));
    return d && decompressAsset(d);
  },
  /** a downloaded file kept by its hash before its pack is stored (an interrupted download resumes from there);
   *  "~dl/<hash>" keeps it from being swept until dropDownloads() */
  saveDownload: async (data: Uint8Array) => {
    const h = await sha1(data), ref = '@' + h;
    if (await tx<IDBValidKey | undefined>('assets', 'readonly', s => s.getKey(ref)) === undefined) {
      const z = await compressAsset(data);
      await tx('assets', 'readwrite', s => s.put(z, ref));
    }
    await tx('assets', 'readwrite', s => s.put(ref, '~dl/' + h));
    return h;
  },
  dropDownloads: async () => { await tx('assets', 'readwrite', s => s.delete(IDBKeyRange.bound('~dl/', '~dl/\uffff'))); },
  /** the content hash of a stored file (without loading it); undefined for files stored before linking */
  assetHash: async (packId: string, name: string) => {
    const d = await tx<Uint8Array | string | undefined>('assets', 'readonly', s => s.get(packId + '/' + name));
    return typeof d === 'string' ? d.slice(1) : undefined;
  },
  assetNames: (packId: string) => tx<IDBValidKey[]>('assets', 'readonly', s => s.getAllKeys(IDBKeyRange.bound(packId + '/', packId + '/\uffff')))
    .then(k => k.map(x => String(x).slice(packId.length + 1))),
  deleteAssets: async (packId: string) => {
    await tx('assets', 'readwrite', s => s.delete(IDBKeyRange.bound(packId + '/', packId + '/\uffff')));
    await sweepAssets();
  },
  deleteAsset: async (packId: string, name: string) => { await tx('assets', 'readwrite', s => s.delete(packId + '/' + name)); await sweepAssets(); },
  linkAssets,
  sweepAssets,
  async persist() { try { await navigator.storage?.persist?.(); } catch { /* ignore */ } },
};

// ---- progress & settings ----

export type Medal = 'bronze' | 'silver' | 'gold' | 'platinum';
export const MEDALS: Medal[] = ['bronze', 'silver', 'gold', 'platinum'];
export type Rules = 'easy' | 'normal' | 'hard' | 'free';
export interface PuzzleProgress {
  best?: number; cleared?: boolean; underLimit?: boolean; medal?: Medal;
  /** best time per rules (times under different rules can't be compared) */
  times?: Partial<Record<Rules, number>>;
  /** first solved (for "this week" in the high scores) */
  at?: string;
  /** PixELO: the first solve under each rule set (game/rating.ts) */
  rated?: Partial<Record<Rules, { at: string; pr: number; s: number }>>;
  /** points this puzzle is worth so far (its best result; only goes up) */
  pts?: number;
}

/** Mega puzzles are a game of their own: progress, points and PixELO are counted apart */
export type Mode = 'normal' | 'mega' | 'color';
export const modeOf = (puzzleKey: string): Mode => (puzzleKey.endsWith('@mega') ? 'mega' : puzzleKey.endsWith('@color') ? 'color' : 'normal');

// ---- time: a MomoGram server's clock, when there is one (a device with a wrong clock must not win every merge) ----
let clockOffset = Number(localStorage.getItem('momogram.clockOffset') || 0) || 0;
export function nowIso(): string { return new Date(Date.now() + clockOffset).toISOString(); }
export function setServerTime(serverNow: string) {
  const d = Date.parse(serverNow) - Date.now();
  if (!Number.isFinite(d)) return;
  // the server answers with whole seconds: only follow differences above two seconds
  clockOffset = Math.abs(d) > 2000 ? d : 0;
  localStorage.setItem('momogram.clockOffset', String(clockOffset));
}
export interface Settings {
  lang: string;
  music: boolean;
  musicVolume: number;
  sfx: boolean;
  hints: 'ask' | 'always' | 'never';
  unlockAll: boolean;
  normalStyle: string; // unused (older versions)
  freeStyle: string;
  lefty: boolean;
  showTimer: boolean;
  packMusic: boolean; // play the games' own music
  packColors: boolean; // colour the screens like the pack's original game
  look?: 'auto' | 'light' | 'dark'; // dark mode for the menus (the boards keep their look); per device
  /** Mega mode: the games' own Mega puzzles get a glowing dot (mark), aren't marked (none), or are the only ones shown */
  megaMark?: 'none' | 'mark' | 'only';
  /** the whole game's mode: plain, Mega or Colour nonograms. Stays on this device (a phone in Color must not switch the desktop). */
  mode?: Mode;
  /** the tutorials already offered (basic, mega, color): never asked again, on any device */
  tutAsked?: string[];
  difficulty: 'auto' | 'easy' | 'normal' | 'hard'; // auto = the level's own rules
  logicHints: boolean;
  /** finished lines get their crosses filled in. Silver at best. */
  lazy: boolean;
  toolsRight: boolean;
  musicMode: 'random-pack' | 'random-all' | 'fixed'; // in-game music
  mega: boolean; // the whole game in Mega mode
}

const DEFAULTS: Settings = {
  lang: '', music: true, musicVolume: 0.7, sfx: true, hints: 'ask', unlockAll: false,
  normalStyle: 'stage_jazz_SEQ', freeStyle: 'stage_musicbox_SEQ', lefty: false, showTimer: true,
  packMusic: true, packColors: true, megaMark: 'mark', look: 'auto', mode: 'normal', tutAsked: [], difficulty: 'auto', logicHints: false, lazy: false, toolsRight: false, musicMode: 'random-pack', mega: false,
};

function readJson<T>(k: string, def: T): T {
  try { const v = localStorage.getItem(k); return v ? { ...def, ...JSON.parse(v) } : def; } catch { return def; }
}

export const settings: Settings = readJson('momogram.settings', DEFAULTS);
/** settings that belong to this device and aren't synced with an account */
const DEVICE_SETTINGS: Array<keyof Settings> = ['music', 'musicVolume', 'sfx', 'lefty', 'toolsRight', 'normalStyle', 'freeStyle', 'look', 'mode', 'mega'];
export function saveSettings() {
  const old = localStorage.getItem('momogram.settings');
  localStorage.setItem('momogram.settings', JSON.stringify(settings));
  // only a change of a shared setting counts for syncing
  try {
    const was = old ? JSON.parse(old) : {};
    if (Object.keys(settings).some(k => !DEVICE_SETTINGS.includes(k as keyof Settings) && JSON.stringify(was[k]) !== JSON.stringify((settings as any)[k]))) {
      localStorage.setItem('momogram.settingstime', nowIso());
      changed();
    }
  } catch { /* ignore */ }
}
export interface LibPrefs { order: string[]; hidden: string[]; group: 'series' | 'system' | 'none'; view?: 'cards' | 'tiles' | 'list' }
const emptyLib = (): LibPrefs => ({ order: [], hidden: [], group: 'series' });
/** library order, hidden games and view, per profile (synced). An id stays in the order after the game is removed. */
export function libPrefs(): LibPrefs {
  try {
    const raw = localStorage.getItem(pk('library')) ?? localStorage.getItem('momogram.library');
    const p = { ...emptyLib(), ...(raw ? JSON.parse(raw) : {}) };
    if (!localStorage.getItem(pk('library')) && raw) localStorage.setItem(pk('library'), JSON.stringify(p));
    return p;
  } catch { return emptyLib(); }
}
export function setLibPrefs(p: LibPrefs) {
  localStorage.setItem(pk('library'), JSON.stringify(p));
  localStorage.setItem(pk('librarytime'), nowIso());
  changed();
}

export interface SongMark { broken?: boolean; note?: string; at?: string }
function songMap(): Record<string, SongMark> {
  try { return JSON.parse(localStorage.getItem(pk('songs')) || '{}'); } catch { return {}; }
}
/** notes and "broken" flags for songs, keyed like a track (synced with the profile) */
export function songMarks(): Record<string, SongMark> { return songMap(); }
export function songMark(key: string): SongMark | undefined {
  const m = songMap()[key];
  return m && (m.broken || m.note) ? m : undefined;
}
export function setSongMark(key: string, m: { broken?: boolean; note?: string } | null) {
  const all = songMap();
  const note = m?.note?.trim().slice(0, 200);
  if (!m || (!m.broken && !note)) all[key] = { at: nowIso() };
  else all[key] = { ...(m.broken ? { broken: true } : {}), ...(note ? { note } : {}), at: nowIso() };
  localStorage.setItem(pk('songs'), JSON.stringify(all));
  localStorage.setItem(pk('songstime'), nowIso());
  changed();
}

function sharedSettings(): Partial<Settings> {
  const out: any = {};
  for (const [k, v] of Object.entries(settings)) if (!DEVICE_SETTINGS.includes(k as keyof Settings)) out[k] = v;
  return out;
}

// ---- change notifications (the server sync listens) ----
const listeners: Array<() => void> = [];
export function onLocalChange(f: () => void) { listeners.push(f); }
function changed() { for (const f of listeners) try { f(); } catch { /* ignore */ } }

type ProgressMap = Record<string, PuzzleProgress>;

// ---- profiles: each one has its own progress and quick save on this device ----
export interface Profile { id: string; name: string; created: string }
const PKEY = 'momogram.profiles';
function loadProfiles(): Profile[] { try { return JSON.parse(localStorage.getItem(PKEY) || '[]'); } catch { return []; } }
function storeProfiles(p: Profile[]) { localStorage.setItem(PKEY, JSON.stringify(p)); }
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

(function migrate() {
  // the first version had one unnamed save: it becomes the first profile
  if (loadProfiles().length) return;
  const id = newId();
  storeProfiles([{ id, name: localStorage.getItem('momogram.saveName') || 'Player', created: nowIso() }]);
  localStorage.setItem('momogram.profile', id);
  for (const k of ['progress', 'quick']) {
    const v = localStorage.getItem('momogram.' + k);
    if (v !== null) { localStorage.setItem(`momogram.${k}.${id}`, v); localStorage.removeItem('momogram.' + k); }
  }
})();

export function profiles(): Profile[] { return loadProfiles(); }
export function activeProfile(): Profile {
  const all = loadProfiles();
  return all.find(p => p.id === localStorage.getItem('momogram.profile')) ?? all[0];
}
const pk = (k: string) => `momogram.${k}.${activeProfile().id}`;

let progress: ProgressMap = {};
/** per pack: when its progress last changed (ISO date) — decides what an import may overwrite */
let packTimes: Record<string, string> = {};
/** per pack: when its progress was last reset — an older clear elsewhere must not bring it back */
let resetTimes: Record<string, string> = {};
function loadActive() {
  try { resetTimes = JSON.parse(localStorage.getItem(pk('resets')) || '{}'); } catch { resetTimes = {}; }
  try { progress = JSON.parse(localStorage.getItem(pk('progress')) || '{}'); } catch { progress = {}; }
  try { packTimes = JSON.parse(localStorage.getItem(pk('packtimes')) || '{}'); } catch { packTimes = {}; }
  const fixed = [...new Set([...dropCopies(progress), ...giveOldMedals(progress)])];
  if (fixed.length) persist(fixed);
}
/**
 * MomoGram 0.13 – 0.37.4 copied old daily solves into the Mega and Colour puzzle of the same picture (when the
 * home screen showed that mode), as if they had been solved there. Such a copy has the plain puzzle's time and no
 * times per rules (every real solve since 0.13 has them): it is removed. Works on "pack/puzzle" keys or on one
 * pack's puzzle ids; returns the packs that had copies.
 */
/**
 * Puzzles solved before MomoGram had medals have none, so they counted as solved but showed in no medal count
 * (and got no points). Back then the game caught mistakes and added time for them, like Normal rules: silver.
 */
function giveOldMedals(m: Record<string, PuzzleProgress>): string[] {
  const packs = new Set<string>();
  for (const [k, v] of Object.entries(m)) if (v.cleared && !v.medal) { v.medal = 'silver'; packs.add(k.slice(0, k.indexOf('/'))); }
  return [...packs];
}
function dropCopies(m: Record<string, PuzzleProgress>): string[] {
  const packs = new Set<string>();
  for (const k of Object.keys(m)) {
    const at = k.search(/@(mega|color)$/);
    if (at < 0) continue;
    const v = m[k], plain = m[k.slice(0, at)];
    if (!v.times && plain && v.best !== undefined && plain.best === v.best) { delete m[k]; packs.add(k.slice(0, k.indexOf('/'))); }
  }
  return [...packs];
}
loadActive();
// keep this tab's copy current when another tab (or the installed web app) saves
window.addEventListener('storage', e => { if (e.key?.startsWith('momogram.progress.') || e.key?.startsWith('momogram.packtimes.')) loadActive(); });
function persist(touched?: string[]) {
  const now = nowIso();
  for (const id of touched ?? []) packTimes[id] = now;
  localStorage.setItem(pk('progress'), JSON.stringify(progress));
  localStorage.setItem(pk('packtimes'), JSON.stringify(packTimes));
  if (touched?.length) changed();
}

export function switchProfile(id: string) { if (loadProfiles().some(p => p.id === id)) { localStorage.setItem('momogram.profile', id); loadActive(); } }
export function createProfile(name: string, id = newId()): Profile {
  const p: Profile = { id, name: name.trim().slice(0, 40) || 'Player', created: nowIso() };
  storeProfiles([...loadProfiles(), p]);
  switchProfile(p.id);
  return p;
}
export function renameProfile(name: string) {
  const all = loadProfiles(), me = activeProfile();
  storeProfiles(all.map(p => p.id === me.id ? { ...p, name: name.trim().slice(0, 40) || p.name } : p));
}
export function deleteProfile(id: string) {
  const all = loadProfiles().filter(p => p.id !== id);
  if (!all.length) return;
  storeProfiles(all);
  for (const k of ['progress', 'quick', 'quicktime', 'boards', 'packtimes', 'resets', 'account']) localStorage.removeItem(`momogram.${k}.${id}`);
  if (localStorage.getItem('momogram.profile') === id) switchProfile(all[0].id);
}

export function getProgress(packId: string, puzzleId: string): PuzzleProgress {
  return progress[packId + '/' + puzzleId] ?? {};
}

/** progress of one pack: [puzzle id, progress] */
export function packProgress(packId: string): Array<[string, PuzzleProgress]> {
  const pre = packId + '/';
  return Object.entries(progress).filter(([k]) => k.startsWith(pre)).map(([k, v]) => [k.slice(pre.length), v]);
}

/** returns true when the medal is better than the one the puzzle had */
export function recordClear(packId: string, puzzleId: string, totalMs: number, underLimit: boolean, medal?: Medal, rules?: Rules,
  extra?: { rated?: { pr: number; s: number }; pts?: (best: PuzzleProgress) => number }): boolean {
  loadActive(); // another tab / the installed app may have saved meanwhile: never write back an old copy
  const k = packId + '/' + puzzleId;
  const p = progress[k] ?? {};
  // PixELO: only the first solve under these rules is rated
  if (rules && extra?.rated && !p.rated?.[rules]) (p.rated ??= {})[rules] = { at: nowIso(), ...extra.rated };
  if (!p.cleared) p.at = nowIso();
  p.cleared = true;
  if (rules) { p.times ??= {}; if (p.times[rules] === undefined || totalMs < p.times[rules]!) p.times[rules] = totalMs; }
  const better = !!medal && (!p.medal || MEDALS.indexOf(medal) > MEDALS.indexOf(p.medal));
  if (better) p.medal = medal;
  if (underLimit) p.underLimit = true;
  if (p.best === undefined || totalMs < p.best) p.best = totalMs;
  if (extra?.pts) p.pts = Math.max(p.pts ?? 0, extra.pts(p));
  progress[k] = p;
  persist([packId]);
  return better;
}

export function resetProgress(packId: string) {
  loadActive();
  for (const k of Object.keys(progress)) if (k.startsWith(packId + '/')) delete progress[k];
  resetTimes[packId] = nowIso();
  localStorage.setItem(pk('resets'), JSON.stringify(resetTimes));
  persist([packId]);
}

export interface QuickSave {
  packId: string; levelId: string; puzzleId: string; state: BoardSnapshot;
  /** the puzzle itself, for puzzles that aren't part of a stored pack (daily puzzles) */
  puzzle?: import('./packs/format').PackPuzzle; level?: { title: import('./packs/format').PackLevel['title']; rules: import('./packs/format').PackLevel['rules'] }; packTitle?: Pack['title'];
}
// ---- boards in progress: every puzzle keeps its own, the latest one is "Continue" on the home screen ----
// A finished or abandoned board stays as an empty entry for a while, so a sync can't bring an old copy back.
export type Boards = Record<string, { q: QuickSave | null; saved: string }>;
const bkey = (packId: string, levelId: string, puzzleId: string) => `${packId}|${levelId}|${puzzleId}`;
const MAX_BOARDS = 60, KEEP_GONE = 45 * 86400000;
export function loadBoards(): Boards {
  let b: Boards = {};
  try { b = JSON.parse(localStorage.getItem(pk('boards')) || '{}'); } catch { b = {}; }
  // older versions: one quick save
  const old = localStorage.getItem(pk('quick'));
  if (old) {
    try { const q: QuickSave = JSON.parse(old); if (q) b[bkey(q.packId, q.levelId, q.puzzleId)] = { q, saved: localStorage.getItem(pk('quicktime')) || nowIso() }; } catch { /* ignore */ }
    localStorage.removeItem(pk('quick'));
    storeBoards(b);
  }
  return b;
}
function storeBoards(b: Boards) {
  const now = Date.now();
  const live = Object.entries(b).filter(([, v]) => v.q).sort((x, y) => y[1].saved.localeCompare(x[1].saved));
  const out: Boards = {};
  for (const [k, v] of live.slice(0, MAX_BOARDS)) out[k] = v;
  for (const [k, v] of Object.entries(b)) if (!v.q && now - Date.parse(v.saved) < KEEP_GONE) out[k] = v;
  localStorage.setItem(pk('boards'), JSON.stringify(out));
}
/** keep a board to come back to */
export function saveBoard(q: QuickSave) {
  const b = loadBoards();
  b[bkey(q.packId, q.levelId, q.puzzleId)] = { q, saved: nowIso() };
  storeBoards(b); changed();
}
/** the puzzle was solved, restarted or given up: its board is gone */
export function clearBoard(packId: string, levelId: string, puzzleId: string) {
  const b = loadBoards(), k = bkey(packId, levelId, puzzleId);
  if (!b[k]?.q) return;
  b[k] = { q: null, saved: nowIso() };
  storeBoards(b); changed();
}
export function getBoard(packId: string, levelId: string, puzzleId: string): QuickSave | null {
  return loadBoards()[bkey(packId, levelId, puzzleId)]?.q ?? null;
}
/** the board played last */
export function getQuickSave(mode?: Mode): QuickSave | null { return latestBoard(loadBoards(), mode)?.q ?? null; }
function latestBoard(b: Boards, mode?: Mode) {
  let best: Boards[string] | null = null;
  for (const v of Object.values(b)) if (v.q && (!mode || modeOf(v.q.puzzleId) === mode) && (!best || v.saved > best.saved)) best = v;
  return best;
}
/** join boards from elsewhere: per puzzle, the newer one wins (an empty entry too) */
function mergeBoards(remote: Boards): boolean {
  const b = loadBoards();
  let any = false;
  for (const [k, v] of Object.entries(remote)) {
    if (b[k] && b[k].saved >= v.saved) continue;
    b[k] = v; any = true;
  }
  if (any) storeBoards(b);
  return any;
}

// ---- save files: the active profile, every pack with its own timestamp ----
// Progress is keyed "packId/puzzleId", so a save works with any set of installed packs: entries of packs that
// aren't installed simply wait until that pack is imported, and nothing of them is touched in between.
// A puzzle that a later import no longer lists (a placeholder copy, or a puzzle dropped by a bad read) keeps its
// record. Solved totals and points skip it while the pack on this device does not contain that puzzle; the
// record counts again if the puzzle comes back. Packs that are not installed here are still counted in full.

/** pack id → puzzle ids that pack currently lists (base ids, without @mega / @color). Null means "not installed". */
let knownPuzzles: (() => Map<string, Set<string>>) | null = null;
export function setKnownPuzzles(fn: () => Map<string, Set<string>>) { knownPuzzles = fn; }

/** true when this solve should add to solved totals and points */
export function puzzleCounts(packId: string, puzzleId: string): boolean {
  const ids = knownPuzzles?.().get(packId);
  if (!ids) return true;
  return ids.has(puzzleId.replace(/@(mega|color)$/, ''));
}

export interface SaveFile {
  format: 'momogram-save'; version: 2;
  profile: { id: string; name: string };
  saved: string;
  packs: Record<string, { updated: string; progress: Record<string, PuzzleProgress>; reset?: string; have?: string[] }>;
  quick: QuickSave | null;
  settings?: Partial<Settings>;
  quickSaved?: string; // when the quick save was last set or cleared (older versions)
  boards?: Boards; // every board in progress
  settingsSaved?: string; // when a shared setting last changed
  practice?: PracticeBests; // best results of the practice games
  library?: LibPrefs;
  librarySaved?: string;
  songs?: Record<string, SongMark>;
  songsSaved?: string;
}

// ---- practice: the best result per game and mode ("sprint@mega"), kept with the profile and synced ----
// Sprint counts solved puzzles (more is better); every other game is a time (less is better).
export type PracticeBests = Record<string, number>;
const practiceHigher = (slot: string) => slot.startsWith('sprint');
const pracKey = () => 'momogram.practice.' + activeProfile().id;
export function practiceBests(): PracticeBests { try { return JSON.parse(localStorage.getItem(pracKey()) || '{}'); } catch { return {}; } }
/** keeps a result when it beats the best one; true when it does */
export function recordPractice(slot: string, score: number): boolean {
  const b = practiceBests(), old = b[slot];
  if (old !== undefined && (practiceHigher(slot) ? score <= old : score >= old)) return false;
  b[slot] = score;
  try { localStorage.setItem(pracKey(), JSON.stringify(b)); } catch { /* full */ }
  changed();
  return true;
}
/** both sides' bests joined (the better of each); true when this device learned something */
function mergePractice(other: PracticeBests | undefined): boolean {
  if (!other) return false;
  const b = practiceBests();
  let any = false;
  for (const [k, v] of Object.entries(other)) {
    if (typeof v !== 'number' || !isFinite(v)) continue;
    const o = b[k];
    if (o === undefined || (practiceHigher(k) ? v > o : v < o)) { b[k] = v; any = true; }
  }
  if (any) try { localStorage.setItem(pracKey(), JSON.stringify(b)); } catch { /* full */ }
  return any;
}

function packsOf(p: ProgressMap): SaveFile['packs'] {
  const out: SaveFile['packs'] = {};
  for (const [k, v] of Object.entries(p)) {
    const i = k.lastIndexOf('/'), id = k.slice(0, i);
    (out[id] ??= { updated: packTimes[id] ?? '1970-01-01T00:00:00.000Z', progress: {} }).progress[k.slice(i + 1)] = v;
  }
  for (const id of Object.keys(packTimes)) out[id] ??= { updated: packTimes[id], progress: {} }; // reset packs too
  for (const [id, r] of Object.entries(resetTimes)) if (out[id]) out[id].reset = r;
  // puzzles the installed pack still lists. The server ignores solves that are not in this list; every progress
  // entry is still written above, so a puzzle that disappeared is not deleted from the save.
  const known = knownPuzzles?.();
  if (known) for (const [id, pk] of Object.entries(out)) { const ids = known.get(id); if (ids) pk.have = [...ids]; }
  return out;
}

export function makeSave(): SaveFile {
  const me = activeProfile();
  return {
    format: 'momogram-save', version: 2, profile: { id: me.id, name: me.name }, saved: nowIso(), packs: packsOf(progress), quick: getQuickSave(), boards: loadBoards(),
    settings: sharedSettings(), quickSaved: latestBoard(loadBoards())?.saved, settingsSaved: localStorage.getItem('momogram.settingstime') ?? undefined,
    practice: practiceBests(),
    library: libPrefs(), librarySaved: localStorage.getItem(pk('librarytime')) ?? undefined,
    songs: songMap(), songsSaved: localStorage.getItem(pk('songstime')) ?? undefined,
  };
}

/** keep every id from both orders: a game deleted on one device still has its place when it is imported again */
function joinOrder(newer: string[], older: string[]): string[] {
  const out = [...newer];
  for (const id of older) if (!out.includes(id)) out.push(id);
  return out;
}
function mergeLibrary(s: SaveFile): boolean {
  if (!s.library || !s.librarySaved) return false;
  const lt = localStorage.getItem(pk('librarytime'));
  const cur = libPrefs();
  const remoteFirst = !lt || s.librarySaved > lt;
  const order = joinOrder(remoteFirst ? (s.library.order ?? []) : cur.order, remoteFirst ? cur.order : (s.library.order ?? []));
  const next: LibPrefs = remoteFirst
    ? { order, hidden: s.library.hidden ?? [], group: s.library.group || 'series', view: s.library.view }
    : { ...cur, order };
  if (JSON.stringify(next) === JSON.stringify(cur) && lt) return false;
  localStorage.setItem(pk('library'), JSON.stringify(next));
  if (remoteFirst) localStorage.setItem(pk('librarytime'), s.librarySaved);
  else if (!lt || order.length !== cur.order.length) localStorage.setItem(pk('librarytime'), nowIso());
  return true;
}
function mergeSongs(s: SaveFile): boolean {
  if (!s.songs) return false;
  const mine = songMap();
  let any = false;
  for (const [k, v] of Object.entries(s.songs)) {
    if (!v || typeof v !== 'object') continue;
    const o = mine[k];
    if (!o || (v.at && (!o.at || v.at > o.at))) { mine[k] = v; any = true; }
  }
  if (!any) return false;
  localStorage.setItem(pk('songs'), JSON.stringify(mine));
  const st = localStorage.getItem(pk('songstime'));
  if (s.songsSaved && (!st || s.songsSaved > st)) localStorage.setItem(pk('songstime'), s.songsSaved);
  else localStorage.setItem(pk('songstime'), nowIso());
  return true;
}

/**
 * Merge a save of the active profile (from the server) into this device: per pack the newer data wins, the quick
 * save and the shared settings likewise. Returns true when anything here changed.
 */
export function mergeSave(s: SaveFile): boolean {
  loadActive();
  let any = false;
  for (const [id, rp] of Object.entries(s.packs)) {
    dropCopies(rp.progress); // copies another device (or the server) still has don't come back
    giveOldMedals(rp.progress);
    const local = packTimes[id];
    const mine: Record<string, PuzzleProgress> = {};
    for (const [k, v] of Object.entries(progress)) if (k.startsWith(id + '/')) mine[k.slice(id.length + 1)] = v;
    // a reset on one side drops what the other side did before it; otherwise both sides are joined puzzle by puzzle.
    // a puzzle the pack no longer lists is kept too: a bad import must not delete its record
    let merged: Record<string, PuzzleProgress>;
    if (!local || (rp.reset && rp.reset > local)) merged = { ...rp.progress };
    else if (resetTimes[id] && resetTimes[id] > rp.updated) merged = mine;
    else {
      merged = { ...mine };
      for (const [pz, v] of Object.entries(rp.progress)) merged[pz] = bestOf(merged[pz], v);
    }
    const same = (x: Record<string, PuzzleProgress>) => JSON.stringify(sortKeys(x)) === JSON.stringify(sortKeys(merged));
    if (rp.reset && (!resetTimes[id] || rp.reset > resetTimes[id])) { resetTimes[id] = rp.reset; any = true; }
    if (same(mine) && local) continue;
    for (const k of Object.keys(mine)) delete progress[id + '/' + k];
    for (const [pz, v] of Object.entries(merged)) progress[id + '/' + pz] = { ...v };
    // the result is what the server has: take its time; something new from both sides: it's new for everyone
    packTimes[id] = same(rp.progress) ? rp.updated : nowIso();
    any = true;
  }
  if (any) { localStorage.setItem(pk('resets'), JSON.stringify(resetTimes)); persist(); }
  any = mergePractice(s.practice) || any;
  if (s.boards) any = mergeBoards(s.boards) || any;
  else if (s.quick && s.quickSaved) any = mergeBoards({ [bkey(s.quick.packId, s.quick.levelId, s.quick.puzzleId)]: { q: s.quick, saved: s.quickSaved } }) || any;
  any = mergeLibrary(s) || any;
  any = mergeSongs(s) || any;
  const st = localStorage.getItem('momogram.settingstime');
  if (s.settings && s.settingsSaved && (!st || s.settingsSaved > st)) {
    for (const [k, v] of Object.entries(s.settings)) if (!DEVICE_SETTINGS.includes(k as keyof Settings) && k in DEFAULTS) (settings as any)[k] = v;
    localStorage.setItem('momogram.settings', JSON.stringify(settings));
    localStorage.setItem('momogram.settingstime', s.settingsSaved);
    any = true;
  }
  return any;
}

function sortKeys(o: Record<string, PuzzleProgress>) {
  return Object.keys(o).sort().map(k => [k, Object.keys(o[k]).sort().map(j => [j, (o[k] as any)[j]])]);
}
function bestOf(a: PuzzleProgress | undefined, b: PuzzleProgress): PuzzleProgress {
  if (!a) return { ...b };
  const medal = !a.medal ? b.medal : !b.medal ? a.medal : MEDALS.indexOf(a.medal) >= MEDALS.indexOf(b.medal) ? a.medal : b.medal;
  const best = a.best === undefined ? b.best : b.best === undefined ? a.best : Math.min(a.best, b.best);
  const out: PuzzleProgress = { ...a, ...b };
  if (a.cleared || b.cleared) out.cleared = true;
  if (a.underLimit || b.underLimit) out.underLimit = true;
  if (medal) out.medal = medal; else delete out.medal;
  if (best !== undefined) out.best = best; else delete out.best;
  // per rules: the better time of the two; first solved: the earlier date
  if (a.times || b.times) {
    out.times = { ...a.times };
    for (const [r, ms] of Object.entries(b.times ?? {})) if (out.times[r as Rules] === undefined || ms! < out.times[r as Rules]!) out.times[r as Rules] = ms;
  }
  if (a.at && b.at) out.at = a.at < b.at ? a.at : b.at;
  // points: the higher; rated solves: per rule set the earlier one
  if (a.pts !== undefined || b.pts !== undefined) out.pts = Math.max(a.pts ?? 0, b.pts ?? 0);
  if (a.rated || b.rated) {
    out.rated = { ...a.rated };
    for (const [r, v] of Object.entries(b.rated ?? {})) { const o = out.rated[r as Rules]; if (!o || (v && v.at < o.at)) out.rated[r as Rules] = v; }
  }
  return out;
}

/** give a local profile another id (to join it with an account's profile); its progress moves along */
export function rekeyProfile(from: string, to: string, name?: string) {
  if (from === to) return;
  for (const k of ['progress', 'quick', 'quicktime', 'boards', 'packtimes', 'resets', 'account']) {
    const v = localStorage.getItem(`momogram.${k}.${from}`);
    if (v !== null) localStorage.setItem(`momogram.${k}.${to}`, v);
    localStorage.removeItem(`momogram.${k}.${from}`);
  }
  storeProfiles(loadProfiles().map(p => p.id === from ? { ...p, id: to, name: name ?? p.name } : p));
  if (localStorage.getItem('momogram.profile') === from) localStorage.setItem('momogram.profile', to);
  loadActive();
}

/** the active profile's numbers as the server's high scores count them (this device may be newer than the server) */
export interface ModeStats { solved: number; week: number; medals: Record<Medal, number>; packs: Record<string, number>; time: number; points: number; elo: number; peak: number; rated: number }
export function localStats(mode: Mode = 'normal'): ModeStats {
  const out = { solved: 0, week: 0, medals: { bronze: 0, silver: 0, gold: 0, platinum: 0 } as Record<Medal, number>, packs: {} as Record<string, number>, time: 0, points: 0, elo: 1000, peak: 1000, rated: 0 };
  const week = new Date(Date.parse(nowIso()) - 7 * 86400000).toISOString();
  const solves: Array<{ at: string; pr: number; s: number }> = [];
  for (const [k, v] of Object.entries(progress)) {
    if (!v.cleared || modeOf(k) !== mode) continue;
    const slash = k.lastIndexOf('/'), id = k.slice(0, slash);
    if (id.startsWith('my-')) continue; // packs made in the editor don't count
    if (!puzzleCounts(id, k.slice(slash + 1))) continue; // kept in the save; the pack no longer lists this puzzle
    out.solved++; out.packs[id] = (out.packs[id] ?? 0) + 1;
    if (v.at && v.at >= week) out.week++;
    if (v.medal) out.medals[v.medal]++;
    if (v.best !== undefined) out.time += v.best;
    out.points += v.pts ?? 0;
    for (const r of Object.values(v.rated ?? {})) if (r) solves.push(r);
  }
  const e = replay(solves);
  return { ...out, elo: e.elo, peak: e.peak, rated: e.n };
}

/** every cleared puzzle of a mode without points yet (older progress): [pack id, puzzle id, progress] */
export function unpointed(): Array<[string, string, PuzzleProgress]> {
  return Object.entries(progress).filter(([, v]) => v.cleared && v.medal && v.pts === undefined).map(([k, v]) => { const i = k.lastIndexOf('/'); return [k.slice(0, i), k.slice(i + 1), v]; });
}
/** set points worked out later (older progress) */
export function setPoints(list: Array<[string, string, number]>) {
  if (!list.length) return;
  loadActive();
  const packs = new Set<string>();
  for (const [pid, pz, n] of list) { const p = progress[pid + '/' + pz]; if (p && (p.pts ?? 0) < n) { p.pts = n; packs.add(pid); } }
  if (packs.size) persist([...packs]);
}

/** solved puzzles per pack id (of the active profile, or of a save) */
export function progressSummary(s?: SaveFile): Map<string, number> {
  const m = new Map<string, number>();
  for (const [id, pk] of Object.entries(s ? s.packs : packsOf(progress))) {
    let n = 0;
    for (const [pz, v] of Object.entries(pk.progress)) if (v.cleared && puzzleCounts(id, pz)) n++;
    m.set(id, n);
  }
  return m;
}

/**
 * Import a save. Same profile already on this device: only packs whose data in the save is newer replace the
 * local ones, so playing different packs on different devices merges cleanly. Unknown profile: it is added.
 * Returns what happened, for the message.
 */
export function importSave(s: SaveFile): { profile: string; created: boolean; packsTaken: number; packsKept: number } {
  const exists = loadProfiles().some(p => p.id === s.profile.id);
  if (!exists) createProfile(s.profile.name, s.profile.id); else switchProfile(s.profile.id);
  let taken = 0, kept = 0;
  for (const [id, pk] of Object.entries(s.packs)) {
    const local = packTimes[id];
    if (exists && local && local >= pk.updated) { kept++; continue; }
    for (const k of Object.keys(progress)) if (k.startsWith(id + '/')) delete progress[k];
    for (const [pz, v] of Object.entries(pk.progress)) progress[id + '/' + pz] = { ...v };
    packTimes[id] = pk.updated;
    taken++;
  }
  persist();
  if (s.boards) mergeBoards(s.boards);
  else if (s.quick) mergeBoards({ [bkey(s.quick.packId, s.quick.levelId, s.quick.puzzleId)]: { q: s.quick, saved: s.quickSaved ?? s.saved } });
  if (!exists && s.settings) { Object.assign(settings, s.settings); saveSettings(); }
  return { profile: s.profile.name, created: !exists, packsTaken: taken, packsKept: kept };
}

export function isSaveFile(x: any): x is SaveFile { return x && x.format === 'momogram-save' && x.version === 2 && x.profile && typeof x.packs === 'object'; }
