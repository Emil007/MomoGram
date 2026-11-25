// Pack manager: the installed packs, adding games and pack files, exporting .momopack files, and the packs on the
// MomoGram server (download, update, upload).
import { Pack, PackTheme, pickAny, mergePacks, scansOf, joinScans, songsOf, roleSongs, setRoleSongs, SongRole, validatePack } from '../packs/format';
import { readEntries, momopackOf, momopackName, packRev, newRev } from '../packs/io';
import { importFileSet, setImportAsk } from '../packs/importers/index';
import { storage } from '../store';
import { t, lang } from '../i18n';
import { h, pickFiles, serverError } from '../app';
import { confirmBox, message } from './dialog';
import * as Sync from '../sync';
import { download, makeZip, unzipAll, sha1 } from '../util/files';
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

// a game file of another version than the importer knows: the player decides
setImportAsk(q => confirmBox(t('apkVersionAsk', { game: q.game, have: q.have, want: q.want }), t('tryAnyway')));

export function openPackManager(pm: PM) {
  const list = h('div', { class: 'packlist' });
  const pickBar = h('div', { class: 'pick-bar' });
  const marked = new Set<string>();
  let picking = false;
  // the click that ends a long-press must not also toggle the pack the finger is still on
  let ignoreClickUntil = 0;
  let withMusicOn = true;
  const count = (p: Pack) => p.levels.reduce((a, l) => a + l.puzzles.length, 0);

  async function deleteMarked() {
    const ps = pm.packs().filter(p => marked.has(p.id));
    if (!ps.length) return;
    const q = ps.length === 1 ? t('delete') + ': ' + pickAny(ps[0].title, lang()) + '?' : t('deleteAsk', { n: ps.length });
    if (!(await confirmBox(q, t('delete'), true))) return;
    for (const p of ps) {
      await storage.deletePack(p.id);
      await storage.deleteAssets(p.id).catch(() => {});
    }
    const drop = new Set(ps.map(p => p.id));
    pm.setPacks(pm.packs().filter(x => !drop.has(x.id)));
    marked.clear(); picking = false;
    render(); renderOnline();
  }

  async function updateMarked(btn: HTMLButtonElement) {
    const ps = pm.packs().filter(p => marked.has(p.id));
    if (!ps.length) return;
    if (!Sync.account()) { await message(t('serverLogin')); return; }
    const label = btn.textContent;
    btn.disabled = true;
    try {
      const server = await Sync.serverPacks();
      const byId = new Map(server.map(s => [s.id, s]));
      const want: Sync.ServerPack[] = [];
      for (const p of ps) {
        const sp = byId.get(p.id);
        if (!sp) continue;
        if ((sp.meta?.rev ?? 1) > packRev(p) || await missingFiles(p.id)) want.push(sp);
      }
      if (!want.length) { await message(t('noneToUpdate')); btn.disabled = false; btn.textContent = label; return; }
      await fetchServerPacks(pm, want, text => { btn.textContent = text; }, withMusicOn);
      marked.clear(); picking = false;
      render(); renderOnline();
    } catch (e) { await message(serverError(e)); btn.disabled = false; btn.textContent = label; }
  }

  const render = () => {
    list.innerHTML = '';
    const packs = pm.packs();
    for (const id of [...marked]) if (!packs.some(p => p.id === id)) marked.delete(id);
    if (!marked.size) picking = false;
    pickBar.replaceChildren();
    if (picking) {
      const n = marked.size;
      const del = h('button', { class: 'btn danger', disabled: n ? undefined : true, onClick: () => deleteMarked() }, '🗑 ' + t('delete')) as HTMLButtonElement;
      const dl = h('button', { class: 'btn', disabled: n ? undefined : true, onClick: () => exportAll(packs.filter(p => marked.has(p.id))) }, '⤓ ' + t('download')) as HTMLButtonElement;
      const upd = h('button', { class: 'btn', disabled: n ? undefined : true }, '⟳ ' + t('update')) as HTMLButtonElement;
      upd.onclick = () => updateMarked(upd);
      pickBar.append(h('b', {}, t('markedN', { n })), del, dl, upd,
        h('button', { class: 'btn ghost', onClick: () => { marked.clear(); picking = false; render(); } }, t('back')));
    }
    if (!packs.length) list.append(h('p', { class: 'fine' }, t('noPacks')));
    else if (!picking) list.append(h('p', { class: 'fine' }, t('holdToMark')));
    for (const p of packs) {
      const open = h('button', { class: 'btn packbtn', title: t('holdToMark') },
        h('b', {}, (marked.has(p.id) ? '✓ ' : '') + pickAny(p.title, lang())),
        h('small', {}, `${p.source.platform}${p.source.region ? ' · ' + p.source.region : ''} · ${count(p)} ${t('puzzles')}` + (p.theme?.music ? ' · ♪' : ''))) as HTMLButtonElement;
      let timer = 0, held = false, sx = 0, sy = 0;
      const stop = () => { window.clearTimeout(timer); timer = 0; };
      const arm = () => {
        picking = true;
        marked.add(p.id);
        ignoreClickUntil = performance.now() + 700;
        try { navigator.vibrate?.(15); } catch { /* this device doesn't vibrate */ }
        render();
      };
      open.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        held = false; sx = e.clientX; sy = e.clientY;
        timer = window.setTimeout(() => { timer = 0; held = true; arm(); }, 450);
      });
      open.addEventListener('pointermove', e => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 12) stop(); });
      open.addEventListener('pointerup', stop);
      open.addEventListener('pointercancel', stop);
      open.addEventListener('contextmenu', e => { e.preventDefault(); arm(); });
      open.addEventListener('click', () => {
        if (held || performance.now() < ignoreClickUntil) { held = false; return; }
        if (picking) {
          if (marked.has(p.id)) marked.delete(p.id); else marked.add(p.id);
          if (!marked.size) picking = false;
          render();
          return;
        }
        pm.openPack(p);
      });
      const row = h('div', { class: 'pack' + (marked.has(p.id) ? ' marked' : '') }, open);
      if (!picking) {
        row.append(h('button', { class: 'btn ghost', title: t('download'), onClick: async () => download(momopackName(p), await momopackOf(p)) }, '⤓'),
          h('button', { class: 'btn ghost', title: t('delete'), onClick: async () => {
            if (!(await confirmBox(t('delete') + ': ' + pickAny(p.title, lang()) + '?', t('delete'), true))) return;
            await storage.deletePack(p.id);
            await storage.deleteAssets(p.id).catch(() => {});
            pm.setPacks(pm.packs().filter(x => x.id !== p.id));
            render(); renderOnline();
          } }, '🗑'));
      }
      list.append(row);
    }
  };

  const status = h('div', { class: 'status' });

  /** stores the packs; returns the titles of those that brought nothing new */
  async function addPacks(incoming: Pack[]): Promise<string[]> {
    pm.setPacks(await storePacks(pm.packs(), incoming));
    const same = incoming.filter(p => unchanged.has(p.id)).map(p => pickAny(p.title, lang()));
    render();
    renderOnline();
    return [...new Set(same)];
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
      const r = await readEntries(entries, lang(), t, pm.packs());
      made.push(...r.made); fromPackFiles += r.fromPackFiles;
      li.textContent = f.name + ': ' + (r.msgs.join(' · ') || '✕ ' + t('unsupported'));
    }
    if (made.length) {
      const same = await addPacks(made);
      for (const n of same) results.append(h('li', {}, `= ${n}: ${t('noNewData')}`));
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
    const loose = names.filter(n => /\.(gb|gbc|sfc|smc|bs|nds|srl|3ds|cci|cxi|cia|app|hex|apk|xapk|apkm|apks|zip|7z|rar|momopack)$/i.test(n));
    let done = 0;
    // packs this run added or changed, each counted once (a game in several files is read several times)
    const changed = new Set<string>();
    const count = (ps: Pack[]) => { for (const p of ps) if (!unchanged.has(p.id)) changed.add(p.id); };
    const progress = h('li', { class: 'progress' });
    results.append(progress);
    const step = (what: string) => { progress.textContent = `${t('analyzing')} ${what}`; };
    step('');
    await importFileSet({ names, get: async n => { const f = byName.get(n); return f ? new Uint8Array(await f.arrayBuffer()) : undefined; } }, async r => {
      let same: string[] = [];
      if (r.ok) { const rev = newRev(); for (const p of r.packs) { p.source.file = r.file; p.rev = rev; } same = await addPacks(r.packs); count(r.packs); }
      results.insertBefore(h('li', {}, r.file + ': ' + (r.ok ? (same.length === r.packs.length ? '= ' + t('noNewData') : '✓ ' + r.packs.map(p => pickAny(p.title, lang())).join(', ')) : r.message === 'uptodate' ? '= ' + t('upToDate') : '✕ ' + (r.message === 'unsupported' ? t('unsupported') : r.message))), progress);
    }, pm.packs()).then(s => { for (let i = loose.length - 1; i >= 0; i--) if (s.used(loose[i])) loose.splice(i, 1); });
    for (const n of loose) {
      const f = byName.get(n)!;
      step(`${++done}/${loose.length} · ${n}`);
      const line = h('li', {}, n + ' … ');
      results.insertBefore(line, progress);
      try {
        const r = await readEntries(await filesToEntries({ name: f.name, file: f }), lang(), t, pm.packs());
        let same: string[] = [];
        if (r.made.length) { same = await addPacks(r.made); count(r.made); }
        line.textContent = n + ': ' + (same.length && same.length === r.made.length ? '= ' + t('noNewData') : r.msgs.join(' · ') || '✕ ' + t('unsupported'));
      } catch (e: any) { line.textContent = n + ': ✕ ' + (e.message || e); }
    }
    progress.textContent = t('folderDone', { n: changed.size });
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
    // installed packs that miss a file their download should have brought (not music, which can be left out)
    const incomplete = new Set<string>();
    for (const sp of list) if (local.has(sp.id) && await missingFiles(sp.id)) incomplete.add(sp.id);
    const state = (sp: Sync.ServerPack) => {
      const mine = local.get(sp.id);
      if (!mine) return 'new';
      const a = packRev(mine), b = sp.meta?.rev ?? 1;
      if (incomplete.has(sp.id)) return 'update';
      return b > a ? 'update' : a > b ? 'newer-here' : 'same';
    };
    // download (install or update) one or several: one after the other, with the progress in the button.
    // Split packs: files this device has already (any pack's) aren't downloaded; music can be left out.
    const fetchPacks = async (sps: Sync.ServerPack[], btn: HTMLButtonElement, music = true) => {
      const label = btn.textContent;
      btn.disabled = true;
      try {
        await fetchServerPacks(pm, sps, text => { btn.textContent = text; }, music);
        render(); renderOnline();
      } catch (e) { bad(e); btn.disabled = false; btn.textContent = label; }
    };
    const withMusic = h('input', { type: 'checkbox', checked: withMusicOn ? true : undefined, onChange: () => { withMusicOn = withMusic.checked; } }) as HTMLInputElement;
    const mb = (n: number) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
    // installed packs whose music was left out
    const musicMissing = async (p: Pack) => {
      const have = new Set(await storage.assetNames(p.id).catch(() => [] as string[]));
      return songsOf(p.theme).some(r => !have.has(r.split('#')[0]));
    };
    const missing = list.filter(s => state(s) === 'new'), updates = list.filter(s => state(s) === 'update');
    const actions = h('div', { class: 'row wrap' });
    const upSlot = h('div', { class: 'up-slot' });
    if (list.length) {
      const need = missing.length + updates.length;
      // one pack left: say "Download", not "Download all"
      const all = h('button', { class: 'btn' + (need ? ' primary' : ''), disabled: need ? undefined : true },
        `⤓ ${need === 1 ? t('download') : t('downloadAll')} (${need})`) as HTMLButtonElement;
      all.onclick = () => fetchPacks([...updates, ...missing], all, withMusic.checked);
      const upd = h('button', { class: 'btn', disabled: updates.length ? undefined : true }, `⟳ ${t('updateAll')} (${updates.length})`) as HTMLButtonElement;
      upd.onclick = () => fetchPacks(updates, upd, withMusic.checked);
      actions.append(all, upd);
    }
    // upload lives with download and update, above the server packs (the checklist opens just under them)
    const onServer = new Map(list.map(s => [s.id, s]));
    if (pm.packs().length) {
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
              const meta = { title: p.title, puzzles: count(p), platform: p.source.platform, rev: packRev(p) };
              const prog = (d: number) => { bar.style.width = ((i + d) / pick.length) * 100 + '%'; };
              if (await Sync.serverApi() >= 2) {
                // pack.json + files by hash: files the server has (from other packs) aren't sent again
                const { assets: _a, ...json } = p;
                if (!validatePack(json)) throw new Error(t('downloadBroken') + ' (pack)');
                const musicFiles = new Set(songsOf(p.theme).map(r => r.split('#')[0]));
                const files = [];
                for (const name of await storage.assetNames(p.id)) {
                  const data = await storage.loadAsset(p.id, name);
                  if (!data) continue;
                  const hash = await sha1(data);
                  files.push({ name, hash, size: data.length, music: musicFiles.has(name), data: async () => data });
                }
                await Sync.uploadPackSplit(p.id, meta, json, files, prog);
              } else await Sync.uploadPack(p.id, meta, await momopackOf(p), prog);
            }
            renderOnline();
          } catch (e) { bad(e); go.disabled = false; }
        };
        box.append(h('div', { class: 'bar-outer' }, bar), go);
        upSlot.replaceChildren(box);
      } }, '⇧ ' + t('uploadPacks'));
      actions.append(up);
    }
    if (actions.childNodes.length) online.append(actions, upSlot);
    if (list.length) online.append(h('label', { class: 'with-music' }, withMusic, ' ♪ ' + t('withMusic')));
    else online.append(h('p', { class: 'fine' }, t('serverEmpty')));
    for (const sp of list) {
      const title = pickAny(sp.meta?.title, lang()) || sp.id;
      const st = state(sp);
      const dl = h('button', { class: 'btn ghost', title: st === 'update' ? t('update') : t('download') }, st === 'update' ? '⟳' : '⤓') as HTMLButtonElement;
      dl.onclick = () => fetchPacks([sp], dl, withMusic.checked);
      // installed without its music: get it now (only the music files are downloaded)
      const addMusic = h('button', { class: 'btn ghost', title: t('addMusic'), hidden: true }, '♪+') as HTMLButtonElement;
      addMusic.onclick = () => fetchPacks([sp], addMusic, true);
      const mine0 = local.get(sp.id);
      if (sp.split && sp.music && mine0 && (st === 'same' || st === 'newer-here')) musicMissing(mine0).then(m => { addMusic.hidden = !m; });
      const acc = Sync.account();
      const mine = sp.by === acc?.name || acc?.admin;
      const note = st === 'same' ? '✓ ' + t('installed') : incomplete.has(sp.id) ? '⚠ ' + t('filesMissing') : st === 'update' ? '⬆ ' + t('updateAvailable') : st === 'newer-here' ? '⇧ ' + t('newerHere') : '';
      online.append(h('div', { class: 'pack' + (st === 'update' ? ' has-update' : '') },
        h('div', { class: 'btn packbtn static' },
          h('b', {}, title),
          h('small', {}, [sp.meta?.platform, sp.meta?.puzzles !== undefined ? `${sp.meta.puzzles} ${t('puzzles')}` : '', mb(sp.size) + (sp.music ? ` (♪ ${mb(sp.music)})` : ''), sp.by ? t('uploadedBy', { name: sp.by }) : '', note].filter(Boolean).join(' · '))),
        st === 'same' || st === 'newer-here' ? addMusic : dl,
        mine ? h('button', { class: 'btn ghost', title: t('delete'), onClick: async () => {
          if (!(await confirmBox(t('delete') + ' (' + t('onServer') + '): ' + title + '?', t('delete'), true))) return;
          try { await Sync.deleteServerPack(sp.id); } catch (e) { await message(serverError(e)); }
          renderOnline();
        } }, '🗑') : null));
    }
  }

  render();
  pm.screen(pm.header(t('packs')), h('div', { class: 'packs' },
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn primary', onClick: addFiles }, '✚ ' + t('addFiles')),
      h('button', { class: 'btn', onClick: addFolder }, '📁 ' + t('addFolder')),
      h('button', { class: 'btn', onClick: () => exportAll(pm.packs()) }, '⤓ ' + t('exportAll'))),
    h('p', { class: 'fine' }, t('createHelp')),
    status, pickBar, list, online));
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
/**
 * Download (install or update) packs from the server, one after the other; `step` gets the progress as a short
 * text. Split packs: files this device has already (any pack's) aren't downloaded; music can be left out.
 */
export async function fetchServerPacks(pm: Pick<PM, 'packs' | 'setPacks'>, sps: Sync.ServerPack[], step: (text: string) => void, music = true) {
  const lock = keepAwake();
  try {
    for (let i = 0; i < sps.length; i++) {
      step(`${i + 1}/${sps.length} …`);
      const split = sps[i].split ? await steady(sig => Sync.packSplit(sps[i].id), () => step(`${i + 1}/${sps.length} · ${t('waiting')}`)) : null;
      let made: Pack[];
      if (split) {
        const raw = split.pack as Pack;
        if (!raw || raw.id !== sps[i].id) throw new Error(t('downloadBroken') + ` (${sps[i].id}: id)`);
        if (!validatePack(raw)) throw new Error(t('downloadBroken') + ` (${sps[i].id}: pack)`);
        const p = raw;
        p.assets = [];
        const want = (split.assets ?? []).filter(a => music || !a.music);
        for (let k = 0; k < want.length; k++) {
          const a = want[k];
          if (!a.name || a.name.length > 240 || a.name.includes('..') || a.name.startsWith('/') || a.name.includes('\\') || a.name.includes('\0') || !/^[0-9a-f]{40}$/.test(a.hash)) {
            throw new Error(t('downloadBroken') + ` (${a?.name || 'asset'}: list)`);
          }
          step(`${i + 1}/${sps.length} · ${k + 1}/${want.length}`);
          // a file this device has (any pack's, or one an interrupted download already got) isn't fetched again —
          // but only if its bytes still match the hash (a half-written cache must not be trusted)
          let data = await storage.loadBlob(a.hash).catch(() => undefined);
          if (data && await sha1(data) !== a.hash) data = undefined;
          if (!data) {
            data = await steady(sig => Sync.downloadBlob(a.hash, sig), () => step(`${i + 1}/${sps.length} · ${k + 1}/${want.length} · ${t('waiting')}`));
            if (data.length !== (a.size || data.length)) throw new Error(t('downloadBroken') + ` (${a.name}: size ${data.length}/${a.size})`);
            if (await sha1(data) !== a.hash) throw new Error(t('downloadBroken') + ` (${a.name}: hash)`);
            await storage.saveDownload(data);
          }
          p.assets.push({ name: a.name, data });
        }
        made = [p];
      } else {
        made = (await readEntries(unzipAll(await steady(() => Sync.downloadPack(sps[i].id))), lang(), t)).made.filter(p => p.id === sps[i].id && validatePack(p));
        if (!made.length) throw new Error(t('downloadBroken') + ` (${sps[i].id}: zip)`);
      }
      // a pack from the server keeps its revision (old uploads without one count as 1)
      for (const p of made) if (p.rev === undefined && sps[i].meta?.rev) p.rev = sps[i].meta.rev;
      if (made.length) {
        const stored = await storePacks(pm.packs(), made);
        // a download that brought nothing new (this device already had the same content) still takes the
        // server's revision, else the pack is offered as an update again and again
        const rev = sps[i].meta?.rev ?? 1;
        for (let k = 0; k < stored.length; k++) {
          const q = stored[k];
          if (made.some(m => m.id === q.id) && packRev(q) < rev) { stored[k] = { ...q, rev }; await storage.savePack(stored[k]); }
        }
        pm.setPacks(stored);
        // what a later look checks: the files (not music) this download stored
        if (split) {
          const plain = new Set(split.assets.filter(a => !a.music).map(a => a.name));
          setExpected(split.pack.id, (await storage.assetNames(split.pack.id)).filter(n => plain.has(n)));
        }
      }
    }
    await storage.dropDownloads().catch(() => {});
  } finally { lock(); }
}

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

/** what a pack holds, for "did this import bring anything new" (revision, import stamp and file list aside) */
async function contentKey(p: Pack, files: Map<string, string>): Promise<string> {
  const { rev: _r, assets: _a, source, ...rest } = p as Pack & { assets?: unknown };
  const { scan: _s, scans: _ss, file: _f, ...src } = source;
  // empty name lists (older merges wrote them) count as no names
  return JSON.stringify({ ...rest, source: src, files: [...files].sort() }, (k, v) => (k === 'name' && v && typeof v === 'object' && !Object.keys(v).length ? undefined : v));
}
async function storedFiles(id: string): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const n of await storage.assetNames(id).catch(() => [] as string[])) m.set(n, (await storage.assetHash(id, n)) ?? '?');
  return m;
}

/** packs that an import left as they were (it brought nothing new), filled by storePacks */
export const unchanged = new Set<string>();

// ---- downloads that survive a phone going to sleep or a dropped connection ----

/** files a pack's download brought (by name, music not counted), so a later look can tell if one is missing */
const EXPECT_KEY = 'momogram.packFiles';
function expected(): Record<string, string[]> { try { return JSON.parse(localStorage.getItem(EXPECT_KEY) || '{}'); } catch { return {}; } }
function setExpected(id: string, names: string[]) { const e = expected(); if (names.length) e[id] = names; else delete e[id]; try { localStorage.setItem(EXPECT_KEY, JSON.stringify(e)); } catch { /* full */ } }
async function missingFiles(id: string): Promise<boolean> {
  const want = expected()[id];
  if (!want?.length) return false;
  const have = new Set(await storage.assetNames(id).catch(() => [] as string[]));
  return want.some(n => !have.has(n));
}

const visible = () => new Promise<void>(res => {
  if (!document.hidden && navigator.onLine !== false) { res(); return; }
  const go = () => { if (!document.hidden && navigator.onLine !== false) { document.removeEventListener('visibilitychange', go); window.removeEventListener('online', go); res(); } };
  document.addEventListener('visibilitychange', go); window.addEventListener('online', go);
});

/**
 * A request that doesn't give up: while the page is hidden (phone asleep, other app) or offline it waits and then
 * tries again; a request still running when the page is hidden is cancelled and repeated once it's back (a
 * phone that slept may never answer it). Other failures are tried five times, a little later each time.
 */
async function steady<T>(run: (signal: AbortSignal) => Promise<T>, waiting?: () => void): Promise<T> {
  for (let fails = 0; ; ) {
    if (document.hidden || navigator.onLine === false) { waiting?.(); await visible(); }
    const ctl = new AbortController();
    let hid = false;
    const onHide = () => { if (document.hidden) { hid = true; ctl.abort(); } };
    document.addEventListener('visibilitychange', onHide);
    try { return await run(ctl.signal); }
    catch (e) {
      if (hid || document.hidden || navigator.onLine === false) { waiting?.(); continue; }
      if (e instanceof Sync.ServerError && e.status >= 400 && e.status < 500) throw e;
      if (++fails >= 5) throw e;
      waiting?.();
      await new Promise(r => setTimeout(r, 1000 * 2 ** fails));
    } finally { document.removeEventListener('visibilitychange', onHide); }
  }
}

/** keeps the screen on while something downloads (where the browser allows it); returns the release */
function keepAwake(): () => void {
  let lock: any = null, done = false;
  const take = async () => { try { if (!done && !document.hidden) lock = await (navigator as any).wakeLock?.request('screen'); } catch { /* not allowed */ } };
  const again = () => { if (!document.hidden) take(); };
  take(); document.addEventListener('visibilitychange', again);
  return () => { done = true; document.removeEventListener('visibilitychange', again); lock?.release?.().catch(() => {}); };
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
  unchanged.clear();
  for (const p of ps) setExpected(p.id, []);
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const drop = await oneRelease(p);
    // a game read again that brings nothing new (same puzzles, names, music, pictures, …) is left alone: no new
    // revision (so nothing is uploaded again); only the note of which importer read it is updated
    const old = existing.find(x => x.id === p.id);
    if (old) {
      const before = await storedFiles(p.id);
      const after = new Map(before);
      for (const a of (p as Pack & { assets?: Array<{ name: string; data: Uint8Array }> }).assets ?? []) if (!drop.has(a.name)) after.set(a.name, await sha1(a.data));
      for (const f of drop) after.delete(f);
      const ka = await contentKey({ ...p, rev: old.rev }, after), kb = await contentKey(old, before);
      const same = ka === kb;
      if (same) {
        const { scan: _s, ...oldSrc } = old.source;
        const kept: Pack = { ...old, source: { ...oldSrc, scans: joinScans(scansOf(old), scansOf(p)) } };
        await storage.savePack(kept);
        unchanged.add(p.id);
        ps[i] = kept;
        continue;
      }
    }
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
