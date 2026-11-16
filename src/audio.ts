// Audio facade: music from the user's Picross DS sound archive, plus MomoGram's own small UI sounds.
import { Sdat } from './audio/sdat';
import { SeqPlayer } from './audio/player';
import { settings } from './store';

let ac: AudioContext | null = null;
let master: GainNode | null = null;
let sfxGain: GainNode | null = null;
let player: SeqPlayer | null = null;
let getSdat: () => Uint8Array | null = () => null;
let sdatFor: Uint8Array | null = null;
let current = '';
let pending: { name: string; loop: boolean } | null = null;

function ensure(): boolean {
  if (!ac) {
    try { ac = new AudioContext(); } catch { return false; }
    master = ac.createGain();
    master.gain.value = settings.musicVolume;
    master.connect(ac.destination);
    const an = ac.createAnalyser();
    master.connect(an);
    (window as any).__audioLevel = () => { const b = new Float32Array(an.fftSize); an.getFloatTimeDomainData(b); return Math.sqrt(b.reduce((a, v) => a + v * v, 0) / b.length); };
    sfxGain = ac.createGain();
    sfxGain.gain.value = 0.25;
    sfxGain.connect(ac.destination);
  }
  const d = getSdat();
  if (d && d !== sdatFor) {
    try { player = new SeqPlayer(ac, master!, new Sdat(d)); sdatFor = d; } catch (e) { console.warn('sound archive', e); player = null; }
  }
  return true;
}

// browsers only allow audio after a user gesture
const unlock = () => {
  if (!ensure()) return;
  ac!.resume();
  if (pending) { const p = pending; pending = null; Audio.play(p.name, p.loop); }
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

export const Audio = {
  init(fn: () => Uint8Array | null) { getSdat = fn; },
  play(name: string, loop = true) {
    if (!settings.music) { this.stop(); return; }
    if (name === current && player?.playing) return;
    if (!ac || ac.state !== 'running') { pending = { name, loop }; return; }
    ensure();
    current = name;
    player?.play(name, loop);
  },
  stop() { current = ''; player?.stop(0.1); },
  setVolume(v: number) { if (master) master.gain.value = v; },
  sfx(kind: 'tap' | 'mistake' | 'clear') {
    if (!settings.sfx || !ac || ac.state !== 'running' || !sfxGain) return;
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
    o.type = kind === 'mistake' ? 'sawtooth' : 'triangle';
    o.frequency.setValueAtTime(kind === 'mistake' ? 140 : kind === 'clear' ? 880 : 1320, t);
    if (kind === 'mistake') o.frequency.linearRampToValueAtTime(90, t + 0.25);
    g.gain.setValueAtTime(kind === 'tap' ? 0.25 : 0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'tap' ? 0.05 : 0.3));
    o.connect(g).connect(sfxGain);
    o.start(t);
    o.stop(t + 0.35);
  },
};
