// MomoGram desktop shell (Windows, Linux incl. Steam Deck, macOS). Serves the web build from app://momogram/.
const { app, BrowserWindow, protocol, net, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.commandLine.appendSwitch('enable-features', 'WebGamepad');

// a game or pack to open: "--rom <file>", or a file the program was started with (double click, drag & drop). The page asks for it at /__rom.
const OPENS = /\.(nds|zip|7z|rar|gbc?|sfc|smc|bs|3ds|cia|cxi|momopack|json)$/i;
function fileArg(argv) {
  const a = argv.slice(1);
  const i = a.indexOf('--rom');
  if (i >= 0 && a[i + 1]) return path.resolve(a[i + 1]);
  const f = a.find(x => OPENS.test(x) && !x.startsWith('-'));
  return f ? path.resolve(f) : null;
}
let pending = fileArg(process.argv);
let win = null;

// one MomoGram at a time: a file opened while it runs goes to the running window
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  const f = fileArg(argv);
  if (f) { pending = f; win?.loadURL('app://momogram/index.html?rom=1'); }
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
// macOS: files opened from Finder
app.on('open-file', (e, f) => {
  e.preventDefault();
  pending = f;
  if (win) win.loadURL('app://momogram/index.html?rom=1');
});

function createWindow() {
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
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
  win.on('closed', () => { win = null; });
  win.loadURL('app://momogram/index.html' + (pending ? '?rom=1' : ''));
}

app.whenReady().then(() => {
  const root = path.join(__dirname, 'web');
  protocol.handle('app', async req => {
    const p = decodeURIComponent(new URL(req.url).pathname);
    if (p === '/__rom') {
      // handed over once
      const f = pending; pending = null;
      if (!f) return new Response('none', { status: 404 });
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
