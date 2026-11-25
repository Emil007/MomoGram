// MomoGram desktop shell (Windows, Linux incl. Steam Deck, macOS). Serves the web build from app://momogram/.
const { app, BrowserWindow, protocol, net, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.commandLine.appendSwitch('enable-features', 'WebGamepad');

// a game or pack to open: "--rom <file>", or a file the program was started with (double click, drag & drop). The page asks for it at /__rom.
const OPENS = /\.(nds|srl|cci|app|zip|7z|rar|gbc?|sfc|smc|bs|3ds|cia|cxi|hex|apk|xapk|apkm|apks|momopack|json)$/i;
function fileArg(argv) {
  const a = argv.slice(1);
  const i = a.indexOf('--rom');
  if (i >= 0 && a[i + 1]) return path.resolve(a[i + 1]);
  const f = a.find(x => OPENS.test(x) && !x.startsWith('-'));
  return f ? path.resolve(f) : null;
}
let pending = fileArg(process.argv);
// each open gets its own number. A page we are reloading must not be given the next file.
let openGen = 0;
const armed = new Map();
let win = null;

function romOf(url) {
  try { return Number(new URL(url).searchParams.get('rom') || 0); } catch { return 0; }
}
function requestRom(req) {
  const raw = (req.referrer && req.referrer !== 'about:client' ? req.referrer : '') || req.headers.get('referer') || '';
  return romOf(raw);
}
function currentRom() {
  try { return win && !win.isDestroyed() ? romOf(win.webContents.getURL()) : 0; } catch { return 0; }
}

function focus() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

// hand the file to the next document, or keep it until that window exists
function deliver(file) {
  if (file) pending = file;
  if (!win || win.isDestroyed()) {
    if (app.isReady()) createWindow();
    return;
  }
  focus();
  if (!pending) return;
  openGen += 1;
  armed.clear();
  armed.set(openGen, pending);
  pending = null;
  win.loadURL('app://momogram/index.html?rom=' + openGen);
}

function createWindow() {
  if (win && !win.isDestroyed()) return;
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 360, minHeight: 480,
    backgroundColor: '#dfeaf6', autoHideMenuBar: true, title: 'MomoGram',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  // Steam Deck / gamescope: start fullscreen when launched from Gaming Mode
  if (process.env.SteamDeck === '1' || process.env.SteamGamepadUI || process.argv.includes('--fullscreen')) win.setFullScreen(true);
  // links open in the browser, web pages only
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://momogram/')) e.preventDefault(); });
  const w = win;
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { w.setFullScreen(!w.isFullScreen()); e.preventDefault(); }
  });
  win.on('closed', () => { win = null; });
  if (pending) deliver();
  else win.loadURL('app://momogram/index.html');
}

// one MomoGram at a time. quit() does not stop the rest of this file, so the spare process must not open a window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = fileArg(argv);
    if (f) deliver(f);
    else focus();
  });
  // macOS: files opened from Finder, sometimes before the window exists
  app.on('open-file', (e, f) => {
    e.preventDefault();
    deliver(f);
  });

  app.whenReady().then(() => {
    const root = path.join(__dirname, 'web');
    protocol.handle('app', async req => {
      const p = decodeURIComponent(new URL(req.url).pathname);
      if (p === '/__rom') {
        const gen = requestRom(req) || currentRom();
        const f = gen === openGen ? armed.get(gen) : undefined;
        if (!f) return new Response('none', { status: 404 });
        armed.delete(gen);
        const r = await net.fetch(pathToFileURL(f).toString());
        return new Response(r.body, { headers: { 'x-file-name': encodeURIComponent(path.basename(f)) } });
      }
      const file = path.normalize(path.join(root, p));
      if (file !== root && !file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
