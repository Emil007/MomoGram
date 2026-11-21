// Pack manager: the installed packs, adding games and pack files, exporting .momopack files, and the packs on the
// MomoGram server (download, update, upload).
import { Pack, pickAny, mergePacks } from '../packs/format';
import { readEntries, momopackOf, momopackName, packRev, newRev } from '../packs/io';
import { importFileSet } from '../packs/importers/index';
import { storage } from '../store';
import { t, lang } from '../i18n';
import { h, pickFiles, serverError } from '../app';
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
          if (!confirm(t('delete') + ': ' + pickAny(p.title, lang()) + '?')) return;
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

  /** a folder: Switch games are folders (their RomFS); other games in it are read one by one */
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
    const li = h('li', {}, t('analyzing'));
    results.append(li);
    const byName = new Map(files.map(f => [(f as any).webkitRelativePath || f.name, f]));
    const names = [...byName.keys()];
    const made: Pack[] = [];
    const sets = await importFileSet({ names, get: async n => { const f = byName.get(n); return f ? new Uint8Array(await f.arrayBuffer()) : undefined; } });
    li.remove();
    for (const r of sets.results) {
      if (r.ok) { const rev = newRev(); for (const p of r.packs) { p.source.file = r.file; p.rev = rev; made.push(p); } }
      results.append(h('li', {}, r.file + ': ' + (r.ok ? '✓ ' + r.packs.map(p => pickAny(p.title, lang())).join(', ') : '✕ ' + (r.message === 'unsupported' ? t('unsupported') : r.message))));
    }
    // everything else: like single files (folders of ROMs)
    for (const n of names) {
      if (sets.used(n) || !/\.(gb|gbc|sfc|smc|bs|nds|srl|3ds|cci|cxi|cia|zip|7z|rar|momopack|json)$/i.test(n)) continue;
      const f = byName.get(n)!;
      const line = h('li', {}, n + ' … ' + t('analyzing'));
      results.append(line);
      try {
        const r = await readEntries(await filesToEntries({ name: f.name, file: f }), lang(), t);
        made.push(...r.made);
        line.textContent = n + ': ' + (r.msgs.join(' · ') || '✕ ' + t('unsupported'));
      } catch (e: any) { line.textContent = n + ': ✕ ' + (e.message || e); }
    }
    if (made.length) await addPacks(made);
    else if (!results.children.length) results.append(h('li', {}, '✕ ' + t('unsupported')));
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
          if (!confirm(t('delete') + ' (' + t('onServer') + '): ' + title + '?')) return;
          try { await Sync.deleteServerPack(sp.id); } catch (e) { alert(serverError(e)); }
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
export async function storePacks(existing: Pack[], incoming: Pack[]): Promise<Pack[]> {
  const merged = new Map<string, Pack>();
  // a game added again is read fresh: the new import is the base of the merge (so everything newer versions of
  // MomoGram read from a game, like icons, pictures or music, arrives), and names and region exclusives of the
  // version already stored are merged in. Only the base's assets fit its puzzles (animation indices differ
  // between regions), so assets of the other versions are dropped.
  const baseAssets = new Map<string, Pack['assets'] | null>();
  for (const p of [...incoming, ...existing.filter(x => incoming.some(i => i.id === x.id))]) {
    const m = merged.get(p.id);
    if (!baseAssets.has(p.id)) baseAssets.set(p.id, existing.includes(p) ? null : p.assets ?? null);
    merged.set(p.id, m ? mergePacks(m, p) : p);
  }
  const ps = [...merged.values()];
  for (const p of ps) {
    const { assets: _, ...rest } = p;
    for (const a of baseAssets.get(p.id) ?? []) await storage.saveAsset(p.id, a.name, a.data);
    delete (p as any).assets;
    await storage.savePack(rest as Pack);
  }
  return [...existing.filter(x => !merged.has(x.id)), ...ps].sort((a, b) => pickAny(a.title, 'en').localeCompare(pickAny(b.title, 'en')));
}
