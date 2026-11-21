// Pack manager: the installed packs, adding games and pack files, exporting .momopack files, and the packs on the
// MomoGram server (download, update, upload).
import { Pack, PackTheme, pickAny, mergePacks, songsOf, roleSongs, setRoleSongs, SongRole } from '../packs/format';
import { readEntries, momopackOf, momopackName, packRev, newRev } from '../packs/io';
import { importFileSet } from '../packs/importers/index';
import { storage } from '../store';
import { t, lang } from '../i18n';
import { h, pickFiles, serverError } from '../app';
import { confirmBox, message } from './dialog';
import * as Sync from '../sync';
import { download, makeZip, unzipAll } from '../util/files';
import { extractAll, isArchive } from '../util/archive';

interface PM {
  root: HTMLElement;
  packs(): Pack[];
  setPacks(p: Pack[]): void;
  header(title: string): HTMLElement;
  screen(...kids: Array<Node | null>): HTMLElement;
  openPack(p: Pack): void;
}

/** open files of any kind: loose, archives (.zip/.7z/.rar), .momopack; returns the entries inside */
export async function filesToEntries(f: { name: string; data?: Uint8Array; file?: File }): Promise<Array<{ name: string; data: Uint8Array }>> {
  const data = f.data ?? new Uint8Array(await f.file!.arrayBuffer());
  if (/\.zip$/i.test(f.name)) { try { return unzipAll(data); } catch { /* not a plain zip: libarchive below */ } }
  if (isArchive(f.name)) return extractAll(f.file ?? new File([data as Uint8Array<ArrayBuffer>], f.name));
  return [{ name: f.name, data }];
}

export function openPackManager(pm: PM) {
  const list = h('div', { class: 'packlist' });
  const count = (p: Pack) => p.levels.reduce((a, l) => a + l.puzzles.length, 0);
  const render = () => {
    list.innerHTML = '';
    const packs = pm.packs();
    if (!packs.length) list.append(h('p', { class: 'fine' }, t('noPacks')));
    for (const p of packs) {
      list.append(h('div', { class: 'pack' },
        h('button', { class: 'btn packbtn', onClick: () => pm.openPack(p) },
          h('b', {}, pickAny(p.title, lang())),
          h('small', {}, `${p.source.platform}${p.source.region ? ' · ' + p.source.region : ''} · ${count(p)} ${t('puzzles')}` + (p.theme?.music ? ' · ♪' : ''))),
        h('button', { class: 'btn ghost', title: t('download'), onClick: async () => download(momopackName(p), await momopackOf(p)) }, '⤓'),
        h('button', { class: 'btn ghost', title: t('delete'), onClick: async () => {
          if (!(await confirmBox(t('delete') + ': ' + pickAny(p.title, lang()) + '?', t('delete'), true))) return;
          await storage.deletePack(p.id);
          await storage.deleteAssets(p.id).catch(() => {});
          pm.setPacks(pm.packs().filter(x => x.id !== p.id));
          render(); renderOnline();
        } }, '🗑')));
    }
  };

  const status = h('div', { class: 'status' });

  async function addPacks(incoming: Pack[]) {
    pm.setPacks(await storePacks(pm.packs(), incoming));
    render();
    renderOnline();
  }

  /** one button for everything: games, archives of games, .momopack files and older pack files */
  async function addFiles() {
    const files = await pickFiles('*', true);
    if (!files.length) return;
    const results = h('ul', { class: 'results' });
    status.innerHTML = '';
    status.append(results);
    const made: Pack[] = [];
    let fromPackFiles = 0;
    for (const f of files) {
      const li = h('li', {}, f.name + ' … ' + t('analyzing'));
      results.append(li);
      let entries: Array<{ name: string; data: Uint8Array }>;
      try { entries = await filesToEntries({ name: f.name, file: f }); }
      catch (e: any) { li.textContent = f.name + ': ✕ ' + (e.message || e); continue; }
      const r = await readEntries(entries, lang(), t);
      made.push(...r.made); fromPackFiles += r.fromPackFiles;
      li.textContent = f.name + ': ' + (r.msgs.join(' · ') || '✕ ' + t('unsupported'));
    }
    if (made.length) {
      await addPacks(made);
      const ids = new Set(made.map(p => p.id));
      const unique = pm.packs().filter(p => ids.has(p.id));
      // offering an export only makes sense for packs made from games
      if (made.length > fromPackFiles) results.append(h('li', {}, h('button', { class: 'btn primary', onClick: () => exportAll(unique, 'momogram-new-packs.zip') }, t('exportAll'))));
    }
  }

  /**
   * a folder with everything in it (also subfolders): Switch games are folders (their RomFS), every other file
   * (ROMs, archives, .momopack) is read on its own. Each game is stored as soon as it is read, so a big folder
   * doesn't need all games in memory at once.
   */
  async function addFolder() {
    const files = await new Promise<File[]>(res => {
      const i = h('input', { type: 'file', multiple: true }) as HTMLInputElement;
      i.setAttribute('webkitdirectory', '');
      i.onchange = () => res([...(i.files ?? [])]);
      i.click();
    });
    if (!files.length) return;
    const results = h('ul', { class: 'results' });
    status.innerHTML = '';
    status.append(results);
    const byName = new Map(files.map(f => [(f as any).webkitRelativePath || f.name, f]));
    const names = [...byName.keys()];
    const loose = names.filter(n => /\.(gb|gbc|sfc|smc|bs|nds|srl|3ds|cci|cxi|cia|app|zip|7z|rar|momopack)$/i.test(n));
    let done = 0, added = 0;
    const progress = h('li', { class: 'progress' });
    results.append(progress);
    const step = (what: string) => { progress.textContent = `${t('analyzing')} ${what}`; };
    step('');
    await importFileSet({ names, get: async n => { const f = byName.get(n); return f ? new Uint8Array(await f.arrayBuffer()) : undefined; } }, async r => {
      if (r.ok) { const rev = newRev(); for (const p of r.packs) { p.source.file = r.file; p.rev = rev; } await addPacks(r.packs); added += r.packs.length; }
      results.insertBefore(h('li', {}, r.file + ': ' + (r.ok ? '✓ ' + r.packs.map(p => pickAny(p.title, lang())).join(', ') : '✕ ' + (r.message === 'unsupported' ? t('unsupported') : r.message))), progress);
    }).then(s => { for (let i = loose.length - 1; i >= 0; i--) if (s.used(loose[i])) loose.splice(i, 1); });
    for (const n of loose) {
      const f = byName.get(n)!;
      step(`${++done}/${loose.length} · ${n}`);
      const line = h('li', {}, n + ' … ');
      results.insertBefore(line, progress);
      try {
        const r = await readEntries(await filesToEntries({ name: f.name, file: f }), lang(), t);
        if (r.made.length) { await addPacks(r.made); added += r.made.length; }
        line.textContent = n + ': ' + (r.msgs.join(' · ') || '✕ ' + t('unsupported'));
      } catch (e: any) { line.textContent = n + ': ✕ ' + (e.message || e); }
    }
    progress.textContent = t('folderDone', { n: added });
  }

  /** several packs: one .zip holding a .momopack per pack (one pack: just its .momopack) */
  async function exportAll(ps: Pack[], name = 'momogram-packs.zip') {
    if (ps.length === 1) { download(momopackName(ps[0]), await momopackOf(ps[0])); return; }
    const entries: Array<{ name: string; data: Uint8Array }> = [];
    for (const p of ps) entries.push({ name: momopackName(p), data: await momopackOf(p) });
    download(name, makeZip(entries), 'application/zip');
  }

  // ---- packs on the MomoGram server: everything, with music and pictures; the server keeps the newest version ----
  const online = h('div', { class: 'online' });
  async function renderOnline() {
    online.innerHTML = '';
    if (!Sync.account()) { if (Sync.serverUrl()) online.append(h('p', { class: 'fine' }, t('serverLogin'))); return; }
    const msg = h('p', { class: 'fine server-msg' });
    const bad = (e: unknown) => { msg.textContent = serverError(e); msg.classList.add('bad'); };
    online.append(h('h2', {}, '☁ ' + t('onServer')), msg);
    let list: Sync.ServerPack[];
    try { list = await Sync.serverPacks(); } catch (e) { bad(e); return; }
    const local = new Map(pm.packs().map(p => [p.id, p]));
    const state = (sp: Sync.ServerPack) => {
      const mine = local.get(sp.id);
      if (!mine) return 'new';
      const a = packRev(mine), b = sp.meta?.rev ?? 1;
      return b > a ? 'update' : a > b ? 'newer-here' : 'same';
    };
    // download (install or update) one or several: one after the other, with the progress in the button
    const fetchPacks = async (sps: Sync.ServerPack[], btn: HTMLButtonElement) => {
      const label = btn.textContent;
      btn.disabled = true;
      try {
        for (let i = 0; i < sps.length; i++) {
          btn.textContent = `${i + 1}/${sps.length} …`;
          const r = await readEntries(unzipAll(await Sync.downloadPack(sps[i].id)), lang(), t);
          // a pack from the server keeps its revision (old uploads without one count as 1)
          for (const p of r.made) if (p.rev === undefined && sps[i].meta?.rev) p.rev = sps[i].meta.rev;
          if (r.made.length) pm.setPacks(await storePacks(pm.packs(), r.made));
        }
        render(); renderOnline();
      } catch (e) { bad(e); btn.disabled = false; btn.textContent = label; }
    };
    const missing = list.filter(s => state(s) === 'new'), updates = list.filter(s => state(s) === 'update');
    if (list.length) {
      const all = h('button', { class: 'btn' + (missing.length + updates.length ? ' primary' : ''), disabled: missing.length + updates.length ? undefined : true }, `⤓ ${t('downloadAll')} (${missing.length + updates.length})`) as HTMLButtonElement;
      all.onclick = () => fetchPacks([...updates, ...missing], all);
      const upd = h('button', { class: 'btn', disabled: updates.length ? undefined : true }, `⟳ ${t('updateAll')} (${updates.length})`) as HTMLButtonElement;
      upd.onclick = () => fetchPacks(updates, upd);
      online.append(h('div', { class: 'row wrap' }, all, upd));
    } else online.append(h('p', { class: 'fine' }, t('serverEmpty')));
    for (const sp of list) {
      const title = pickAny(sp.meta?.title, lang()) || sp.id;
      const st = state(sp);
      const dl = h('button', { class: 'btn ghost', title: st === 'update' ? t('update') : t('download') }, st === 'update' ? '⟳' : '⤓') as HTMLButtonElement;
      dl.onclick = () => fetchPacks([sp], dl);
      const acc = Sync.account();
      const mine = sp.by === acc?.name || acc?.admin;
      const note = st === 'same' ? '✓ ' + t('installed') : st === 'update' ? '⬆ ' + t('updateAvailable') : st === 'newer-here' ? '⇧ ' + t('newerHere') : '';
      online.append(h('div', { class: 'pack' + (st === 'update' ? ' has-update' : '') },
        h('div', { class: 'btn packbtn static' },
          h('b', {}, title),
          h('small', {}, [sp.meta?.platform, sp.meta?.puzzles !== undefined ? `${sp.meta.puzzles} ${t('puzzles')}` : '', sp.size < 1048576 ? `${Math.max(1, Math.round(sp.size / 1024))} KB` : `${(sp.size / 1048576).toFixed(1)} MB`, sp.by ? t('uploadedBy', { name: sp.by }) : '', note].filter(Boolean).join(' · '))),
        st === 'same' || st === 'newer-here' ? null : dl,
        mine ? h('button', { class: 'btn ghost', title: t('delete'), onClick: async () => {
          if (!(await confirmBox(t('delete') + ' (' + t('onServer') + '): ' + title + '?', t('delete'), true))) return;
          try { await Sync.deleteServerPack(sp.id); } catch (e) { await message(serverError(e)); }
          renderOnline();
        } }, '🗑') : null));
    }
    // upload: local packs the server doesn't have, or has an older version of, are ticked
    const onServer = new Map(list.map(s => [s.id, s]));
    const up = h('button', { class: 'btn', onClick: () => {
      const box = h('div', { class: 'uplist' });
      const checks = pm.packs().map(p => {
        const s = onServer.get(p.id);
        const want = !s || packRev(p) > (s.meta?.rev ?? 1);
        const c = h('input', { type: 'checkbox', checked: want ? true : undefined }) as HTMLInputElement;
        box.append(h('label', {}, c, pickAny(p.title, lang()) + (s ? (want ? ' (☁ ' + t('older') + ')' : ' (☁ ✓)') : '')));
        return [p, c] as const;
      });
      const bar = h('div', { class: 'bar-inner', style: 'width:0%' });
      const go = h('button', { class: 'btn primary' }, '⇧ ' + t('upload')) as HTMLButtonElement;
      go.onclick = async () => {
        const pick = checks.filter(([, c]) => c.checked).map(([p]) => p);
        go.disabled = true;
        try {
          for (let i = 0; i < pick.length; i++) {
            const p = pick[i];
            await Sync.uploadPack(p.id, { title: p.title, puzzles: count(p), platform: p.source.platform, rev: packRev(p) }, await momopackOf(p),
              d => { bar.style.width = ((i + d) / pick.length) * 100 + '%'; });
          }
          renderOnline();
        } catch (e) { bad(e); go.disabled = false; }
      };
      box.append(h('div', { class: 'bar-outer' }, bar), go);
      up.replaceWith(box);
    } }, '⇧ ' + t('uploadPacks'));
    if (pm.packs().length) online.append(up);
  }

  render();
  pm.screen(pm.header(t('packs')), h('div', { class: 'packs' },
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn primary', onClick: addFiles }, '✚ ' + t('addFiles')),
      h('button', { class: 'btn', onClick: addFolder }, '📁 ' + t('addFolder')),
      h('button', { class: 'btn', onClick: () => exportAll(pm.packs()) }, '⤓ ' + t('exportAll'))),
    h('p', { class: 'fine' }, t('createHelp')),
    status, list, online));
  renderOnline();
}

/**
 * Save new packs (from games, pack files or the command line): the same game from several regions (or imported
 * twice) becomes one pack with all names; music and other binaries go to their own store. Returns the new list.
 */
/**
 * A game read from two releases with the same recordings (PICROSS e on 3DS: .bcstm, in PICROSS S+ on Switch:
 * .ogg, "Ga_B_00" = "e1_ga_b_00"): each song is kept once, the smaller file. Where the dropped copy was tagged
 * (title, puzzle, switched off, …), the kept one takes it over. Returns the files to drop.
 */
export async function oneRelease(p: Pack): Promise<Set<string>> {
  const drop = new Set<string>();
  const th = p.theme;
  if (!th) return drop;
  const songs = songsOf(th).filter(r => !r.includes('#'));
  if (!songs.some(r => /\.bcstm$/i.test(r)) || !songs.some(r => /\.ogg$/i.test(r))) return drop;
  const norm = (r: string) => r.toLowerCase().replace(/\.(bcstm|ogg)$/, '').replace(/^e\d_/, '').replace(/^strm_/, '');
  const size = async (f: string) => p.assets?.find(a => a.name === f)?.data.length ?? (await storage.loadAsset(p.id, f).catch(() => undefined))?.length ?? Infinity;
  const groups = new Map<string, string[]>();
  for (const r of songs) groups.set(norm(r), [...(groups.get(norm(r)) ?? []), r]);
  const swap = new Map<string, string>();
  for (const g of groups.values()) {
    if (g.length < 2 || !g.some(r => /\.bcstm$/i.test(r)) || !g.some(r => /\.ogg$/i.test(r))) continue;
    const sized = await Promise.all(g.map(async r => [r, await size(r)] as const));
    sized.sort((a, b) => a[1] - b[1]);
    for (const [r] of sized.slice(1)) { swap.set(r, sized[0][0]); drop.add(r); }
  }
  if (!swap.size) return drop;
  const to = (r: string) => swap.get(r) ?? r;
  const uniq = (l: string[] | undefined) => (l ? [...new Set(l.map(to))] : l);
  const t2: PackTheme = { ...th, songs: uniq(th.songs), tracks: uniq(th.tracks), off: uniq(th.off) };
  for (const role of ['title', 'menu', 'play', 'clear'] as SongRole[]) setRoleSongs(t2, role, [...new Set(roleSongs(th, role).map(to))]);
  if (!t2.tracks?.length) delete t2.tracks;
  if (!t2.off?.length) delete t2.off;
  p.theme = t2;
  if (p.assets) p.assets = p.assets.filter(a => !drop.has(a.name));
  return drop;
}

export async function storePacks(existing: Pack[], incoming: Pack[]): Promise<Pack[]> {
  const merged = new Map<string, Pack>();
  // a game added again is read fresh: the new import is the base of the merge (so everything newer versions of
  // MomoGram read from a game, like icons, pictures or music, arrives), and names, region exclusives and songs of
  // the versions already stored are merged in. A file both versions have comes from the base (animation indices
  // differ between regions); the other version's other files (its music) stay.
  for (const p of [...incoming, ...existing.filter(x => incoming.some(i => i.id === x.id))]) {
    const m = merged.get(p.id);
    merged.set(p.id, m ? mergePacks(m, p) : p);
  }
  const ps = [...merged.values()];
  for (const p of ps) {
    const drop = await oneRelease(p);
    const { assets, ...rest } = p;
    for (const a of assets ?? []) if (!drop.has(a.name)) await storage.saveAsset(p.id, a.name, a.data);
    for (const f of drop) await storage.deleteAsset(p.id, f).catch(() => {});
    delete (p as any).assets;
    await storage.savePack(rest as Pack);
  }
  // files a new version of a pack replaced
  await storage.sweepAssets().catch(() => {});
  return [...existing.filter(x => !merged.has(x.id)), ...ps].sort((a, b) => pickAny(a.title, 'en').localeCompare(pickAny(b.title, 'en')));
}
