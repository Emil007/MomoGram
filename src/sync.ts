// Connection to a MomoGram server (server/api.php): accounts, the synced save and the shared pack shelf.
// The server address is set per device; every profile can log in to its own account.
import { activeProfile, makeSave, mergeSave, onLocalChange, isSaveFile, profiles, switchProfile, createProfile, rekeyProfile, SaveFile, setServerTime } from './store';

export interface Account { name: string; token: string; admin: boolean; rev: number; synced?: string }
export interface ServerPack {
  id: string; size: number; updated: string; by: string | null; meta: { title?: any; puzzles?: number; platform?: string; icon?: any; rev?: number };
  /** stored as pack.json + files (servers from API 2 on): `music` bytes of `size` can be left out */
  split?: boolean; music?: number;
}
export interface SplitAsset { name: string; hash: string; size: number; music: boolean }

const SKEY = 'momogram.server';
const akey = (id = activeProfile().id) => `momogram.account.${id}`;

/** the server's address, always over HTTPS (passwords and logins never travel unencrypted) */
export function serverUrl(): string { const u = localStorage.getItem(SKEY) || ''; return u ? 'https://' + serverHost(u) : ''; }
/** the address without "https://" (what the player types) */
export function serverHost(u = localStorage.getItem(SKEY) || ''): string { return u.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, ''); }
export function setServerUrl(u: string) {
  const host = serverHost(u);
  if (host) localStorage.setItem(SKEY, 'https://' + host); else localStorage.removeItem(SKEY);
}
/** the account name of a login the server dropped (shown until the player logs in again) */
export function loggedOut(): string | null { return localStorage.getItem('momogram.loggedout.' + activeProfile().id); }
export function account(): Account | null { try { return JSON.parse(localStorage.getItem(akey()) || 'null'); } catch { return null; } }
function storeAccount(a: Account | null, id?: string) { if (a) localStorage.setItem(akey(id), JSON.stringify(a)); else localStorage.removeItem(akey(id)); }

export class ServerError extends Error { constructor(public code: string, public status: number, public data?: any) { super(code); } }

function endpoint(a: string, args: Record<string, string | number> = {}): string {
  const base = serverUrl();
  if (!base) throw new ServerError('noserver', 0);
  // the address may be the folder or api.php itself
  const api = /\.php$/i.test(base) ? base : base + '/api.php';
  return api + '?' + new URLSearchParams({ a, ...Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])) });
}

async function call(a: string, opts: { method?: string; json?: unknown; body?: BodyInit; args?: Record<string, string | number>; raw?: boolean; keepalive?: boolean; token?: string; signal?: AbortSignal } = {}): Promise<any> {
  const headers: Record<string, string> = {};
  const tok = opts.token ?? account()?.token;
  if (tok) headers['X-Momo-Token'] = tok;
  let body = opts.body;
  if (opts.json !== undefined) { body = JSON.stringify(opts.json); headers['Content-Type'] = 'application/json'; }
  else if (body) headers['Content-Type'] = 'application/octet-stream';
  // a request that never answers (phone put away mid-request) must not block all later syncs
  const ctl = new AbortController();
  opts.signal?.addEventListener('abort', () => ctl.abort());
  const timeout = window.setTimeout(() => ctl.abort(), opts.raw || a === 'upload_part' ? 300000 : 30000);
  let r: Response;
  try { r = await fetch(endpoint(a, opts.args), { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, keepalive: opts.keepalive, signal: ctl.signal }); }
  catch { window.clearTimeout(timeout); throw new ServerError('offline', 0); }
  try { return await readResponse(r, opts.raw); } finally { window.clearTimeout(timeout); }
}

async function readResponse(r: Response, raw?: boolean): Promise<any> {
  const opts = { raw };
  if (opts.raw && r.ok) return new Uint8Array(await r.arrayBuffer());
  let data: any = null;
  try { data = await r.json(); } catch { throw new ServerError(r.ok ? 'notmomogram' : 'http' + r.status, r.status); }
  if (data?.now) setServerTime(data.now);
  if (!r.ok) {
    // the server doesn't know this login any more: say so instead of quietly stopping to sync
    if (r.status === 401) { const a = account(); if (a) localStorage.setItem('momogram.loggedout.' + activeProfile().id, a.name); storeAccount(null); emit(); }
    throw new ServerError(data?.error || 'http' + r.status, r.status, data);
  }
  return data;
}

export async function serverInfo(): Promise<{ register: boolean }> {
  const d = await call('info');
  if (d?.app !== 'momogram') throw new ServerError('notmomogram', 0);
  return d;
}

// ---- status for the UI ----
export type SyncState = 'off' | 'idle' | 'syncing' | 'error';
let state: SyncState = 'off', lastError = '';
const watchers: Array<() => void> = [];
export function onSyncChange(f: () => void) { watchers.push(f); }
function emit() { for (const f of watchers) try { f(); } catch { /* ignore */ } }
export function syncState(): { state: SyncState; error: string } { return { state: account() ? state : 'off', error: lastError }; }

/** log in or create an account, then join it with a profile on this device */
export async function signIn(name: string, password: string, invite?: string, ask?: (q: { local: string; remote: string }) => Promise<'merge' | 'separate'>): Promise<void> {
  const d = invite !== undefined ? await call('register', { json: { name, password, invite } }) : await call('login', { json: { name, password } });
  const tok: string = d.token;
  const saved = await call('save', { token: tok });
  const remote: SaveFile | null = isSaveFile(saved.data) ? saved.data : null;
  const me = activeProfile();
  if (remote && remote.profile.id !== me.id) {
    // the account already has a profile: use it here, or join this device's current profile with it
    if (profiles().some(p => p.id === remote.profile.id)) switchProfile(remote.profile.id);
    else if (ask && (await ask({ local: me.name, remote: remote.profile.name })) === 'merge') rekeyProfile(me.id, remote.profile.id, remote.profile.name);
    // kept apart: name it after the account, so two profiles called "Player" can't be mixed up
    else createProfile(profiles().some(p => p.name === remote.profile.name) ? d.user.name : remote.profile.name, remote.profile.id);
  }
  storeAccount({ name: d.user.name, admin: !!d.user.admin, token: tok, rev: 0 });
  localStorage.removeItem('momogram.loggedout.' + activeProfile().id);
  await sync();
}

export async function signOut() {
  localStorage.removeItem('momogram.loggedout.' + activeProfile().id);
  const a = account();
  if (a) call('logout', { method: 'POST', token: a.token }).catch(() => {});
  storeAccount(null);
  scoresCache = null; localStorage.removeItem('momogram.scores.' + activeProfile().id);
  emit();
}

let running: Promise<boolean> | null = null, again = false;
/** bring this device and the server to the same state; returns true when something here changed */
export function sync(): Promise<boolean> {
  if (running) { again = true; return running; }
  running = (async () => {
    let changedHere = false;
    try {
      do {
        again = false;
        changedHere = (await syncOnce()) || changedHere;
      } while (again);
      lastError = ''; state = 'idle'; dirty = false;
      await refreshScores().catch(() => {});
    } catch (e: any) {
      lastError = e instanceof ServerError ? e.code : String(e?.message || e); state = 'error';
    } finally { running = null; emit(); }
    return changedHere;
  })();
  state = 'syncing'; emit();
  return running;
}

async function syncOnce(): Promise<boolean> {
  const a = account();
  if (!a || !serverUrl()) return false;
  const profileId = activeProfile().id;
  let changed = false;
  for (let tries = 0; tries < 4; tries++) {
    const got = await call('save');
    // another profile became active meanwhile: its data must not go to this account
    if (activeProfile().id !== profileId) return changed;
    if (isSaveFile(got.data) && got.data.profile.id === profileId) changed = mergeSave(got.data) || changed;
    const mine = makeSave();
    if (mine.profile.id !== profileId) return changed;
    // nothing new here: don't write the same thing back
    if (got.rev && isSaveFile(got.data) && sameContent(got.data, mine)) { storeAccount({ ...a, rev: got.rev, synced: new Date().toISOString() }, profileId); return changed; }
    try {
      const put = await call('save', { method: 'PUT', json: mine, args: { rev: got.rev } });
      storeAccount({ ...a, rev: put.rev, synced: new Date().toISOString() }, profileId);
      return changed;
    } catch (e) {
      if (e instanceof ServerError && e.code === 'changed') continue; // another device saved meanwhile: merge again
      throw e;
    }
  }
  throw new ServerError('busy', 409);
}

function sameContent(a: SaveFile, b: SaveFile): boolean {
  const strip = (s: SaveFile) => JSON.stringify({ ...s, saved: '' });
  return strip(a) === strip(b);
}

// sync a few seconds after something changed, when the app goes to the background and when it starts
let timer = 0, dirty = false;
export function startAutoSync(onRemoteChange: () => void) {
  const run = () => { timer = 0; if (account()) sync().then(c => { if (c) onRemoteChange(); }); };
  onLocalChange(() => { if (!account()) return; dirty = true; clearTimeout(timer); timer = window.setTimeout(run, 4000); });
  document.addEventListener('visibilitychange', () => {
    // put away: send what changed since the last sync (only then)
    if (document.visibilityState === 'hidden') { clearTimeout(timer); timer = 0; if (dirty) flush(); }
    else run();
  });
  window.addEventListener('online', run);
  run();
}
/** last chance to send before the app is put away: a plain upload that survives the page closing */
function flush() {
  const a = account();
  if (!a) return;
  const body = JSON.stringify(makeSave());
  if (body.length > 60000) { sync(); return; } // too big for a keepalive request: try normally
  call('save', { method: 'PUT', body, args: { rev: a.rev }, keepalive: true })
    .then(r => storeAccount({ ...a, rev: r.rev, synced: new Date().toISOString() }))
    .catch(() => sync());
}

// ---- high scores of everyone on the server (kept for offline use) ----
export interface ScoreStats { solved: number; week?: number; records?: number; medals: Record<string, number>; packs: Record<string, number>; time: number; points?: number; elo?: number; peak?: number; rated?: number }
export interface Scores { users: Array<ScoreStats & { name: string; modes?: Partial<Record<'normal' | 'mega' | 'color', ScoreStats>>; practice?: Record<string, number> }>; best: Record<string, Array<[string, number, string?, string?, number?]>> }
let scoresCache: Scores | null = null, scoresOf = '';
export function scores(): Scores | null {
  if (!account()) return null;
  if (scoresOf !== activeProfile().id) { scoresCache = null; scoresOf = activeProfile().id; }
  if (!scoresCache) try { scoresCache = JSON.parse(localStorage.getItem('momogram.scores.' + activeProfile().id) || 'null'); } catch { /* ignore */ }
  return scoresCache;
}
export async function refreshScores(): Promise<Scores | null> {
  if (!account()) return null;
  scoresCache = await call('scores'); scoresOf = activeProfile().id;
  try { localStorage.setItem('momogram.scores.' + activeProfile().id, JSON.stringify(scoresCache)); } catch { /* full */ }
  return scoresCache;
}

// ---- admin ----
export async function serverUsers(): Promise<Array<{ name: string; admin: boolean }>> { return (await call('users')).users; }
export async function setPassword(name: string, password: string) { await call('set_password', { json: { name, password } }); }

// ---- packs on the server ----
export async function serverPacks(): Promise<ServerPack[]> {
  const list: ServerPack[] = (await call('packs')).packs;
  // remembered (per profile) for the "newer version on the server" badges in the library
  try { localStorage.setItem('momogram.serverpacks.' + activeProfile().id, JSON.stringify(list.map(s => ({ id: s.id, rev: s.meta?.rev ?? 1 })))); } catch { /* full */ }
  return list;
}
/** the server's pack revisions as last seen (no request) */
export function knownServerRevs(): Map<string, number> {
  if (!account()) return new Map();
  try { return new Map((JSON.parse(localStorage.getItem('momogram.serverpacks.' + activeProfile().id) || '[]') as Array<{ id: string; rev: number }>).map(x => [x.id, x.rev])); }
  catch { return new Map(); }
}
export async function downloadPack(id: string): Promise<Uint8Array> { return call('pack', { args: { id }, raw: true }); }
/** a split pack: its pack.json and file list, or null when the server keeps it as one zip (older uploads) */
export async function packSplit(id: string): Promise<{ pack: any; assets: SplitAsset[] } | null> {
  const r = await call('pack_split', { args: { id } });
  return r.kind === 'split' ? { pack: r.pack, assets: r.assets } : null;
}
export async function downloadBlob(hash: string, signal?: AbortSignal): Promise<Uint8Array> { return call('blob', { args: { hash }, raw: true, signal }); }

/**
 * Upload as pack.json + files: only the files the server doesn't have yet are sent (the same song in nine packs
 * goes up once). `files` gives each file's data on demand, so they aren't all in memory together.
 */
export async function uploadPackSplit(id: string, meta: ServerPack['meta'], pack: unknown, files: Array<{ name: string; hash: string; size: number; music: boolean; data: () => Promise<Uint8Array | undefined> }>, progress?: (done: number) => void) {
  const { missing } = await call('blobs_missing', { json: { hashes: [...new Set(files.map(f => f.hash))] } }) as { missing: string[] };
  const need = files.filter((f, i) => missing.includes(f.hash) && files.findIndex(g => g.hash === f.hash) === i);
  const part = 4 << 20;
  for (let k = 0; k < need.length; k++) {
    const f = need[k];
    const d = await f.data();
    if (!d) throw new ServerError('missing', 0);
    const n = Math.max(1, Math.ceil(d.length / part));
    for (let i = 0; i < n; i++) {
      await call('blob_part', { method: 'POST', body: d.slice(i * part, (i + 1) * part), args: { hash: f.hash, i, n } });
      progress?.(Math.min(0.99, (k + (i + 1) / n) / need.length));
    }
  }
  try { await call('pack_put', { json: { id, meta, pack, assets: files.map(({ name, hash, music }) => ({ name, hash, music })) } }); }
  catch (e) { if (e instanceof ServerError && e.code === 'have') { progress?.(1); return; } throw e; }
  progress?.(1);
}
/** the server's API version (2: split packs) */
let apiVersion = 0;
export async function serverApi(): Promise<number> {
  if (!apiVersion) { try { apiVersion = (await call('info')).api ?? 1; } catch { apiVersion = 1; } }
  return apiVersion;
}
export async function deleteServerPack(id: string) { await call('pack_delete', { method: 'POST', args: { id } }); }
export async function uploadPack(id: string, meta: ServerPack['meta'], zip: Uint8Array, progress?: (done: number) => void) {
  let b: any;
  try { b = await call('upload_begin', { json: { id, meta } }); }
  catch (e) {
    // the server already has this version or a newer one: nothing to send
    if (e instanceof ServerError && e.code === 'have') { progress?.(1); return; }
    throw e;
  }
  const part: number = b.part || 4 << 20;
  const parts = Math.max(1, Math.ceil(zip.length / part));
  for (let i = 0; i < parts; i++) {
    await call('upload_part', { method: 'POST', body: zip.slice(i * part, (i + 1) * part), args: { upload: b.upload, i } });
    progress?.((i + 1) / parts);
  }
  await call('upload_end', { method: 'POST', args: { upload: b.upload } });
}
