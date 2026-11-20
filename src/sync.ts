// Connection to a MomoGram server (server/api.php): accounts, the synced save and the shared pack shelf.
// The server address is set per device; every profile can log in to its own account.
import { activeProfile, makeSave, mergeSave, onLocalChange, isSaveFile, profiles, switchProfile, createProfile, rekeyProfile, SaveFile } from './store';

export interface Account { name: string; token: string; admin: boolean; rev: number; synced?: string }
export interface ServerPack { id: string; size: number; updated: string; by: string | null; meta: { title?: any; puzzles?: number; platform?: string; icon?: any } }

const SKEY = 'momogram.server';
const akey = (id = activeProfile().id) => `momogram.account.${id}`;

export function serverUrl(): string { return localStorage.getItem(SKEY) || ''; }
export function setServerUrl(u: string) {
  u = u.trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  if (u) localStorage.setItem(SKEY, u); else localStorage.removeItem(SKEY);
}
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

async function call(a: string, opts: { method?: string; json?: unknown; body?: BodyInit; args?: Record<string, string | number>; raw?: boolean; keepalive?: boolean; token?: string } = {}): Promise<any> {
  const headers: Record<string, string> = {};
  const tok = opts.token ?? account()?.token;
  if (tok) headers['X-Momo-Token'] = tok;
  let body = opts.body;
  if (opts.json !== undefined) { body = JSON.stringify(opts.json); headers['Content-Type'] = 'application/json'; }
  else if (body) headers['Content-Type'] = 'application/octet-stream';
  let r: Response;
  try { r = await fetch(endpoint(a, opts.args), { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, keepalive: opts.keepalive }); }
  catch { throw new ServerError('offline', 0); }
  if (opts.raw && r.ok) return new Uint8Array(await r.arrayBuffer());
  let data: any = null;
  try { data = await r.json(); } catch { throw new ServerError(r.ok ? 'notmomogram' : 'http' + r.status, r.status); }
  if (!r.ok) {
    if (r.status === 401) { storeAccount(null); emit(); }
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
    else createProfile(remote.profile.name, remote.profile.id);
  }
  storeAccount({ name: d.user.name, admin: !!d.user.admin, token: tok, rev: 0 });
  await sync();
}

export async function signOut() {
  const a = account();
  if (a) call('logout', { method: 'POST', token: a.token }).catch(() => {});
  storeAccount(null);
  scoresCache = null; localStorage.removeItem('momogram.scores');
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
      lastError = ''; state = 'idle';
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
    if (isSaveFile(got.data) && got.data.profile.id === profileId) changed = mergeSave(got.data) || changed;
    const mine = makeSave();
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
let timer = 0;
export function startAutoSync(onRemoteChange: () => void) {
  const run = () => { if (account()) sync().then(c => { if (c) onRemoteChange(); }); };
  onLocalChange(() => { if (!account()) return; clearTimeout(timer); timer = window.setTimeout(run, 4000); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (timer) { clearTimeout(timer); timer = 0; flush(); } }
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
export interface Scores { users: Array<{ name: string; solved: number; medals: Record<string, number>; packs: Record<string, number>; time: number }>; best: Record<string, Array<[string, number]>> }
let scoresCache: Scores | null = null;
export function scores(): Scores | null {
  if (!account()) return null;
  if (!scoresCache) try { scoresCache = JSON.parse(localStorage.getItem('momogram.scores') || 'null'); } catch { /* ignore */ }
  return scoresCache;
}
export async function refreshScores(): Promise<Scores | null> {
  if (!account()) return null;
  scoresCache = await call('scores');
  try { localStorage.setItem('momogram.scores', JSON.stringify(scoresCache)); } catch { /* full */ }
  return scoresCache;
}

// ---- packs on the server ----
export async function serverPacks(): Promise<ServerPack[]> { return (await call('packs')).packs; }
export async function downloadPack(id: string): Promise<Uint8Array> { return call('pack', { args: { id }, raw: true }); }
export async function deleteServerPack(id: string) { await call('pack_delete', { method: 'POST', args: { id } }); }
export async function uploadPack(id: string, meta: ServerPack['meta'], zip: Uint8Array, progress?: (done: number) => void) {
  const b = await call('upload_begin', { json: { id, meta } });
  const part: number = b.part || 4 << 20;
  const parts = Math.max(1, Math.ceil(zip.length / part));
  for (let i = 0; i < parts; i++) {
    await call('upload_part', { method: 'POST', body: zip.slice(i * part, (i + 1) * part), args: { upload: b.upload, i } });
    progress?.((i + 1) / parts);
  }
  await call('upload_end', { method: 'POST', args: { upload: b.upload } });
}
