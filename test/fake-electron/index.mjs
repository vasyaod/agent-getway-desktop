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
    // What a loadURL() of a URL gets from the "server", for the real-load path (WebContents.load):
    //   redirects[url] = location   a 3xx to `location`;   hang = Set of URLs that never answer.
    // URLs in neither commit at once, as before.
    redirects: {},
    hang: new Set(),
    status: {}, // status[url] = the HTTP status a committed load of url reports (did-navigate); 200
    refuseNextLoad: false, // the next loadURL fails with ERR_FAILED and starts no navigation
    // net.request(): {redirect: [status, location]}, {response: {status, headers, body}} or {error};
    // or a function returning one, called once per request.
    netAnswer: { redirect: [302, 'https://auth.f-proj.com/login?rd=x'] },
    pageJs: { 'document.title': 'Getway Chat', 'typeof window.getway': 'object' }, // executeJavaScript
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
  isLoading() { return !!this.pending; }
  async executeJavaScript(code) { return fake.pageJs[code] ?? null; }
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
    this.emit('did-navigate', {}, url, fake.status[url] ?? 200, '');
    this.emit('did-finish-load');
  }

  /**
   * loadURL/loadFile. A URL with a scripted redirect or hang goes through the event sequence of
   * Electron 45's own code (shell/browser/electron_navigation_throttle.cc, api/load_url_promises.cc
   * and DidFinishNavigation in api/electron_api_web_contents.cc), one task per network step:
   * did-start-navigation, then will-redirect with the details object. preventDefault() cancels
   * the navigation as the throttle's CANCEL does: no commit, no did-fail-load (an uncommitted
   * ERR_ABORTED emits none), did-stop-loading, and the load's promise rejects with ERR_FAILED.
   * Not prevented: did-redirect-navigation, then it commits the redirect target. A newer load
   * replaces a pending one, whose promise rejects with ERR_ABORTED. Chromium's own timing (when
   * the cancelled request is really torn down) and the network are not modelled.
   */
  load(url) {
    if (fake.refuseNextLoad) {
      fake.refuseNextLoad = false;
      this.emit('did-fail-load', {}, -2, 'ERR_FAILED', url, true);
      return Promise.reject(Object.assign(new Error('ERR_FAILED (-2)'), { errno: -2, code: 'ERR_FAILED' }));
    }
    const location = fake.redirects[url];
    if (location === undefined && !fake.hang.has(url)) {
      this.replacePending();
      this.go(url);
      return Promise.resolve();
    }
    this.replacePending();
    return new Promise((resolve, reject) => {
      const nav = { reject };
      this.pending = nav;
      const live = () => this.pending === nav;
      this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false });
      if (fake.hang.has(url)) return;
      setImmediate(() => {
        if (!live()) return;
        let prevented = false;
        const e = { url: location, isMainFrame: true, isSameDocument: false, preventDefault: () => { prevented = true; } };
        this.emit('will-redirect', e, location, false, true);
        if (prevented) {
          this.pending = null;
          this.emit('did-stop-loading');
          reject(Object.assign(new Error('ERR_FAILED (-2)'), { errno: -2, code: 'ERR_FAILED' }));
          return;
        }
        this.emit('did-redirect-navigation', { url: location, isMainFrame: true, isSameDocument: false });
        setImmediate(() => {
          if (!live()) return;
          this.pending = null;
          this.go(location);
          this.emit('did-stop-loading');
          resolve();
        });
      });
    });
  }

  replacePending() {
    if (!this.pending) return;
    const { reject } = this.pending;
    this.pending = null;
    reject(Object.assign(new Error('ERR_ABORTED (-3)'), { errno: -3, code: 'ERR_ABORTED' }));
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
  loadURL(url) { return this.webContents.load(url); }
  loadFile(p) { return this.webContents.load(pathToFileURL(p).href); }
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

/** net.request: answers with fake.netAnswer (see reset()). */
export const net = {
  request(opts) {
    const req = new EventEmitter();
    fake.netRequests = [...(fake.netRequests || []), opts];
    req.setHeader = () => {};
    req.abort = () => {};
    req.end = () => setImmediate(() => {
      const a = typeof fake.netAnswer === 'function' ? fake.netAnswer() : fake.netAnswer;
      if (a.error) req.emit('error', new Error(a.error));
      else if (a.redirect) req.emit('redirect', a.redirect[0], 'GET', a.redirect[1], {});
      else if (a.response) {
        const res = new EventEmitter();
        Object.assign(res, { statusCode: a.response.status, headers: a.response.headers || {} });
        req.emit('response', res);
        setImmediate(() => { if (a.response.body) res.emit('data', Buffer.from(a.response.body)); res.emit('end'); });
      }
    });
    return req;
  },
};

export default { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, net, screen, session, shell, systemPreferences };
