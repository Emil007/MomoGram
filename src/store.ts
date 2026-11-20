// Persistent storage: the user's ROM and packs in IndexedDB, progress/settings in localStorage.
import type { Pack } from './packs/format';
import { compressAsset, decompressAsset } from './util/files';
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

export const storage = {
  saveRom: (key: string, data: Uint8Array) => tx('roms', 'readwrite', s => s.put(data, key)),
  loadRom: (key: string) => tx<Uint8Array | undefined>('roms', 'readonly', s => s.get(key)),
  deleteRom: (key: string) => tx('roms', 'readwrite', s => s.delete(key)),
  savePack: (p: Pack) => tx('packs', 'readwrite', s => s.put(p, p.id)),
  deletePack: (id: string) => tx('packs', 'readwrite', s => s.delete(id)),
  allPacks: () => tx<Pack[]>('packs', 'readonly', s => s.getAll()),
  // music and other binary files of a pack, keyed "packId/name"
  // assets are stored compressed where that saves space and unpacked transparently when loaded
  saveAsset: async (packId: string, name: string, data: Uint8Array) => { const z = await compressAsset(data); return tx('assets', 'readwrite', s => s.put(z, packId + '/' + name)); },
  loadAsset: (packId: string, name: string) => tx<Uint8Array | undefined>('assets', 'readonly', s => s.get(packId + '/' + name)).then(d => d && decompressAsset(d)),
  assetNames: (packId: string) => tx<IDBValidKey[]>('assets', 'readonly', s => s.getAllKeys(IDBKeyRange.bound(packId + '/', packId + '/\uffff')))
    .then(k => k.map(x => String(x).slice(packId.length + 1))),
  deleteAssets: (packId: string) => tx('assets', 'readwrite', s => s.delete(IDBKeyRange.bound(packId + '/', packId + '/\uffff'))),
  async persist() { try { await navigator.storage?.persist?.(); } catch { /* ignore */ } },
};

// ---- progress & settings ----

export type Medal = 'bronze' | 'silver' | 'gold' | 'platinum';
export const MEDALS: Medal[] = ['bronze', 'silver', 'gold', 'platinum'];
export interface PuzzleProgress { best?: number; cleared?: boolean; underLimit?: boolean; medal?: Medal }
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
  difficulty: 'auto' | 'easy' | 'normal' | 'hard'; // auto = the level's own rules
  logicHints: boolean;
  toolsRight: boolean;
  musicMode: 'random-pack' | 'random-all' | 'fixed'; // in-game music
}

const DEFAULTS: Settings = {
  lang: '', music: true, musicVolume: 0.7, sfx: true, hints: 'ask', unlockAll: false,
  normalStyle: 'stage_jazz_SEQ', freeStyle: 'stage_musicbox_SEQ', lefty: false, showTimer: true,
  packMusic: true, packColors: true, difficulty: 'auto', logicHints: false, toolsRight: false, musicMode: 'random-pack',
};

function readJson<T>(k: string, def: T): T {
  try { const v = localStorage.getItem(k); return v ? { ...def, ...JSON.parse(v) } : def; } catch { return def; }
}

export const settings: Settings = readJson('momogram.settings', DEFAULTS);
/** settings that belong to this device and aren't synced with an account */
const DEVICE_SETTINGS: Array<keyof Settings> = ['music', 'musicVolume', 'sfx', 'lefty', 'toolsRight', 'normalStyle', 'freeStyle'];
export function saveSettings() {
  const old = localStorage.getItem('momogram.settings');
  localStorage.setItem('momogram.settings', JSON.stringify(settings));
  // only a change of a shared setting counts for syncing
  try {
    const was = old ? JSON.parse(old) : {};
    if (Object.keys(settings).some(k => !DEVICE_SETTINGS.includes(k as keyof Settings) && JSON.stringify(was[k]) !== JSON.stringify((settings as any)[k]))) {
      localStorage.setItem('momogram.settingstime', new Date().toISOString());
      changed();
    }
  } catch { /* ignore */ }
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
  storeProfiles([{ id, name: localStorage.getItem('momogram.saveName') || 'Player', created: new Date().toISOString() }]);
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
}
loadActive();
// keep this tab's copy current when another tab (or the installed web app) saves
window.addEventListener('storage', e => { if (e.key?.startsWith('momogram.progress.') || e.key?.startsWith('momogram.packtimes.')) loadActive(); });
function persist(touched?: string[]) {
  const now = new Date().toISOString();
  for (const id of touched ?? []) packTimes[id] = now;
  localStorage.setItem(pk('progress'), JSON.stringify(progress));
  localStorage.setItem(pk('packtimes'), JSON.stringify(packTimes));
  if (touched?.length) changed();
}

export function switchProfile(id: string) { if (loadProfiles().some(p => p.id === id)) { localStorage.setItem('momogram.profile', id); loadActive(); } }
export function createProfile(name: string, id = newId()): Profile {
  const p: Profile = { id, name: name.trim().slice(0, 40) || 'Player', created: new Date().toISOString() };
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

/** returns true when the medal is better than the one the puzzle had */
export function recordClear(packId: string, puzzleId: string, totalMs: number, underLimit: boolean, medal?: Medal): boolean {
  loadActive(); // another tab / the installed app may have saved meanwhile: never write back an old copy
  const k = packId + '/' + puzzleId;
  const p = progress[k] ?? {};
  p.cleared = true;
  const better = !!medal && (!p.medal || MEDALS.indexOf(medal) > MEDALS.indexOf(p.medal));
  if (better) p.medal = medal;
  if (underLimit) p.underLimit = true;
  if (p.best === undefined || totalMs < p.best) p.best = totalMs;
  progress[k] = p;
  persist([packId]);
  return better;
}

export function resetProgress(packId: string) {
  loadActive();
  for (const k of Object.keys(progress)) if (k.startsWith(packId + '/')) delete progress[k];
  resetTimes[packId] = new Date().toISOString();
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
    try { const q: QuickSave = JSON.parse(old); if (q) b[bkey(q.packId, q.levelId, q.puzzleId)] = { q, saved: localStorage.getItem(pk('quicktime')) || new Date().toISOString() }; } catch { /* ignore */ }
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
  b[bkey(q.packId, q.levelId, q.puzzleId)] = { q, saved: new Date().toISOString() };
  storeBoards(b); changed();
}
/** the puzzle was solved, restarted or given up: its board is gone */
export function clearBoard(packId: string, levelId: string, puzzleId: string) {
  const b = loadBoards(), k = bkey(packId, levelId, puzzleId);
  if (!b[k]?.q) return;
  b[k] = { q: null, saved: new Date().toISOString() };
  storeBoards(b); changed();
}
export function getBoard(packId: string, levelId: string, puzzleId: string): QuickSave | null {
  return loadBoards()[bkey(packId, levelId, puzzleId)]?.q ?? null;
}
/** the board played last */
export function getQuickSave(): QuickSave | null { return latestBoard(loadBoards())?.q ?? null; }
function latestBoard(b: Boards) {
  let best: Boards[string] | null = null;
  for (const v of Object.values(b)) if (v.q && (!best || v.saved > best.saved)) best = v;
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

export interface SaveFile {
  format: 'momogram-save'; version: 2;
  profile: { id: string; name: string };
  saved: string;
  packs: Record<string, { updated: string; progress: Record<string, PuzzleProgress>; reset?: string }>;
  quick: QuickSave | null;
  settings?: Partial<Settings>;
  quickSaved?: string; // when the quick save was last set or cleared (older versions)
  boards?: Boards; // every board in progress
  settingsSaved?: string; // when a shared setting last changed
}

function packsOf(p: ProgressMap): SaveFile['packs'] {
  const out: SaveFile['packs'] = {};
  for (const [k, v] of Object.entries(p)) {
    const i = k.lastIndexOf('/'), id = k.slice(0, i);
    (out[id] ??= { updated: packTimes[id] ?? '1970-01-01T00:00:00.000Z', progress: {} }).progress[k.slice(i + 1)] = v;
  }
  for (const id of Object.keys(packTimes)) out[id] ??= { updated: packTimes[id], progress: {} }; // reset packs too
  for (const [id, r] of Object.entries(resetTimes)) if (out[id]) out[id].reset = r;
  return out;
}

export function makeSave(): SaveFile {
  const me = activeProfile();
  return {
    format: 'momogram-save', version: 2, profile: { id: me.id, name: me.name }, saved: new Date().toISOString(), packs: packsOf(progress), quick: getQuickSave(), boards: loadBoards(),
    settings: sharedSettings(), quickSaved: latestBoard(loadBoards())?.saved, settingsSaved: localStorage.getItem('momogram.settingstime') ?? undefined,
  };
}

/**
 * Merge a save of the active profile (from the server) into this device: per pack the newer data wins, the quick
 * save and the shared settings likewise. Returns true when anything here changed.
 */
export function mergeSave(s: SaveFile): boolean {
  loadActive();
  let any = false;
  for (const [id, rp] of Object.entries(s.packs)) {
    const local = packTimes[id];
    const mine: Record<string, PuzzleProgress> = {};
    for (const [k, v] of Object.entries(progress)) if (k.startsWith(id + '/')) mine[k.slice(id.length + 1)] = v;
    // a reset on one side drops what the other side did before it; otherwise both sides are joined puzzle by puzzle
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
    packTimes[id] = same(rp.progress) ? rp.updated : new Date().toISOString();
    any = true;
  }
  if (any) { localStorage.setItem(pk('resets'), JSON.stringify(resetTimes)); persist(); }
  if (s.boards) any = mergeBoards(s.boards) || any;
  else if (s.quick && s.quickSaved) any = mergeBoards({ [bkey(s.quick.packId, s.quick.levelId, s.quick.puzzleId)]: { q: s.quick, saved: s.quickSaved } }) || any;
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
export function localStats(): { solved: number; medals: Record<Medal, number>; packs: Record<string, number>; time: number } {
  const out = { solved: 0, medals: { bronze: 0, silver: 0, gold: 0, platinum: 0 } as Record<Medal, number>, packs: {} as Record<string, number>, time: 0 };
  for (const [k, v] of Object.entries(progress)) {
    if (!v.cleared) continue;
    const id = k.slice(0, k.lastIndexOf('/'));
    out.solved++; out.packs[id] = (out.packs[id] ?? 0) + 1;
    if (v.medal) out.medals[v.medal]++;
    if (v.best !== undefined) out.time += v.best;
  }
  return out;
}

/** solved puzzles per pack id (of the active profile, or of a save) */
export function progressSummary(s?: SaveFile): Map<string, number> {
  const m = new Map<string, number>();
  for (const [id, pk] of Object.entries(s ? s.packs : packsOf(progress))) m.set(id, Object.values(pk.progress).filter(v => v.cleared).length);
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
