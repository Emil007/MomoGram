// Persistent storage: the user's ROM and packs in IndexedDB, progress/settings in localStorage.
import type { Pack } from './packs/format';
import type { BoardSnapshot } from './game/board';

const DB = 'momogram';
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('roms');
      d.createObjectStore('packs');
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
  async persist() { try { await navigator.storage?.persist?.(); } catch { /* ignore */ } },
};

// ---- progress & settings ----

export interface PuzzleProgress { best?: number; cleared?: boolean; underLimit?: boolean }
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
}

const DEFAULTS: Settings = {
  lang: '', music: true, musicVolume: 0.7, sfx: true, hints: 'ask', unlockAll: false,
  normalStyle: 'stage_jazz_SEQ', freeStyle: 'stage_musicbox_SEQ', lefty: false, showTimer: true,
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

export function recordClear(packId: string, puzzleId: string, totalMs: number, underLimit: boolean) {
  const k = packId + '/' + puzzleId;
  const p = progress[k] ?? {};
  p.cleared = true;
  if (underLimit) p.underLimit = true;
  if (p.best === undefined || totalMs < p.best) p.best = totalMs;
  progress[k] = p;
  localStorage.setItem('momogram.progress', JSON.stringify(progress));
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
