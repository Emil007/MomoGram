import './style.css';
import { boot } from './app';
import { Gamepads } from './input';
declare const __VERSION__: string;
// replaced with package.json's version when building
(window as any).MOMOGRAM_VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';
Gamepads.start();
boot();
// the back button: Android's (in the app) or the browser's / phone's (in the browser and when installed on the home
// screen) goes back inside MomoGram (closes a window, opens the menu while playing, goes back a screen); only on
// the home screen does it leave
const cap = (window as any).Capacitor;
if (cap?.isNativePlatform?.()) {
  const App = cap.Plugins?.App ?? cap.registerPlugin?.('App');
  App?.addListener?.('backButton', () => { if (!Gamepads.back()) (App.minimizeApp ?? App.exitApp)?.call(App); });
} else {
  history.pushState({ momogram: 1 }, '');
  window.addEventListener('popstate', () => { if (Gamepads.back()) history.pushState({ momogram: 1 }, ''); else history.back(); });
}
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
