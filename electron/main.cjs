// MomoGram desktop shell (Windows, Linux incl. Steam Deck, macOS). Serves the web build from app://momogram/.
const { app, BrowserWindow, protocol, net, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.commandLine.appendSwitch('enable-features', 'WebGamepad');

// "--rom <file>" (or a .nds / .zip dropped on the program): import that game at start, e.g. from RecompLauncher
function romArg() {
  const a = process.argv.slice(1);
  const i = a.indexOf('--rom');
  if (i >= 0 && a[i + 1]) return path.resolve(a[i + 1]);
  const f = a.find(x => /\.(nds|zip)$/i.test(x));
  return f ? path.resolve(f) : null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 360, minHeight: 480,
    backgroundColor: '#dfeaf6', autoHideMenuBar: true, title: 'MomoGram',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  // Steam Deck / gamescope: start fullscreen when launched from Gaming Mode
  if (process.env.SteamDeck === '1' || process.env.SteamGamepadUI || process.argv.includes('--fullscreen')) win.setFullScreen(true);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
  win.loadURL('app://momogram/index.html' + (romArg() ? '?rom=1' : ''));
}

app.whenReady().then(() => {
  const root = path.join(__dirname, 'web');
  protocol.handle('app', req => {
    const p = decodeURIComponent(new URL(req.url).pathname);
    if (p === '/__rom') { const f = romArg(); return f ? net.fetch(pathToFileURL(f).toString()) : new Response('none', { status: 404 }); }
    const file = path.normalize(path.join(root, p));
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
