import './style.css';
import { boot } from './app';
import { Gamepads } from './input';
declare const __VERSION__: string;
// replaced with package.json's version when building
(window as any).MOMOGRAM_VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';
Gamepads.start();
boot();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
