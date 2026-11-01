// Just enough of Electron's main-process API for src/main.js, recording what it is asked to do.
// `fake` is the state a test reads and steers; reset() starts a fresh "launch".
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

export const fake = {};

export function reset({ userData, cookies = [], focused = true } = {}) {
  Object.assign(fake, {
    userData,
    focused,
    cookies: [...cookies],
    windows: [],
    trays: [],
    notifications: [],
    opened: [], // shell.openExternal
    handlers: {}, // ipcMain.handle
    appEvents: new EventEmitter(),
    badge: [],
    exited: null,
    userAgent: 'Mozilla/5.0 Chrome/140 Electron/45',
    permissionCheck: null,
    permissionRequest: null,
    onOpenExternal: null,
  });
}
reset();

export const app = {
  setAppUserModelId() {},
  requestSingleInstanceLock: () => true,
  on: (ev, fn) => fake.appEvents.on(ev, fn),
  whenReady: () => Promise.resolve(),
  getVersion: () => '0.1.0',
  getPath: (name) => { if (name !== 'userData') throw new Error(name); return fake.userData; },
  setPath: (name, p) => { if (name === 'userData') fake.userData = p; },
  setBadgeCount: (n) => { fake.badge.push(n); return true; },
  quit: () => { fake.appEvents.emit('before-quit'); fake.exited = 0; },
  exit: (code) => { fake.exited = code; },
};

class WebContents extends EventEmitter {
  constructor() { super(); this.url = ''; this.sent = []; this.loads = []; }
  setWindowOpenHandler(fn) { this.openHandler = fn; }
  send(channel, data) { this.sent.push([channel, data]); }
  getURL() { return this.url; }
  isLoading() { return false; }
  async executeJavaScript() { return null; }
  /** A page-initiated navigation: returns true if main.js let it through. */
  navigate(url, ev = 'will-navigate') {
    let prevented = false;
    // Electron 45's details object (the positional url/isMainFrame args are deprecated).
    const e = { url, isMainFrame: true, preventDefault: () => { prevented = true; } };
    this.emit(ev, e, url, false, true);
    if (!prevented) this.go(url);
    return !prevented;
  }
  go(url) {
    this.url = url;
    this.loads.push(url);
    this.emit('did-navigate', {}, url);
    this.emit('did-finish-load');
  }
}

export class BrowserWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.webContents = new WebContents();
    this.visible = false;
    this.maximized = false;
    this.overlay = [];
    fake.windows.push(this);
  }
  maximize() { this.maximized = true; }
  isMaximized() { return this.maximized; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  restore() {}
  isMinimized() { return false; }
  isVisible() { return this.visible; }
  isFocused() { return fake.focused; }
  isDestroyed() { return false; }
  isFullScreen() { return false; }
  getNormalBounds() { return { x: this.opts.x ?? 10, y: this.opts.y ?? 20, width: this.opts.width, height: this.opts.height }; }
  setOverlayIcon(img, text) { this.overlay.push([img, text]); }
  loadURL(url) { this.webContents.go(url); return Promise.resolve(); }
  loadFile(p) { this.webContents.go(pathToFileURL(p).href); return Promise.resolve(); }
}

export class Tray extends EventEmitter {
  constructor(image) { super(); this.image = image; fake.trays.push(this); }
  setToolTip(t) { this.tooltip = t; }
  setContextMenu(m) { this.menu = m; }
  setImage(i) { this.image = i; }
}

export const Menu = { buildFromTemplate: (t) => t };

export class Notification extends EventEmitter {
  static isSupported() { return true; }
  constructor(opts) { super(); this.opts = opts; this.closed = false; fake.notifications.push(this); }
  show() { this.shown = true; }
  close() { this.closed = true; }
}

export const ipcMain = { handle: (channel, fn) => { fake.handlers[channel] = fn; } };

export const nativeImage = { createFromPath: (p) => ({ path: p }) };

export const screen = { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] };

const cookieMatches = (c, url, name) => c.name === name && new URL(url).hostname.endsWith(c.domain.replace(/^\./, ''));

export const session = {
  defaultSession: {
    getUserAgent: () => fake.userAgent,
    setUserAgent: (ua) => { fake.userAgent = ua; },
    setPermissionCheckHandler: (fn) => { fake.permissionCheck = fn; },
    setPermissionRequestHandler: (fn) => { fake.permissionRequest = fn; },
    cookies: {
      get: async ({ url, name }) => fake.cookies.filter((c) => cookieMatches(c, url, name)),
      set: async (c) => { fake.cookies = fake.cookies.filter((o) => o.name !== c.name); fake.cookies.push(c); },
      remove: async (url, name) => { fake.cookies = fake.cookies.filter((c) => !cookieMatches(c, url, name)); },
      flushStore: async () => {},
    },
  },
};

export const shell = {
  openExternal: async (url) => { fake.opened.push(url); if (fake.onOpenExternal) fake.onOpenExternal(url); },
};

export const systemPreferences = { askForMediaAccess: async () => true };

export default { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, screen, session, shell, systemPreferences };
