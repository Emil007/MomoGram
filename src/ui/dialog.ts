// In-game windows instead of the browser's alert / confirm / prompt (which look foreign, block the page and
// can't be used with a gamepad).
import { Gamepads } from '../input';
import { t } from '../i18n';

const el = (tag: string, attrs: Record<string, string> = {}, ...kids: Array<Node | string>) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};

/** a window with any content; `close` removes it */
export function panel(build: (box: HTMLElement, close: () => void) => void | (() => void)): void { open(build); }

/** `build` may return what "back" (Esc, Android back) does; otherwise it just closes */
function open(build: (box: HTMLElement, close: () => void) => void | (() => void)): void {
  const m = el('div', { class: 'modal' });
  const box = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' });
  const close = () => { m.remove(); Gamepads.popModal(); };
  (m as any).dismiss = build(box, close) || close;
  m.append(box);
  document.body.append(m);
  Gamepads.pushModal(box);
}

const button = (label: string, cls: string, fn: () => void) => { const b = el('button', { class: cls }, label); b.addEventListener('click', fn); return b; };

/** a title and a choice of buttons; resolves after the chosen one ran */
export function choose(title: string, options: Array<[string, () => void | Promise<unknown>]>, text?: string): Promise<void> {
  return new Promise(res => open((box, close) => {
    box.append(el('h3', {}, title));
    if (text) box.append(el('p', { class: 'dialog-text' }, text));
    // a choice that opens another window (a name to type, …) is waited for
    for (const [label, fn] of options) box.append(button(label, 'btn', async () => { close(); try { await fn(); } finally { res(); } }));
    return () => { close(); res(); };
  }));
}

/** a message with an OK button */
export function message(text: string, title = ''): Promise<void> {
  return new Promise(res => open((box, close) => {
    if (title) box.append(el('h3', {}, title));
    box.append(el('p', { class: 'dialog-text' }, text));
    box.append(button(t('ok'), 'btn primary', () => { close(); res(); }));
    return () => { close(); res(); };
  }));
}

/** yes / cancel; `danger` colours the yes button */
export function confirmBox(question: string, yes = t('confirmYes'), danger = false): Promise<boolean> {
  return new Promise(res => open((box, close) => {
    box.append(el('h3', {}, question));
    box.append(button(yes, danger ? 'btn danger' : 'btn primary', () => { close(); res(true); }));
    box.append(button(t('back'), 'btn ghost', () => { close(); res(false); }));
    return () => { close(); res(false); };
  }));
}

/** a line of text; null when cancelled */
export function askText(title: string, value = ''): Promise<string | null> {
  return new Promise(res => open((box, close) => {
    const input = el('input', { type: 'text', class: 'dialog-input', maxlength: '60' }) as HTMLInputElement;
    input.value = value;
    const ok = () => { const v = input.value.trim(); close(); res(v || null); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    box.append(el('h3', {}, title), input,
      button(t('ok'), 'btn primary', ok),
      button(t('back'), 'btn ghost', () => { close(); res(null); }));
    setTimeout(() => { input.focus(); input.select(); }, 30);
    return () => { close(); res(null); };
  }));
}
