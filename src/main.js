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
import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, net, screen, session, shell, systemPreferences } from 'electron';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_URL, COOKIE, COOKIE_DOMAIN, GATEWAY, POLL_MS, UA_MARKER } from './config.js';
import { classify, isGatewayDownload, openChatId } from './navigation.js';
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
const SMOKE_MS = Number(process.env.GETWAY_CHAT_SMOKE_MS) || 60_000; // tests shorten it
// While the gateway answers 5xx or cannot be reached, the smoke tries it again for this long:
// agent-getway runs one pod with a Recreate rollout, so each deploy is minutes of 503 (8.5 min
// seen). The retries wait BACKOFF, 2x, 4x… capped at 6x between attempts. Tests shorten both.
const SMOKE_RETRY_MS = Number(process.env.GETWAY_CHAT_SMOKE_RETRY_MS) || 12 * 60_000;
const SMOKE_BACKOFF_MS = Number(process.env.GETWAY_CHAT_SMOKE_BACKOFF_MS) || 5_000;
// GETWAY_CHAT_SMOKE_MEDIA=<dir> (ci/media): the smoke also shows an image and plays an MP4 and a
// WebM in the window, the kinds the chat shows inline (smokeMedia()).
const SMOKE_MEDIA = process.env.GETWAY_CHAT_SMOKE_MEDIA || '';
if (SMOKE) app.setPath('userData', path.join(tmpdir(), `getway-chat-smoke-${process.pid}`));

// Smoke only: what the window and the guard did since the gateway load started, so a red run
// names the step that never came (smoke()). URLs without their query; nothing else is recorded.
const trace = [];
let traceFrom = 0;
function mark(what, url) {
  if (!traceFrom || trace.length >= 60) return;
  trace.push(`${Date.now() - traceFrom}ms ${what}${url === undefined ? '' : ` ${shortUrl(url)}`}`);
}
function shortUrl(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'file:' ? `file:…/${path.basename(u.pathname)}` : `${u.origin}${u.pathname}`;
  } catch {
    return String(raw).slice(0, 60);
  }
}

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
const savedNotes = new Set(); // "Downloaded" notifications, kept from GC until clicked or closed
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
  saveDownloads(ses);
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
    // go to the system browser. A file the agent sent is downloaded here, signed in.
    const kind = classify(url);
    if (kind === 'download') wc.downloadURL(url);
    else if (kind === 'external' || kind === 'gateway') shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e) => { mark('will-navigate', e.url); guard(e, e.url); });
  wc.on('will-redirect', (e) => { if (e.isMainFrame) { mark('will-redirect', e.url); guard(e, e.url); } });
  wc.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) mark('did-start-navigation', e.url); });
  wc.on('did-redirect-navigation', (e) => { if (e.isMainFrame) mark('did-redirect-navigation', e.url); });
  wc.on('did-finish-load', () => mark('did-finish-load', wc.getURL()));
  wc.on('did-stop-loading', () => mark('did-stop-loading'));
  wc.on('render-process-gone', (_e, d) => mark(`render-process-gone ${d?.reason}`));
  wc.on('did-navigate', () => readOnScreen());
  wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => { if (isMainFrame) readOnScreen(); });
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame) mark(`did-fail-load ${code}`, url);
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
  else if (kind === 'download') win.webContents.downloadURL(url); // the chat stays on screen
  else if (kind === 'signed_out' || kind === 'expired') {
    lastGuard = kind;
    mark(`guard ${kind}`);
    // Not on this stack: Chromium is still inside the navigation we just cancelled, and a load
    // started from here can be refused or swallowed with it. The next task starts clean.
    setImmediate(() => endSession(kind));
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
  loadStart(true);
}

/**
 * The start page, whatever the window was doing. A load another navigation replaced
 * (ERR_ABORTED) is left alone: that one is newer. Any other failure, e.g. Electron refusing to
 * start a load while a cancelled one is still unwinding (ERR_FAILED), is retried once, a moment
 * later, so a session that ended never leaves the window stuck on the gateway.
 */
function loadStart(retry) {
  mark('loadFile start');
  win.loadFile(START).then(() => mark('loadFile ok'), (err) => {
    mark(`loadFile failed ${err?.errno ?? ''} ${err?.code ?? ''}`.trim());
    if (retry && err?.code !== 'ERR_ABORTED' && win && !win.isDestroyed()) setTimeout(() => loadStart(false), 250);
  });
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

/** The tray icon: a white glyph on Windows and Linux; on macOS a template image (black plus
 * alpha) that the menu bar tints for light and dark mode. */
function trayImage(unread) {
  const mac = process.platform === 'darwin';
  const img = nativeImage.createFromPath(asset(`${unread ? 'tray-unread' : 'tray'}${mac ? 'Template' : ''}.png`));
  if (mac) img.setTemplateImage(true);
  return img;
}

function createTray() {
  try {
    tray = new Tray(trayImage(false));
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
    tray.setImage(trayImage(n > 0));
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

/** `promise`, but given up on after `ms`: what ends a session must never hang the window. */
const atMost = (promise, ms) => Promise.race([promise, new Promise((r) => { setTimeout(r, ms).unref?.(); })]);

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
  mark(`endSession ${kind}`);
  const token = current?.token;
  current = null;
  stopPolling();
  try {
    await atMost(clearCookie(), 5_000);
    mark('cookie cleared');
    if (kind === 'signed_out') await revoke(token); // only this app's token; 10 s at most
    resetReplies();
    unread.clear();
    for (const note of notes.values()) note.close();
    notes.clear();
  } finally {
    // Whatever failed above, the window goes back to Sign in.
    showStart({
      phase: 'idle', error: false,
      message: kind === 'signed_out' ? 'You signed out.' : 'Your sign-in ended. Sign in again.',
    });
  }
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

// ---- downloads ---------------------------------------------------------------------------------

/**
 * Files the agent sent (agent-getway#223): the chat's download card (`<a href download>`, same
 * origin), or a gateway file URL the guard or the new-window handler turned into a download. This
 * session fetches it, so with the app's own sign-in. A Save dialog, opening in Downloads, asks
 * where it goes; when it is saved a notification says so, and clicking it shows the file in its
 * folder. A download from anywhere but the gateway is cancelled.
 */
function saveDownloads(ses) {
  ses.on('will-download', (_e, item) => {
    if (!isGatewayDownload(item.getURL())) { item.cancel(); return; }
    const name = item.getFilename();
    item.setSaveDialogOptions({ title: `Save ${name}`, defaultPath: path.join(app.getPath('downloads'), name) });
    item.once('done', (_ev, state) => {
      if (state === 'cancelled') return; // the user closed the Save dialog
      const file = item.getSavePath();
      if (state === 'completed') {
        app.dock?.downloadFinished?.(file); // macOS: bounces the Downloads stack
        savedNote('Downloaded', `${path.basename(file)} is saved. Click to show it in its folder.`, file);
      } else {
        savedNote('Download failed', `${name} could not be saved.`, null);
      }
    });
  });
}

function savedNote(title, body, file) {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title, body, silent: true, icon: asset('icon.png') });
  note.on('click', () => {
    savedNotes.delete(note);
    if (file) shell.showItemInFolder(file);
  });
  note.on('close', () => savedNotes.delete(note));
  savedNotes.add(note);
  note.show();
}

// ---- smoke (CI) -------------------------------------------------------------------------------

/**
 * CI's launch check on every OS: the packaged app starts, its window shows the start page with
 * the bridge, the tray icon exists, and the gateway, opened signed out, is turned back to the
 * start page by the sign-in guard (a real round trip to agent-getway.f-proj.com, whose SSO
 * redirects to auth.f-proj.com/login). Writes the result as JSON and exits 0 only if all held.
 *
 * A gateway that is down (a 5xx, or a network error, in the probe or in the window's own load)
 * is not a verdict on the app: that attempt goes into `attempts` (its probe answer, headers and
 * body start, and what the window's load got) and the gateway is tried again after a back-off,
 * for SMOKE_RETRY_MS in all. Only the guard turning a real redirect back passes.
 *
 * If the time of an attempt (SMOKE_MS) runs out, the report says what the app knew then: the
 * step, `lastGuard`, the URL on screen, whether it was still loading, the main-frame events
 * since that attempt's gateway load started (`trace`), and what a plain request to the gateway
 * got (`probe`: its status and Location, or its network error), so a red run tells "the gateway
 * never answered", "the guard never fired", "the session never ended" and "the start page load
 * failed" apart.
 */
function smoke(file) {
  const wc = win.webContents;
  const result = { ok: false, step: 'start page', version: app.getVersion(), platform: process.platform,
    arch: process.arch, electron: process.versions.electron };
  const finish = (code) => { writeJson(file, result); app.exit(code); };
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      Object.assign(result, { timeout_ms: SMOKE_MS, lastGuard, url: shortUrl(wc.getURL()),
        loading: wc.isLoading(), trace });
      finish(1);
    }, SMOKE_MS);
  };
  arm();
  const startLoaded = () => new Promise((resolve) => {
    const check = () => {
      if (wc.getURL().startsWith('file:')) { wc.off('did-finish-load', check); resolve(); }
    };
    wc.on('did-finish-load', check);
  });

  /**
   * One gateway visit. Resolves when the start page is back (the guard, or the offline page),
   * or the gateway answered 5xx: with what the load got if the gateway was down, else null.
   */
  const visit = () => new Promise((resolve) => {
    let down = null;
    const onNavigate = (_e, url, code) => {
      if (code >= 500 && classify(url) === 'gateway') { down = `${code}`; mark(`http ${code}`, url); settle(); }
    };
    const onFail = (_e, code, _desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3 && classify(url) === 'gateway') down = `did-fail-load ${code}`;
    };
    const onFinish = () => { if (wc.getURL().startsWith('file:')) settle(); };
    function settle() {
      wc.off('did-navigate', onNavigate);
      wc.off('did-fail-load', onFail);
      wc.off('did-finish-load', onFinish);
      resolve(down);
    }
    wc.on('did-navigate', onNavigate);
    // Ahead of the window's own did-fail-load handler, whose offline page would settle us first.
    wc.prependListener('did-fail-load', onFail);
    wc.on('did-finish-load', onFinish);
    win.loadURL(GATEWAY).catch(() => {});
  });

  (async () => {
    await (wc.isLoading() || !wc.getURL().startsWith('file:') ? startLoaded() : null);
    result.title = await wc.executeJavaScript('document.title');
    result.bridge = await wc.executeJavaScript('typeof window.getway');
    result.tray = !!tray;
    // The packaged tray icons load: 16 px with their larger scales, templates on macOS.
    result.tray_icons = [false, true].map((unread) => {
      const img = trayImage(unread);
      return { empty: img.isEmpty(), size: img.getSize(), scales: img.getScaleFactors(), template: img.isTemplateImage() };
    });
    result.ua_marker = session.defaultSession.getUserAgent().includes(UA_MARKER);
    // macOS: the Dock badge over the app icon, so CI's Dock screenshot (ci/dock-shot.sh) shows it.
    if (process.platform === 'darwin') { app.setBadgeCount(2); result.dock_badge = app.getBadgeCount(); }
    if (SMOKE_MEDIA) {
      result.step = 'media';
      result.media = await smokeMedia(SMOKE_MEDIA);
    }
    result.step = 'gateway guard';
    result.attempts = [];
    const t0 = Date.now();
    for (let n = 1; ; n++) {
      arm();
      lastGuard = null;
      traceFrom = 0;
      trace.length = 0;
      result.probe = await probeGateway();
      traceFrom = Date.now();
      const load = await visit();
      result.load = load || 'not down';
      if (lastGuard === 'expired') break;
      const down = gatewayDown(result.probe.answer) || load;
      const wait = Math.min(SMOKE_BACKOFF_MS * 2 ** (n - 1), 6 * SMOKE_BACKOFF_MS);
      if (!down) break;
      if (Date.now() + wait - t0 > SMOKE_RETRY_MS) { result.gave_up_after_ms = Date.now() - t0; break; }
      result.attempts.push({ n, at_ms: Date.now() - t0, probe: result.probe, load: result.load, trace: [...trace] });
      clearTimeout(timer);
      await new Promise((r) => { setTimeout(r, wait); });
    }
    result.guard = lastGuard;
    result.trace = trace;
    result.ok = result.title === 'Getway Chat' && result.bridge === 'object'
      && result.ua_marker && result.guard === 'expired' && (!SMOKE_MEDIA || result.media?.ok === true) && (process.platform !== 'darwin' || result.dock_badge === 2)
      && result.tray_icons.every((i) => !i.empty && i.size.width === 16 && i.template === (process.platform === 'darwin'));
    if (result.ok || !result.gave_up_after_ms) result.step = 'done';
    clearTimeout(timer);
    finish(result.ok ? 0 : 1);
  })().catch((e) => { result.error = String(e && e.message); clearTimeout(timer); finish(1); });
}

/**
 * The chat shows an agent's images and MP4/WebM videos inline (agent-getway#223). This window
 * loads a page from a loopback server with ci/media's PNG, MP4 and WebM, served as the gateway
 * serves them (their type, nosniff, a sandboxing CSP), and reports whether the image decoded and
 * each video played: its first frames, its size, or the media error.
 */
async function smokeMedia(dir) {
  const types = { 'sample.png': 'image/png', 'sample.mp4': 'video/mp4', 'sample.webm': 'video/webm' };
  const page = '<!doctype html><title>media</title><img src="sample.png" alt="">'
    + '<video id="mp4" src="sample.mp4" muted playsinline preload="metadata"></video>'
    + '<video id="webm" src="sample.webm" muted playsinline preload="metadata"></video>';
  const server = http.createServer(async (req, res) => {
    const name = new URL(req.url, 'http://127.0.0.1').pathname.slice(1);
    if (name === '') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); return; }
    if (!types[name]) { res.writeHead(404); res.end(); return; }
    const body = await readFile(path.join(dir, name)).catch(() => null);
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[name], 'content-length': body.length,
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
    res.end(body);
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    return await win.webContents.executeJavaScript(MEDIA_CHECK);
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

// Runs in the media page: the image decodes, each video reaches a frame past 0 s on its own.
const MEDIA_CHECK = `(async () => {
  const img = document.querySelector('img');
  const image = await img.decode().then(
    () => ({ ok: img.naturalWidth > 0, width: img.naturalWidth, height: img.naturalHeight }),
    (e) => ({ ok: false, error: String(e) }));
  const play = (v) => new Promise((resolve) => {
    let t = null;
    const done = (r) => {
      if (!t) return;
      clearTimeout(t); t = null;
      resolve({ ...r, readyState: v.readyState, currentTime: v.currentTime });
    };
    t = setTimeout(() => done({ ok: false, error: 'not playing after 15 s' }), 15000);
    v.addEventListener('timeupdate', () => {
      if (v.currentTime > 0 && v.videoWidth > 0) done({ ok: true, width: v.videoWidth, height: v.videoHeight });
    });
    v.addEventListener('error', () => done({ ok: false, error: 'media error ' + (v.error && v.error.code) + ' ' + (v.error && v.error.message) }));
    v.play().catch((e) => done({ ok: false, error: String(e) }));
  });
  const mp4 = await play(document.getElementById('mp4'));
  const webm = await play(document.getElementById('webm'));
  return { ok: image.ok && mp4.ok && webm.ok, image, mp4, webm };
})()`;

/** A probe answer that means the gateway is down right now (not an answer about the app). */
function gatewayDown(answer) {
  return /^5\d\d\b/.test(answer) || answer.startsWith('error ') || answer.startsWith('no answer');
}

/**
 * One signed-out GET of the gateway through the app's own session (its proxy, DNS and user
 * agent; no cookies), redirects not followed. Resolves with {answer, ms}; a 5xx also brings the
 * headers that name who answered (`server`, `x-sso-status`, `content-type`) and the first 200
 * characters of its body, so a red run says whether the ingress or the gateway sent it.
 */
function probeGateway() {
  return new Promise((resolve) => {
    const out = { answer: 'none yet' };
    const t0 = Date.now();
    let req;
    const done = (answer) => {
      if (out.answer !== 'none yet') return;
      Object.assign(out, { answer, ms: Date.now() - t0 });
      clearTimeout(timer);
      try { req.abort(); } catch { /* already finished */ }
      resolve(out);
    };
    const timer = setTimeout(() => done('no answer in 20 s'), 20_000);
    try {
      req = net.request({ url: GATEWAY, session: session.defaultSession, useSessionCookies: false, redirect: 'manual' });
      req.setHeader('Accept', 'text/html');
      req.on('redirect', (status, _method, location) => done(`${status} ${shortUrl(location)}`));
      req.on('response', (res) => {
        if (res.statusCode < 500) return done(`${res.statusCode}`);
        const h = res.headers || {};
        out.headers = Object.fromEntries(['server', 'x-sso-status', 'content-type']
          .filter((k) => h[k] !== undefined).map((k) => [k, String(h[k])]));
        let body = '';
        const end = () => { out.body = body.replace(/\s+/g, ' ').trim().slice(0, 200); done(`${res.statusCode}`); };
        res.on('data', (chunk) => { body += chunk; if (body.length >= 200) end(); });
        res.on('end', end);
        res.on('error', end);
      });
      req.on('error', (err) => done(`error ${err?.message}`));
      req.end();
    } catch (err) {
      done(`error ${err?.message}`);
    }
  });
}
