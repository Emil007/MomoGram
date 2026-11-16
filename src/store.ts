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
const progress: ProgressMap = (() => { try { return JSON.parse(localStorage.getItem('momogram.progress') || '{}'); } catch { return {}; } })();

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
  localStorage.setItem('momogram.progress', JSON.stringify(progress));
  return better;
}

export function resetProgress(packId: string) {
  for (const k of Object.keys(progress)) if (k.startsWith(packId + '/')) delete progress[k];
  localStorage.setItem('momogram.progress', JSON.stringify(progress));
  localStorage.removeItem('momogram.quick.' + packId);
}

export interface QuickSave { packId: string; levelId: string; puzzleId: string; state: BoardSnapshot }
export function setQuickSave(q: QuickSave | null) {
  if (q) localStorage.setItem('momogram.quick', JSON.stringify(q));
  else localStorage.removeItem('momogram.quick');
}
export function getQuickSave(): QuickSave | null {
  try { return JSON.parse(localStorage.getItem('momogram.quick') || 'null'); } catch { return null; }
}

// ---- the save file: one named save with the progress of every pack ----
// Progress is keyed "packId/puzzleId", so a save works with any set of installed packs: entries of packs that
// aren't installed simply wait until that pack is imported, and nothing of them is touched in between.

export interface SaveFile {
  format: 'momogram-save'; version: 1;
  name: string;
  saved: string; // ISO date
  progress: ProgressMap;
  quick: QuickSave | null;
  settings?: Partial<Settings>;
}

export function saveName(): string { return localStorage.getItem('momogram.saveName') || 'MomoGram'; }
export function setSaveName(n: string) { localStorage.setItem('momogram.saveName', n.trim().slice(0, 40) || 'MomoGram'); }

export function makeSave(withSettings = true): SaveFile {
  return { format: 'momogram-save', version: 1, name: saveName(), saved: new Date().toISOString(), progress, quick: getQuickSave(), settings: withSettings ? settings : undefined };
}

/** summary for the UI: puzzles solved per pack id */
export function progressSummary(p: ProgressMap = progress): Map<string, number> {
  const m = new Map<string, number>();
  for (const [k, v] of Object.entries(p)) if (v.cleared) { const id = k.slice(0, k.lastIndexOf('/')); m.set(id, (m.get(id) ?? 0) + 1); }
  return m;
}

/**
 * Load a save. "replace" takes it as it is (switching devices); "merge" keeps the better result per puzzle
 * (best time, medal, cleared) from both.
 */
export function applySave(s: SaveFile, mode: 'replace' | 'merge', withSettings = true) {
  if (mode === 'replace') for (const k of Object.keys(progress)) delete progress[k];
  for (const [k, v] of Object.entries(s.progress ?? {})) {
    const cur = progress[k];
    if (!cur || mode === 'replace') { progress[k] = { ...v }; continue; }
    progress[k] = {
      cleared: cur.cleared || v.cleared,
      underLimit: cur.underLimit || v.underLimit,
      best: cur.best === undefined ? v.best : v.best === undefined ? cur.best : Math.min(cur.best, v.best),
      medal: [cur.medal, v.medal].filter((m): m is Medal => !!m).sort((a, b) => MEDALS.indexOf(b) - MEDALS.indexOf(a))[0],
    };
  }
  localStorage.setItem('momogram.progress', JSON.stringify(progress));
  if (mode === 'replace') { setQuickSave(s.quick ?? null); setSaveName(s.name || 'MomoGram'); }
  if (withSettings && s.settings) { Object.assign(settings, s.settings); saveSettings(); }
}

export function isSaveFile(x: any): x is SaveFile { return x && x.format === 'momogram-save' && x.version === 1 && typeof x.progress === 'object'; }
