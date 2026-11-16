import './style.css';
import { boot } from './app';
import { Gamepads } from './input';
(window as any).MOMOGRAM_VERSION = (globalThis as any).__VERSION__ ?? 'dev';
Gamepads.start();
boot();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
