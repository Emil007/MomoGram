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
  normalStyle: string; // Picross DS music style for Normal mode
  freeStyle: string;
  lefty: boolean;
  showTimer: boolean;
  packMusic: boolean; // play a pack's own music (from the user's game) instead of the Picross DS music
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
export function saveSettings() { localStorage.setItem('momogram.settings', JSON.stringify(settings)); }

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
function loadActive() {
  try { progress = JSON.parse(localStorage.getItem(pk('progress')) || '{}'); } catch { progress = {}; }
  try { packTimes = JSON.parse(localStorage.getItem(pk('packtimes')) || '{}'); } catch { packTimes = {}; }
}
loadActive();
function persist(touched?: string[]) {
  const now = new Date().toISOString();
  for (const id of touched ?? []) packTimes[id] = now;
  localStorage.setItem(pk('progress'), JSON.stringify(progress));
  localStorage.setItem(pk('packtimes'), JSON.stringify(packTimes));
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
  for (const k of ['progress', 'quick', 'packtimes']) localStorage.removeItem(`momogram.${k}.${id}`);
  if (localStorage.getItem('momogram.profile') === id) switchProfile(all[0].id);
}

export function getProgress(packId: string, puzzleId: string): PuzzleProgress {
  return progress[packId + '/' + puzzleId] ?? {};
}

/** returns true when the medal is better than the one the puzzle had */
export function recordClear(packId: string, puzzleId: string, totalMs: number, underLimit: boolean, medal?: Medal): boolean {
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
  for (const k of Object.keys(progress)) if (k.startsWith(packId + '/')) delete progress[k];
  persist([packId]);
}

export interface QuickSave { packId: string; levelId: string; puzzleId: string; state: BoardSnapshot }
export function setQuickSave(q: QuickSave | null) {
  if (q) localStorage.setItem(pk('quick'), JSON.stringify(q));
  else localStorage.removeItem(pk('quick'));
}
export function getQuickSave(): QuickSave | null {
  try { return JSON.parse(localStorage.getItem(pk('quick')) || 'null'); } catch { return null; }
}

// ---- save files: the active profile, every pack with its own timestamp ----
// Progress is keyed "packId/puzzleId", so a save works with any set of installed packs: entries of packs that
// aren't installed simply wait until that pack is imported, and nothing of them is touched in between.

export interface SaveFile {
  format: 'momogram-save'; version: 2;
  profile: { id: string; name: string };
  saved: string;
  packs: Record<string, { updated: string; progress: Record<string, PuzzleProgress> }>;
  quick: QuickSave | null;
  settings?: Partial<Settings>;
}

function packsOf(p: ProgressMap): SaveFile['packs'] {
  const out: SaveFile['packs'] = {};
  for (const [k, v] of Object.entries(p)) {
    const i = k.lastIndexOf('/'), id = k.slice(0, i);
    (out[id] ??= { updated: packTimes[id] ?? '1970-01-01T00:00:00.000Z', progress: {} }).progress[k.slice(i + 1)] = v;
  }
  for (const id of Object.keys(packTimes)) out[id] ??= { updated: packTimes[id], progress: {} }; // reset packs too
  return out;
}

export function makeSave(): SaveFile {
  const me = activeProfile();
  return { format: 'momogram-save', version: 2, profile: { id: me.id, name: me.name }, saved: new Date().toISOString(), packs: packsOf(progress), quick: getQuickSave(), settings };
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
  if (!exists || !getQuickSave()) setQuickSave(s.quick ?? null);
  if (!exists && s.settings) { Object.assign(settings, s.settings); saveSettings(); }
  return { profile: s.profile.name, created: !exists, packsTaken: taken, packsKept: kept };
}

export function isSaveFile(x: any): x is SaveFile { return x && x.format === 'momogram-save' && x.version === 2 && x.profile && typeof x.packs === 'object'; }
