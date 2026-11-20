const { app, BrowserWindow, Tray, Menu, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Saved under the user's own app-data folder, not next to the source, so entering it in the app
// doesn't require write access to (or rebuilding) the installed program.
const userConfigPath = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(partial) {
  const config = { ...loadConfig(), ...partial };
  fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
  fs.writeFileSync(userConfigPath, JSON.stringify(config, null, 2));
  return config;
}

let { serverUrl = null, token = '', openAtLogin = false } = loadConfig();
if (process.env.CALL_BRIDGE_URL) serverUrl = process.env.CALL_BRIDGE_URL;

const WINDOW_WIDTH = 420;
const WINDOW_HEIGHT = 640;
const ANIMATION_MS = 180;
const ANIMATION_STEPS = 14;

let tray;
let popup;
let animating = false;

// Anchor the popup just above the tray icon it was opened from, growing
// upward by exactly the popup's own height.
function targetBounds() {
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const { workArea } = display;

  let x = Math.round(trayBounds.x + trayBounds.width / 2 - WINDOW_WIDTH / 2);
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - WINDOW_WIDTH));

  // Tray sits at the bottom of the screen on Windows, so the popup opens
  // upward from it; it would open downward instead on a top tray/menu bar.
  const trayIsAboveWorkArea = trayBounds.y < workArea.y + workArea.height / 2;
  const y = trayIsAboveWorkArea
    ? trayBounds.y + trayBounds.height
    : trayBounds.y - WINDOW_HEIGHT;

  return { x, y, width: WINDOW_WIDTH, height: WINDOW_HEIGHT, opensDown: trayIsAboveWorkArea };
}

function expand() {
  if (animating) return;
  animating = true;
  const end = targetBounds();
  const startY = end.opensDown ? end.y - end.height : end.y + end.height;

  popup.setBounds({ x: end.x, y: startY, width: end.width, height: end.height });
  popup.show();
  popup.focus();

  let step = 0;
  const timer = setInterval(() => {
    step += 1;
    const t = step / ANIMATION_STEPS;
    const y = Math.round(startY + (end.y - startY) * t);
    popup.setBounds({ x: end.x, y, width: end.width, height: end.height });
    if (step >= ANIMATION_STEPS) {
      clearInterval(timer);
      animating = false;
    }
  }, ANIMATION_MS / ANIMATION_STEPS);
}

function collapse() {
  popup.hide();
}

function toggle() {
  if (popup.isVisible()) {
    collapse();
  } else {
    expand();
  }
}

function showSetup() {
  popup.loadFile('setup.html');
}

// Matches TOKEN_KEY in server/public/console.js: writing it here lets the console auto-sign-in
// instead of showing its own separate login screen after this panel already took the token.
const CONSOLE_TOKEN_KEY = 'callBridge.operatorToken';

function showConsole() {
  popup.loadURL(serverUrl);
  if (!token) return;
  popup.webContents.once('did-finish-load', () => {
    popup.webContents
      .executeJavaScript(`try { localStorage.setItem(${JSON.stringify(CONSOLE_TOKEN_KEY)}, ${JSON.stringify(token)}); } catch {}`)
      .then(() => popup.webContents.reload())
      .catch(() => {});
  });
}

function goToSetup() {
  showSetup();
  if (!popup.isVisible()) expand();
}

ipcMain.handle('save-config', (event, { serverUrl: value, token: newToken }) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('That does not look like a valid address.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The address must start with http:// or https://.');
  }
  const url = parsed.toString();
  const newT = (newToken || '').trim();
  // Only actually navigate when the server address changed, or nothing is loaded yet (first run):
  // a token-only edit from the in-console settings overlay would otherwise reload the console and
  // drop whatever call it's bridging, just because someone opened settings to look something up.
  const needsReload = url !== serverUrl || !popup.webContents.getURL().startsWith('http');
  serverUrl = url;
  token = newT;
  saveConfig({ serverUrl, token });
  if (needsReload) showConsole();
  return { reloaded: needsReload };
});

// Shows/focuses the window the moment a call rings or is active (see preload.js): a tray popup is
// hidden by default and only a click would normally bring it back, which is no good for a call
// nobody knows is ringing.
ipcMain.on('ring-active', (event, ringing) => {
  if (ringing && !popup.isVisible()) expand();
});

// The window used to hide itself on blur, like a normal tray popup; that's gone (see createPopup)
// because it collapsed calls away the moment focus moved elsewhere, e.g. to click into Teams. The
// collapse button in the console's own corner (see preload.js) is now the only way to fold it away.
ipcMain.on('collapse-popup', () => collapse());

ipcMain.handle('get-config', () => ({ serverUrl, token, openAtLogin }));

ipcMain.handle('set-open-at-login', (event, value) => {
  openAtLogin = !!value;
  saveConfig({ openAtLogin });
  app.setLoginItemSettings({ openAtLogin });
});

function createPopup() {
  popup = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    // Lives only as the tray icon — no separate taskbar button.
    skipTaskbar: true,
    autoHideMenuBar: true,
    // Staying open on an outside click (see below) is no good if clicking that other window then
    // buries the popup behind it: it has to actually stay on top, not just stay open.
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // The console only shows a ring as a desktop Notification if it has permission, which it would
  // normally ask for when the login form is submitted - a step this app's auto-sign-in (showConsole
  // injects the token and reloads) skips entirely. Grant it here instead, and ask for it on every
  // load: without this, Notification.permission stayed 'default' forever and calls rang with nothing
  // on screen to show it.
  // 'media' (microphone/camera) must be granted too, not just notifications: the console needs them
  // to actually talk on a call. Denying every other permission keeps this to only what the console uses.
  popup.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'notifications' || permission === 'media');
  });
  popup.webContents.session.setPermissionCheckHandler((wc, permission) => permission === 'notifications' || permission === 'media');
  popup.webContents.on('did-finish-load', () => {
    popup.webContents
      .executeJavaScript("try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch {}")
      .catch(() => {});
  });

  if (serverUrl) showConsole(); else showSetup();
}

function toggleSettings() {
  // Settings live as an overlay inside the console itself (see preload.js) once it's loaded; before
  // that (first run, no server configured yet) there's no console to overlay, so fall back to the
  // full-page setup screen.
  if (serverUrl && popup.webContents.getURL().startsWith('http')) {
    popup.webContents.send('toggle-settings');
    if (!popup.isVisible()) expand();
  } else {
    goToSetup();
  }
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'icon.png'));
  tray.setToolTip('Call Bridge');
  tray.on('click', toggle);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Settings…', click: toggleSettings },
      { type: 'separator' },
      { label: 'Quit Call Bridge', click: () => app.quit() },
    ])
  );
}

app.whenReady().then(() => {
  app.setLoginItemSettings({ openAtLogin });
  createPopup();
  createTray();
});

// The popup only ever hides, never closes, so this never fires in normal
// use — but keep the app alive instead of quitting if it somehow does.
