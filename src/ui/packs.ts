// Pack manager: list, import (.json / .zip), export, delete, and create packs from the user's own games.
import { Pack, PackAsset, packFileName, pickText, pickAny, validatePack, mergePacks, assetDir } from '../packs/format';
import { importGameFile } from '../packs/importers/index';
import '../packs/importers/all';
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

export function openPackManager(pm: PM) {
  const list = h('div', { class: 'packlist' });
  const render = () => {
    list.innerHTML = '';
    const packs = pm.packs();
    if (!packs.length) list.append(h('p', { class: 'fine' }, t('noPacks')));
    for (const p of packs) {
      const n = p.levels.reduce((a, l) => a + l.puzzles.length, 0);
      list.append(h('div', { class: 'pack' },
        h('button', { class: 'btn packbtn', onClick: () => pm.openPack(p) },
          h('b', {}, pickAny(p.title, lang())),
          h('small', {}, `${p.source.platform}${p.source.region ? ' · ' + p.source.region : ''} · ${n} ${t('puzzles')}` + (p.theme?.music ? ' · ♪' : ''))),
        h('button', { class: 'btn ghost', title: t('download'), onClick: () => p.theme?.music && withMusic() ? exportZip([p], packFileName(p).replace(/\.json$/, '.zip')) : download(packFileName(p), JSON.stringify(p), 'application/json') }, '⤓'),
        h('button', { class: 'btn ghost', title: t('delete'), onClick: async () => {
          if (!confirm(t('delete') + ': ' + pickAny(p.title, lang()) + '?')) return;
          await storage.deletePack(p.id);
          await storage.deleteAssets(p.id).catch(() => {});
          pm.setPacks(pm.packs().filter(x => x.id !== p.id));
          render();
        } }, '🗑')));
    }
  };

  const status = h('div', { class: 'status' });

  async function addPacks(incoming: Pack[]) {
    pm.setPacks(await storePacks(pm.packs(), incoming));
    render();
    renderOnline();
  }

  /** one button for everything: game files, archives of games, pack files (.json) and pack exports (.zip) */
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
      // archives (.zip/.7z/.rar) may hold several games, or packs exported by MomoGram
      let entries: Array<{ name: string; data: Uint8Array }>;
      try {
        if (/\.zip$/i.test(f.name)) { const d = new Uint8Array(await f.arrayBuffer()); try { entries = unzipAll(d); } catch { entries = await extractAll(f); } }
        else entries = isArchive(f.name) ? await extractAll(f) : [{ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }];
      } catch (e: any) { li.textContent = f.name + ': ✕ ' + (e.message || e); continue; }
      const r = await readEntries(entries, withMusic());
      made.push(...r.made); fromPackFiles += r.fromPackFiles;
      li.textContent = f.name + ': ' + (r.msgs.join(' · ') || '✕ ' + t('unsupported'));
    }
    if (made.length) {
      await addPacks(made);
      const ids = new Set(made.map(p => p.id));
      const unique = pm.packs().filter(p => ids.has(p.id));
      // offering an export only makes sense for packs made from games
      if (made.length > fromPackFiles) results.append(h('li', {}, h('button', { class: 'btn primary', onClick: () => exportZip(unique, 'momogram-new-packs.zip') }, t('exportAll'))));
    }
  }

  /** what's in a file or archive: MomoGram packs (with their files) and games */
  async function readEntries(entries: Array<{ name: string; data: Uint8Array }>, keepAssets: boolean) {
    const made: Pack[] = [], msgs: string[] = [];
    let fromPackFiles = 0;
    {
      entries = entries.filter(e => !/\.(url|txt|nfo|jpg|png|md)$/i.test(e.name) && !/(^|\/)(__MACOSX|\.)/.test(e.name));
      // MomoGram pack files, with their music next to them (<pack>.assets/<name>)
      const assetDirs: string[] = [];
      for (const e of entries) {
        if (!/\.json$/i.test(e.name)) continue;
        let p: any;
        try { p = JSON.parse(new TextDecoder().decode(e.data)); } catch { continue; }
        if (!validatePack(p)) continue;
        const dir = e.name.replace(/[^/]*$/, '') + assetDir(p);
        assetDirs.push(dir, e.name);
        const assets: PackAsset[] = entries.filter(x => x.name.startsWith(dir)).map(x => ({ name: x.name.slice(dir.length), data: x.data }));
        if (assets.length && keepAssets) p.assets = assets;
        made.push(p); fromPackFiles++;
        msgs.push(`✓ ${pickAny(p.title, lang())} (${p.levels.reduce((a: number, l: any) => a + l.puzzles.length, 0)})`);
      }
      // everything else is read as a game
      for (const e of entries) {
        if (assetDirs.some(d => e.name === d || e.name.startsWith(d)) || /\.json$/i.test(e.name)) continue;
        const r = await importGameFile(e.name, e.data);
        if (r.ok) {
          for (const p of r.packs) { p.source.file = e.name; made.push(p); }
          msgs.push(`✓ ${r.packs.map(p => `${pickAny(p.title, lang())} (${p.levels.reduce((a, l) => a + l.puzzles.length, 0)})`).join(', ')}`);
        } else {
          msgs.push(`✕ ${e.name}: ${r.message === 'encrypted' ? t('encrypted') : r.message === 'unsupported' ? t('unsupported') : r.message}`);
        }
      }
    }
    return { made, msgs, fromPackFiles };
  }

  // music in zip exports / imports can be left out to save space (the switch is remembered)
  const withMusic = () => localStorage.getItem('momogram.zipMusic') !== 'off';
  const musicSwitch = h('label', { class: 'opt zipmusic' }, h('span', {}, t('zipMusic')),
    h('input', { type: 'checkbox', checked: withMusic() ? true : undefined, onChange: (e: Event) => localStorage.setItem('momogram.zipMusic', (e.target as HTMLInputElement).checked ? 'on' : 'off') }));

  async function packZip(ps: Pack[], withAssets: boolean): Promise<Uint8Array> {
    const entries: Array<{ name: string; text?: string; data?: Uint8Array }> = [];
    for (const p of ps) {
      const { assets, ...rest } = p;
      entries.push({ name: packFileName(p), text: JSON.stringify(rest) });
      for (const a of withAssets ? await storage.assetNames(p.id).catch(() => [] as string[]) : []) {
        const data = await storage.loadAsset(p.id, a);
        if (data) entries.push({ name: assetDir(p) + a, data });
      }
    }
    return makeZip(entries);
  }
  async function exportZip(ps: Pack[], name = 'momogram-packs.zip') { download(name, await packZip(ps, withMusic()), 'application/zip'); }

  // ---- packs on the MomoGram server (everything: packs from games keep their music and pictures) ----
  const online = h('div', { class: 'online' });
  const puzzlesOf = (p: Pack) => p.levels.reduce((a, l) => a + l.puzzles.length, 0);
  async function renderOnline() {
    online.innerHTML = '';
    if (!Sync.account()) { if (Sync.serverUrl()) online.append(h('p', { class: 'fine' }, t('serverLogin'))); return; }
    const msg = h('p', { class: 'fine server-msg' });
    online.append(h('h2', {}, '☁ ' + t('onServer')), msg);
    let list: Sync.ServerPack[];
    try { list = await Sync.serverPacks(); } catch (e) { msg.textContent = serverError(e); msg.classList.add('bad'); return; }
    const have = new Set(pm.packs().map(p => p.id));
    if (!list.length) online.append(h('p', { class: 'fine' }, t('serverEmpty')));
    for (const sp of list) {
      const title = pickAny(sp.meta?.title, lang()) || sp.id;
      const dl = h('button', { class: 'btn ghost', title: t('download') }, '⤓');
      dl.onclick = async () => {
        dl.disabled = true; dl.textContent = '…';
        try {
          const r = await readEntries(unzipAll(await Sync.downloadPack(sp.id)), true);
          if (r.made.length) await addPacks(r.made);
          renderOnline();
        } catch (e) { msg.textContent = serverError(e); msg.classList.add('bad'); dl.disabled = false; dl.textContent = '⤓'; }
      };
      const mine = sp.by === Sync.account()?.name || Sync.account()?.admin;
      online.append(h('div', { class: 'pack' },
        h('div', { class: 'btn packbtn static' },
          h('b', {}, title),
          h('small', {}, [sp.meta?.platform, sp.meta?.puzzles !== undefined ? `${sp.meta.puzzles} ${t('puzzles')}` : '', sp.size < 1048576 ? `${Math.max(1, Math.round(sp.size / 1024))} KB` : `${(sp.size / 1048576).toFixed(1)} MB`, sp.by ? t('uploadedBy', { name: sp.by }) : '', have.has(sp.id) ? '✓ ' + t('installed') : ''].filter(Boolean).join(' · '))),
        dl,
        mine ? h('button', { class: 'btn ghost', title: t('delete'), onClick: async () => {
          if (!confirm(t('delete') + ' (' + t('onServer') + '): ' + title + '?')) return;
          try { await Sync.deleteServerPack(sp.id); } catch (e) { alert(serverError(e)); }
          renderOnline();
        } }, '🗑') : null));
    }
    // upload: pick local packs
    const onServer = new Map(list.map(s => [s.id, s]));
    const up = h('button', { class: 'btn', onClick: () => {
      const box = h('div', { class: 'uplist' });
      const checks = pm.packs().map(p => {
        const c = h('input', { type: 'checkbox', checked: onServer.has(p.id) ? undefined : true }) as HTMLInputElement;
        box.append(h('label', {}, c, pickAny(p.title, lang()) + (onServer.has(p.id) ? ' (☁)' : '')));
        return [p, c] as const;
      });
      const bar = h('div', { class: 'bar-inner', style: 'width:0%' });
      const go = h('button', { class: 'btn primary' }, '⇧ ' + t('upload'));
      go.onclick = async () => {
        const pick = checks.filter(([, c]) => c.checked).map(([p]) => p);
        go.disabled = true;
        try {
          for (let i = 0; i < pick.length; i++) {
            const p = pick[i];
            const zip = await packZip([p], true);
            await Sync.uploadPack(p.id, { title: p.title, puzzles: puzzlesOf(p), platform: p.source.platform }, zip,
              d => { bar.style.width = ((i + d) / pick.length) * 100 + '%'; });
          }
          renderOnline();
        } catch (e) { msg.textContent = serverError(e); msg.classList.add('bad'); go.disabled = false; }
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
      h('button', { class: 'btn', onClick: () => exportZip(pm.packs()) }, '⤓ ' + t('exportAll'))),
    musicSwitch,
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
