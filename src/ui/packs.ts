// Pack manager: list, import (.json / .zip), export, delete, and create packs from the user's own games.
import { Pack, packFileName, pickText, pickAny, validatePack, mergePacks } from '../packs/format';
import { importGameFile } from '../packs/importers/index';
import '../packs/importers/all';
import { storage } from '../store';
import { t, lang } from '../i18n';
import { h, pickFiles } from '../app';
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
          h('small', {}, `${p.source.platform}${p.source.region ? ' · ' + p.source.region : ''} · ${n} ${t('puzzles')}`)),
        h('button', { class: 'btn ghost', title: t('download'), onClick: () => download(packFileName(p), JSON.stringify(p), 'application/json') }, '⤓'),
        h('button', { class: 'btn ghost', title: t('delete'), onClick: async () => {
          if (!confirm(t('delete') + ': ' + pickAny(p.title, lang()) + '?')) return;
          await storage.deletePack(p.id);
          pm.setPacks(pm.packs().filter(x => x.id !== p.id));
          render();
        } }, '🗑')));
    }
  };

  const status = h('div', { class: 'status' });

  async function addPacks(incoming: Pack[]) {
    // the same game from several regions (or imported twice) becomes one pack with all names
    const merged = new Map<string, Pack>();
    for (const p of [...pm.packs().filter(x => incoming.some(i => i.id === x.id)), ...incoming]) {
      const m = merged.get(p.id);
      merged.set(p.id, m ? mergePacks(m, p) : p);
    }
    const ps = [...merged.values()];
    const cur = pm.packs().filter(x => !merged.has(x.id));
    for (const p of ps) await storage.savePack(p);
    pm.setPacks([...cur, ...ps].sort((a, b) => pickAny(a.title, 'en').localeCompare(pickAny(b.title, 'en'))));
    render();
  }

  async function importPacks() {
    const files = await pickFiles('.json,.zip', true);
    const found: Pack[] = [];
    for (const f of files) {
      const d = new Uint8Array(await f.arrayBuffer());
      const entries = /\.zip$/i.test(f.name) ? unzipAll(d) : [{ name: f.name, data: d }];
      for (const e of entries) {
        if (!/\.json$/i.test(e.name)) continue;
        try {
          const p = JSON.parse(new TextDecoder().decode(e.data));
          if (validatePack(p)) found.push(p);
        } catch { /* skip */ }
      }
    }
    await addPacks(found);
    status.textContent = `${found.length} ✓`;
  }

  async function createPacks() {
    const files = await pickFiles('*', true);
    if (!files.length) return;
    const results = h('ul', { class: 'results' });
    status.innerHTML = '';
    status.append(results);
    const made: Pack[] = [];
    for (const f of files) {
      const li = h('li', {}, f.name + ' … ' + t('analyzing'));
      results.append(li);
      // archives (.zip/.7z/.rar) may hold several games
      let entries: Array<{ name: string; data: Uint8Array }>;
      try { entries = isArchive(f.name) ? await extractAll(f) : [{ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }]; }
      catch (e: any) { li.textContent = f.name + ': ✕ ' + (e.message || e); continue; }
      entries = entries.filter(e => !/\.(url|txt|nfo|jpg|png)$/i.test(e.name));
      const msgs: string[] = [];
      for (const e of entries) {
        const r = await importGameFile(e.name, e.data);
        if (r.ok) {
          for (const p of r.packs) { p.source.file = e.name; made.push(p); }
          msgs.push(`✓ ${r.packs.map(p => `${pickAny(p.title, lang())} (${p.levels.reduce((a, l) => a + l.puzzles.length, 0)})`).join(', ')}`);
        } else {
          msgs.push(`✕ ${e.name}: ${r.message === 'encrypted' ? t('encrypted') : r.message === 'unsupported' ? t('unsupported') : r.message}`);
        }
      }
      li.textContent = f.name + ': ' + msgs.join(' · ');
    }
    if (made.length) {
      await addPacks(made);
      const ids = new Set(made.map(p => p.id));
      const unique = pm.packs().filter(p => ids.has(p.id));
      results.append(h('li', {}, `${unique.length} pack(s) from ${made.length} file(s)`));
      results.append(h('li', {}, h('button', { class: 'btn primary', onClick: () => exportZip(unique, 'momogram-new-packs.zip') }, t('exportAll'))));
    }
  }

  function exportZip(ps: Pack[], name = 'momogram-packs.zip') {
    download(name, makeZip(ps.map(p => ({ name: packFileName(p), text: JSON.stringify(p) }))), 'application/zip');
  }

  render();
  pm.screen(pm.header(t('packs')), h('div', { class: 'packs' },
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn primary', onClick: createPacks }, '✚ ' + t('createPacks')),
      h('button', { class: 'btn', onClick: importPacks }, '⤒ ' + t('importPacks')),
      h('button', { class: 'btn', onClick: () => exportZip(pm.packs()) }, '⤓ ' + t('exportAll'))),
    h('p', { class: 'fine' }, t('createHelp')),
    status, list));
}
