// Getway Chat for the desktop: agent-getway's web chat in its own window, signed in through
// auth.f-proj.com, with reply notifications and an unread badge.
//
// No chat code here. The window loads https://agent-getway.f-proj.com/ itself, so the app always
// runs the chat the gateway is deployed with, and the UA marker (config.js) puts that page in
// its chat-only mode, as in the Android app (vasyaod/agent-getway-phone).
//
// The sign-in is the app token from auth.f-proj.com's OAuth flow for apps (oauth.js). It lives in
// ONE place: this session's cookie jar, as the HttpOnly `fproj_auth` cookie for .f-proj.com, which
// Chromium persists (encrypted with the OS keychain where there is one) across restarts. The
// gateway's SSO reads that cookie like any browser session; the reply watcher reads it back here
// and sends it as `Authorization: Bearer`. No page can read it and it is never logged.
import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, screen, session, shell, systemPreferences } from 'electron';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_URL, COOKIE, COOKIE_DOMAIN, GATEWAY, POLL_MS, UA_MARKER } from './config.js';
import { classify, openChatId } from './navigation.js';
import { liveRecord, redeem, revoke, startSignIn } from './oauth.js';
import { getJson, poll } from './poller.js';
import { readJson, writeJson } from './store.js';
import { Unread, trayTooltip } from './unread.js';
import { MIN, restore, snapshot } from './windowstate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const START = path.join(here, 'start', 'index.html');
const asset = (name) => path.join(here, 'assets', name);

// GETWAY_CHAT_SMOKE=<file>: CI's launch check (smoke() below). It runs on a throwaway profile,
// so it can never touch a real sign-in.
const SMOKE = process.env.GETWAY_CHAT_SMOKE || '';
if (SMOKE) app.setPath('userData', path.join(tmpdir(), `getway-chat-smoke-${process.pid}`));

const dataFile = (name) => path.join(app.getPath('userData'), name);

let win = null;
let tray = null;
let quitting = false;
let current = null; // {token, expiresAt} while signed in; a copy of the cookie
let pending = null; // the sign-in in the browser, if any
let pollTimer = null;
let polling = false;
let lastGuard = null; // the last auth.f-proj.com navigation the guard turned back (smoke)
let status = { phase: 'idle', message: null, error: false };
const notes = new Map(); // chat id -> its Notification: one per chat, kept from GC
let replies = { primed: false, chats: {} };

const unread = new Unread(showBadge);

app.setAppUserModelId('com.fproj.getway.desktop'); // Windows: notifications need it

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow); // launching it again brings the window back
  app.on('activate', showWindow); // macOS: the dock icon
  app.on('before-quit', () => { quitting = true; if (pending) pending.cancel(); });
  app.on('will-quit', stopPolling);
  app.on('window-all-closed', () => {}); // the window only hides; Quit is in the tray menu
  app.whenReady().then(start);
}

async function start() {
  const ses = session.defaultSession;
  ses.setUserAgent(`${ses.getUserAgent()} ${UA_MARKER}`);
  guardPermissions(ses);
  ipc();
  createWindow();
  createTray();
  replies = readJson(dataFile('replies.json'), replies);

  current = await cookieRecord();
  if (current && !SMOKE) {
    openChat(null);
    startPolling();
  } else {
    showStart({});
  }
  if (SMOKE) smoke(SMOKE);
}

// ---- window -------------------------------------------------------------------------------

function createWindow() {
  const bounds = restore(readJson(dataFile('window.json'), {}), screen.getAllDisplays());
  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN.width,
    minHeight: MIN.height,
    show: false,
    title: 'Getway Chat',
    icon: asset('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload-start.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The chat keeps its live feed while the window is hidden in the tray.
      backgroundThrottling: false,
    },
  });
  if (bounds.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  let saveTimer = null;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    writeJson(dataFile('window.json'), snapshot(win.getNormalBounds(), win.isMaximized()));
  };
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveBounds, 500); };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, saveSoon);

  win.on('close', (e) => {
    saveBounds();
    if (quitting) return;
    e.preventDefault(); // closing hides it; the tray icon, the dock or launching again shows it
    win.hide();
  });
  win.on('focus', () => readOnScreen());

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    // New windows never open in the app: other sites, and the gateway's own target=_blank links,
    // go to the system browser.
    const kind = classify(url);
    if (kind === 'external' || kind === 'gateway') shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e) => guard(e, e.url));
  wc.on('will-redirect', (e) => { if (e.isMainFrame) guard(e, e.url); });
  wc.on('did-navigate', () => readOnScreen());
  wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => { if (isMainFrame) readOnScreen(); });
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    // -3 ERR_ABORTED is our own guard cancelling a load.
    if (isMainFrame && code !== -3 && classify(url) === 'gateway') {
      stopPolling();
      showStart({ phase: 'offline', message: 'Getway Chat cannot reach agent-getway.f-proj.com right now.' });
    }
  });
}

/** What happens to a navigation or redirect the page starts (navigation.js). */
function guard(e, url) {
  const kind = classify(url);
  if (kind === 'gateway') return;
  e.preventDefault();
  if (kind === 'external') shell.openExternal(url);
  else if (kind === 'signed_out' || kind === 'expired') {
    lastGuard = kind;
    endSession(kind);
  }
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openChat(chatId) {
  win.loadURL(chatId ? `${CHAT_URL}/${chatId}` : CHAT_URL).catch(() => {}); // did-fail-load handles it
}

function showStart(next) {
  setStatus({ phase: 'idle', message: null, error: false, ...next });
  win.loadFile(START).catch(() => {});
}

/** The chat on screen in a focused window, or null. */
function visibleChatId() {
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused()) return null;
  return openChatId(win.webContents.getURL());
}

function readOnScreen() {
  const id = visibleChatId();
  if (!id) return;
  unread.read(id);
  notes.get(id)?.close();
  notes.delete(id);
}

// ---- tray, badge, notifications -------------------------------------------------------------

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(asset('tray.png')));
  } catch {
    tray = null; // a Linux desktop with no tray: launching the app again shows the window
    return;
  }
  tray.setToolTip(trayTooltip(0));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Getway Chat', click: showWindow },
    { type: 'separator' },
    { label: 'Quit Getway Chat', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
}

function showBadge(n) {
  if (tray) {
    tray.setImage(nativeImage.createFromPath(asset(n > 0 ? 'tray-unread.png' : 'tray.png')));
    tray.setToolTip(trayTooltip(n));
  }
  app.setBadgeCount(n); // the macOS dock; Linux launchers that support it
  if (process.platform === 'win32' && win && !win.isDestroyed()) {
    win.setOverlayIcon(n > 0 ? nativeImage.createFromPath(asset('overlay-unread.png')) : null,
      n > 0 ? trayTooltip(n) : '');
  }
}

function notify({ chatId, title, body }) {
  unread.add(chatId);
  if (!Notification.isSupported()) return;
  notes.get(chatId)?.close(); // a newer reply replaces the older one
  // With the window in front the chat page plays its own chime, so this one is silent.
  const note = new Notification({ title, body, silent: !!win?.isFocused(), icon: asset('icon.png') });
  note.on('click', () => {
    showWindow();
    openChat(chatId);
    unread.read(chatId);
    notes.delete(chatId);
  });
  notes.set(chatId, note);
  note.show();
}

// ---- sign-in ----------------------------------------------------------------------------------

async function cookieRecord() {
  const [c] = await session.defaultSession.cookies.get({ url: GATEWAY, name: COOKIE });
  return c ? liveRecord({ token: c.value, expiresAt: (c.expirationDate || 0) * 1000 }) : null;
}

async function setCookie(rec) {
  const cookies = session.defaultSession.cookies;
  await cookies.set({
    url: GATEWAY, name: COOKIE, value: rec.token, domain: COOKIE_DOMAIN, path: '/',
    secure: true, httpOnly: true, sameSite: 'lax', expirationDate: Math.floor(rec.expiresAt / 1000),
  });
  await cookies.flushStore();
}

async function clearCookie() {
  const cookies = session.defaultSession.cookies;
  await cookies.remove(GATEWAY, COOKIE).catch(() => {});
  await cookies.flushStore().catch(() => {});
}

function setStatus(next) {
  status = { ...status, ...next, version: app.getVersion() };
  if (win && !win.isDestroyed()) win.webContents.send('getway:status', status);
}

async function signIn() {
  if (pending) pending.cancel();
  const attempt = startSignIn((url) => shell.openExternal(url));
  pending = attempt;
  setStatus({ phase: 'waiting', message: null, error: false });
  try {
    const answer = await attempt.done;
    showWindow();
    setStatus({ phase: 'finishing' });
    const rec = await redeem(answer);
    await setCookie(rec);
    current = rec;
    resetReplies();
    setStatus({ phase: 'idle', message: null, error: false });
    openChat(null);
    startPolling();
  } catch (e) {
    // A newer Sign in cancelled this one: its status is the newer one's.
    if (pending === attempt) setStatus({ phase: 'idle', message: e.message, error: true });
  } finally {
    if (pending === attempt) pending = null;
  }
}

/** The gateway sent us to auth.f-proj.com, or the watcher got a 401: back to Sign in. */
async function endSession(kind) {
  const token = current?.token;
  current = null;
  stopPolling();
  await clearCookie();
  if (kind === 'signed_out') await revoke(token); // only this app's token
  resetReplies();
  unread.clear();
  for (const note of notes.values()) note.close();
  notes.clear();
  showStart({
    phase: 'idle', error: false,
    message: kind === 'signed_out' ? 'You signed out.' : 'Your sign-in ended. Sign in again.',
  });
}

function resetReplies() {
  replies = { primed: false, chats: {} };
  writeJson(dataFile('replies.json'), replies);
}

// ---- reply watcher ----------------------------------------------------------------------------

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollOnce, POLL_MS);
  pollOnce();
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const result = await poll({
      token: () => liveRecord(current)?.token ?? null,
      get: (p, token) => getJson(GATEWAY, p, token),
      state: replies,
      save: () => writeJson(dataFile('replies.json'), replies),
      visibleChatId,
      notify,
    });
    if (result === 'signed_out' && pollTimer) await endSession('expired');
    if (result === 'forbidden') stopPolling(); // no grant for agent-getway: the page says so
  } finally {
    polling = false;
  }
}

// ---- IPC (the start page only) and permissions --------------------------------------------------

function fromStartPage(e) {
  try {
    const u = new URL(e.senderFrame.url);
    return u.protocol === 'file:' && path.normalize(fileURLToPath(u)) === path.normalize(START);
  } catch {
    return false;
  }
}

function ipc() {
  const on = (channel, fn) => ipcMain.handle(channel, (e) => (fromStartPage(e) ? fn() : null));
  on('getway:status', () => ({ ...status, version: app.getVersion() }));
  on('getway:sign-in', () => { signIn(); });
  on('getway:cancel', () => { pending?.cancel(); });
  on('getway:retry', async () => {
    current = await cookieRecord();
    if (current) {
      setStatus({ phase: 'idle', message: null, error: false });
      openChat(null);
      startPolling();
    } else {
      showStart({});
    }
  });
}

// The gateway may use the microphone (voice messages), the clipboard (copy buttons) and full
// screen. Nothing else, and no other origin. Web notifications are refused: the reply watcher is
// the one notifier, so a reply is never shown twice.
const ALLOWED = new Set(['media', 'clipboard-sanitized-write', 'fullscreen']);

function guardPermissions(ses) {
  ses.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED.has(permission) && classify(origin) === 'gateway');
  ses.setPermissionRequestHandler(async (_wc, permission, callback, details) => {
    if (!ALLOWED.has(permission) || classify(details.requestingUrl) !== 'gateway') return callback(false);
    if (permission === 'media') {
      const types = details.mediaTypes || [];
      if (types.length === 0 || types.some((t) => t !== 'audio')) return callback(false); // the mic only
      if (process.platform === 'darwin') {
        return callback(await systemPreferences.askForMediaAccess('microphone').catch(() => false));
      }
    }
    return callback(true);
  });
}

// ---- smoke (CI) -------------------------------------------------------------------------------

/**
 * CI's launch check on every OS: the packaged app starts, its window shows the start page with
 * the bridge, the tray icon exists, and the gateway, opened signed out, is turned back to the
 * start page by the sign-in guard (a real round trip to agent-getway.f-proj.com, whose SSO
 * redirects to auth.f-proj.com/login). Writes the result as JSON and exits 0 only if all held.
 */
function smoke(file) {
  const wc = win.webContents;
  const result = { ok: false, step: 'start page', version: app.getVersion(), platform: process.platform,
    arch: process.arch, electron: process.versions.electron };
  const finish = (code) => { writeJson(file, result); app.exit(code); };
  const timer = setTimeout(() => finish(1), 60_000);
  const startLoaded = () => new Promise((resolve) => {
    const check = () => {
      if (wc.getURL().startsWith('file:')) { wc.off('did-finish-load', check); resolve(); }
    };
    wc.on('did-finish-load', check);
  });

  (async () => {
    await (wc.isLoading() || !wc.getURL().startsWith('file:') ? startLoaded() : null);
    result.title = await wc.executeJavaScript('document.title');
    result.bridge = await wc.executeJavaScript('typeof window.getway');
    result.tray = !!tray;
    result.ua_marker = session.defaultSession.getUserAgent().includes(UA_MARKER);
    result.step = 'gateway guard';
    const back = startLoaded();
    win.loadURL(GATEWAY).catch(() => {});
    await back;
    result.guard = lastGuard;
    result.ok = result.title === 'Getway Chat' && result.bridge === 'object'
      && result.ua_marker && result.guard === 'expired';
    result.step = 'done';
    clearTimeout(timer);
    finish(result.ok ? 0 : 1);
  })().catch((e) => { result.error = String(e && e.message); clearTimeout(timer); finish(1); });
}
