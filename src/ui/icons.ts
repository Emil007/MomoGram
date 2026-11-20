// MomoGram's own line icons (24×24, drawn with currentColor) so every button has the same size and weight.
const P: Record<string, string> = {
  fill: '<rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6" stroke="currentColor" stroke-width="2.6" fill="none"/><path d="M15 15l5 5" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  undo: '<path d="M9 7L4.5 11.5 9 16" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 11.5h9a5 5 0 010 10h-3" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round"/>',
  hint: '<path d="M12 3a6 6 0 00-3.5 10.9V16h7v-2.1A6 6 0 0012 3z" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linejoin="round"/><path d="M9.5 19.5h5M10.5 22h3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  trial: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 001.8 3h10.4a2 2 0 001.8-3l-5-9V3" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linejoin="round"/><path d="M7.5 15h9" stroke="currentColor" stroke-width="2.2"/>',
  mark: '<rect x="4.5" y="4.5" width="15" height="15" rx="3" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2.4" fill="none"/><rect x="8.5" y="8.5" width="7" height="7" rx="1.6" fill="currentColor"/>',
  swap: '<path d="M4.6 10.2A7.8 7.8 0 0117.6 6.4" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M18.4 2.9v4.2h-4.2" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M19.4 13.8A7.8 7.8 0 016.4 17.6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M5.6 21.1v-4.2h4.2" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  play: '<path d="M8 5l11 7-11 7z" fill="currentColor"/>',
  prev: '<path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  next: '<path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.5" stroke="currentColor" stroke-width="2.2" fill="none"/><circle cx="9" cy="9" r="1.6" fill="currentColor"/><circle cx="15" cy="15" r="1.6" fill="currentColor"/><circle cx="15" cy="9" r="1.6" fill="currentColor"/><circle cx="9" cy="15" r="1.6" fill="currentColor"/>',
};
export function icon(name: keyof typeof P | string): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="svg-ico" viewBox="0 0 24 24" aria-hidden="true">${P[name] ?? ''}</svg>`;
  return t.content.firstChild as SVGSVGElement;
}
