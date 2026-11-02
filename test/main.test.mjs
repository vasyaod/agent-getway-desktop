// src/main.js itself, run against the fake Electron (fake-electron/): what it loads, what it
// lets through, where the token goes, what it notifies. No Chromium is started.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fake, reset } from './fake-electron/index.mjs';

const START = pathToFileURL(path.resolve('src/start/index.html')).href;
const CHAT = 'https://agent-getway.f-proj.com/#/chat';
const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const realFetch = globalThis.fetch;
const startFrame = { senderFrame: { url: START } };

/** The network main.js sees: auth.f-proj.com and the gateway are scripted, loopback is real. */
function net() {
  const n = { calls: [], chats: [], messages: {}, chatsStatus: 200, token: { access_token: 'fpu_new', expires_in: 3600 } };
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.hostname === '127.0.0.1') return realFetch(url, opts);
    n.calls.push({ url: u.href, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    const json = (status, body) => new Response(JSON.stringify(body), { status });
    if (u.href === 'https://auth.f-proj.com/token') return json(200, n.token);
    if (u.href === 'https://auth.f-proj.com/logout') return new Response('', { status: 204 });
    if (u.pathname === '/api/web/chats') return json(n.chatsStatus, { chats: n.chats });
    const m = /^\/api\/web\/chats\/(\w+)\/messages$/.exec(u.pathname);
    if (m) return json(200, { messages: n.messages[m[1]] || [] });
    return json(404, {});
  };
  return n;
}

const until = async (cond, what = 'condition') => {
  for (let i = 0; i < 400; i += 1) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

let launches = 0;
async function launch(opts = {}) {
  reset({ userData: mkdtempSync(path.join(tmpdir(), 'gc-test-')), ...opts });
  await import(`../src/main.js?launch=${++launches}`);
  await until(() => fake.windows[0]?.webContents.loads.length > 0, 'first load');
  return fake.windows[0];
}
const quit = () => { fake.appEvents.emit('before-quit'); fake.appEvents.emit('will-quit'); };
const liveCookie = (value = 'fpu_old') => ({
  name: 'fproj_auth', value, domain: '.f-proj.com', expirationDate: Date.now() / 1000 + 3600,
});
const lastStatus = (win) => win.webContents.sent.filter(([c]) => c === 'getway:status').at(-1)?.[1];

test.afterEach(() => { globalThis.fetch = realFetch; mock.timers.reset(); });

test('signed out: the start page, a locked-down window, the UA marker and a tray', async () => {
  net();
  const win = await launch();
  assert.equal(win.webContents.url, START);
  const wp = win.opts.webPreferences;
  assert.equal(wp.contextIsolation, true);
  assert.equal(wp.sandbox, true);
  assert.equal(wp.nodeIntegration, false);
  assert.match(fake.userAgent, / AgentGetwayChat\/1$/);
  assert.equal(fake.trays.length, 1);
  assert.equal(fake.trays[0].tooltip, 'Getway Chat');

  const status = await fake.handlers['getway:status'](startFrame);
  assert.equal(status.phase, 'idle');
  assert.equal(status.version, '0.1.0');
  const gatewayFrame = { senderFrame: { url: CHAT } };
  assert.equal(await fake.handlers['getway:status'](gatewayFrame), null, 'no IPC for the gateway page');
  assert.equal(await fake.handlers['getway:sign-in'](gatewayFrame), null);
  quit();
});

test('permissions: the gateway gets the mic, clipboard and full screen; nobody gets notifications', async () => {
  net();
  await launch();
  const G = 'https://agent-getway.f-proj.com/';
  assert.equal(fake.permissionCheck(null, 'media', G), true);
  assert.equal(fake.permissionCheck(null, 'clipboard-sanitized-write', G), true);
  assert.equal(fake.permissionCheck(null, 'notifications', G), false);
  assert.equal(fake.permissionCheck(null, 'media', 'https://evil.example/'), false);
  const ask = (permission, details) => new Promise((r) => fake.permissionRequest(null, permission, r, details));
  assert.equal(await ask('media', { requestingUrl: G, mediaTypes: ['audio'] }), true);
  assert.equal(await ask('media', { requestingUrl: G, mediaTypes: ['audio', 'video'] }), false);
  assert.equal(await ask('notifications', { requestingUrl: G }), false);
  assert.equal(await ask('geolocation', { requestingUrl: G }), false);
  assert.equal(await ask('media', { requestingUrl: 'https://evil.example/', mediaTypes: ['audio'] }), false);
  quit();
});

test('Sign in: system browser, loopback answer, /token, HttpOnly cookie, chat, watcher', async () => {
  const n = net();
  const win = await launch();
  let authorize;
  fake.onOpenExternal = async (url) => {
    authorize = new URL(url);
    const redirect = authorize.searchParams.get('redirect_uri');
    await realFetch(`${redirect}?code=c0de&state=${authorize.searchParams.get('state')}`);
  };
  await fake.handlers['getway:sign-in'](startFrame);
  await until(() => win.webContents.url === CHAT, 'the chat');

  assert.equal(authorize.origin, 'https://auth.f-proj.com');
  assert.equal(authorize.searchParams.get('client_id'), 'Getway Chat Desktop');
  assert.match(authorize.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const tokenCall = n.calls.find((c) => c.url === 'https://auth.f-proj.com/token');
  assert.equal(JSON.parse(tokenCall.body).code, 'c0de');

  assert.equal(fake.cookies.length, 1);
  const c = fake.cookies[0];
  assert.deepEqual({ ...c, expirationDate: undefined }, {
    url: 'https://agent-getway.f-proj.com/', name: 'fproj_auth', value: 'fpu_new', domain: '.f-proj.com',
    path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: undefined,
  });
  assert.ok(Math.abs(c.expirationDate - (Date.now() / 1000 + 3600)) < 5);

  await until(() => n.calls.some((x) => x.url.endsWith('/api/web/chats')), 'the first poll');
  const pollCall = n.calls.find((x) => x.url.endsWith('/api/web/chats'));
  assert.equal(pollCall.headers.Authorization, 'Bearer fpu_new');
  quit();
});

test('a sign-in the user Denied lands back on the start page with the reason', async () => {
  net();
  const win = await launch();
  fake.onOpenExternal = async (url) => {
    const a = new URL(url);
    await realFetch(`${a.searchParams.get('redirect_uri')}?error=access_denied&state=${a.searchParams.get('state')}`);
  };
  await fake.handlers['getway:sign-in'](startFrame);
  await until(() => lastStatus(win)?.error, 'the error');
  assert.match(lastStatus(win).message, /Deny/);
  assert.equal(fake.cookies.length, 0);
  quit();
});

test('signed in at launch: straight to the chat; a reply notifies, badges and opens on click', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const n = net();
  n.chats = [{ id: A, title: 'Deploy', message_count: 2, updated_at: 't1' }];
  n.messages[A] = [{ id: 'm2', role: 'assistant', text: 'old' }];
  const win = await launch({ cookies: [liveCookie()], focused: false });
  assert.equal(win.webContents.url, CHAT);
  await until(() => n.calls.length >= 1, 'the priming poll');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fake.notifications.length, 0, 'priming notifies nothing');

  n.chats = [{ id: A, title: 'Deploy', message_count: 4, updated_at: 't2' }];
  n.messages[A].push({ role: 'user', text: 'q' }, { id: 'm4', role: 'assistant', text: 'new reply' });
  mock.timers.tick(30_000);
  await until(() => fake.notifications.length === 1, 'the notification');
  const note = fake.notifications[0];
  assert.deepEqual(note.opts.title, 'Deploy');
  assert.equal(note.opts.body, 'new reply');
  assert.equal(note.opts.silent, false, 'window not focused: with sound');
  assert.equal(note.shown, true);
  assert.deepEqual(fake.badge, [1]);
  assert.match(fake.trays[0].image.path, /tray-unread\.png$/);
  assert.equal(fake.trays[0].tooltip, 'Getway Chat: 1 unread reply');

  fake.focused = true;
  note.emit('click');
  assert.equal(win.webContents.url, `${CHAT}/${A}`);
  assert.deepEqual(fake.badge, [1, 0]);
  assert.match(fake.trays[0].image.path, /tray\.png$/);
  assert.ok(n.calls.every((c) => c.headers.Authorization === 'Bearer fpu_old'));
  quit();
});

test('focusing the window on an unread chat marks it read', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const n = net();
  const win = await launch({ cookies: [liveCookie()], focused: false });
  await until(() => n.calls.length >= 1, 'the priming poll');
  await new Promise((r) => setTimeout(r, 20));
  n.chats = [{ id: A, title: 'x', message_count: 1, updated_at: 't' }];
  n.messages[A] = [{ id: 'm1', role: 'assistant', text: 'hi' }];
  mock.timers.tick(30_000);
  await until(() => fake.badge.at(-1) === 1, 'unread');
  win.loadURL(`${CHAT}/${A}`);
  assert.equal(fake.badge.at(-1), 1, 'not focused yet');
  fake.focused = true;
  win.visible = true;
  win.emit('focus');
  assert.equal(fake.badge.at(-1), 0);
  assert.equal(fake.notifications[0].closed, true);
  quit();
});

test('links: other sites open in the system browser; nothing else can be navigated to', async () => {
  net();
  const win = await launch({ cookies: [liveCookie()] });
  const wc = win.webContents;
  assert.equal(wc.navigate('https://github.com/x'), false);
  assert.deepEqual(fake.opened, ['https://github.com/x']);
  assert.equal(wc.navigate('file:///etc/passwd'), false);
  assert.equal(wc.navigate('javascript:alert(1)'), false);
  assert.equal(fake.opened.length, 1);
  assert.equal(wc.navigate(`${CHAT}/${A}`), true);
  assert.deepEqual(wc.openHandler({ url: 'https://agent-swarm.f-proj.com/s/1' }), { action: 'deny' });
  assert.deepEqual(wc.openHandler({ url: 'file:///x' }), { action: 'deny' });
  assert.deepEqual(wc.openHandler({ url: 'https://auth.f-proj.com/logout' }), { action: 'deny' });
  assert.deepEqual(fake.opened, ['https://github.com/x', 'https://agent-swarm.f-proj.com/s/1']);
  quit();
});

test('the gateway\'s Sign out revokes this app\'s token and shows Sign in', async () => {
  const n = net();
  const win = await launch({ cookies: [liveCookie('fpu_old')] });
  assert.equal(win.webContents.navigate('https://auth.f-proj.com/logout?rd=x'), false);
  await until(() => win.webContents.url === START, 'the start page');
  const out = n.calls.find((c) => c.url === 'https://auth.f-proj.com/logout');
  assert.equal(out.method, 'POST');
  assert.equal(out.headers.Authorization, 'Bearer fpu_old');
  assert.equal(fake.cookies.length, 0);
  assert.equal(lastStatus(win).message, 'You signed out.');
  quit();
});

test('a session that ended (redirect to /login, or a 401 to the watcher) forgets the token, no revoke', async () => {
  let n = net();
  let win = await launch({ cookies: [liveCookie()] });
  assert.equal(win.webContents.navigate('https://auth.f-proj.com/login?rd=x', 'will-redirect'), false);
  await until(() => win.webContents.url === START, 'the start page');
  assert.equal(fake.cookies.length, 0);
  assert.equal(n.calls.some((c) => c.url.endsWith('/logout')), false);
  assert.match(lastStatus(win).message, /ended/);
  quit();

  n = net();
  n.chatsStatus = 401;
  win = await launch({ cookies: [liveCookie()] });
  await until(() => win.webContents.url === START, 'the start page after a 401');
  assert.equal(fake.cookies.length, 0);
  quit();
});

test('a refused start-page load (Electron ERR_FAILED) is retried, so a session that ended still lands on Sign in', async () => {
  net();
  const win = await launch({ cookies: [liveCookie()] });
  fake.refuseNextLoad = true;
  assert.equal(win.webContents.navigate('https://auth.f-proj.com/login?rd=x', 'will-redirect'), false);
  await until(() => win.webContents.url === START, 'the start page after the retry');
  assert.equal(fake.refuseNextLoad, false, 'the first load was the refused one');
  quit();
});

/** The app in CI's smoke mode (GETWAY_CHAT_SMOKE): runs until it exits, returns its report. */
async function smokeRun({ ms, setup = () => {} } = {}) {
  const report = path.join(mkdtempSync(path.join(tmpdir(), 'gc-smoke-')), 'report.json');
  process.env.GETWAY_CHAT_SMOKE = report;
  if (ms) process.env.GETWAY_CHAT_SMOKE_MS = String(ms);
  try {
    reset({ userData: mkdtempSync(path.join(tmpdir(), 'gc-test-')) });
    setup();
    await import(`../src/main.js?launch=${++launches}`);
    await until(() => fake.exited !== null, 'the smoke to exit');
  } finally {
    delete process.env.GETWAY_CHAT_SMOKE;
    delete process.env.GETWAY_CHAT_SMOKE_MS;
  }
  return { code: fake.exited, report: JSON.parse(readFileSync(report, 'utf8')) };
}

test('smoke: a signed-out gateway visit is redirected to /login, cancelled, and comes back to the start page', async () => {
  net();
  const { code, report } = await smokeRun({ setup: () => {
    fake.redirects['https://agent-getway.f-proj.com/'] = 'https://auth.f-proj.com/login?rd=https%3A%2F%2Fagent-getway.f-proj.com%2F';
  } });
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.ok, true);
  assert.equal(report.step, 'done');
  assert.equal(report.guard, 'expired');
  assert.deepEqual(report.probe.answer, '302 https://auth.f-proj.com/login');
  const steps = report.trace.map((t) => t.replace(/^\d+ms /, ''));
  assert.deepEqual(steps, [
    'did-start-navigation https://agent-getway.f-proj.com/',
    'will-redirect https://auth.f-proj.com/login',
    'guard expired',
    'did-stop-loading',
    'endSession expired',
    'cookie cleared',
    'loadFile start',
    'did-finish-load file:…/index.html', // the smoke reports here, before the load's promise settles
  ]);
  assert.equal(fake.windows[0].webContents.loads.includes('https://auth.f-proj.com/login?rd=https%3A%2F%2Fagent-getway.f-proj.com%2F'), false,
    'auth.f-proj.com never loads in the window');
});

test('smoke: when time runs out the report names the step, the URL, lastGuard, the trace and the probe', async () => {
  net();
  const { code, report } = await smokeRun({ ms: 300, setup: () => {
    fake.hang.add('https://agent-getway.f-proj.com/');
    fake.netAnswer = { error: 'net::ERR_CONNECTION_TIMED_OUT' };
  } });
  assert.equal(code, 1);
  assert.equal(report.ok, false);
  assert.equal(report.step, 'gateway guard');
  assert.equal(report.timeout_ms, 300);
  assert.equal(report.lastGuard, null);
  assert.equal(report.url, 'file:…/index.html');
  assert.equal(report.loading, true);
  assert.deepEqual(report.trace.map((t) => t.replace(/^\d+ms /, '')), ['did-start-navigation https://agent-getway.f-proj.com/']);
  assert.match(report.probe.answer, /^error net::ERR_CONNECTION_TIMED_OUT$/);
});

test('smoke: the gateway page loading instead of redirecting fails the smoke and says so', async () => {
  net();
  const { code, report } = await smokeRun({ ms: 300, setup: () => {
    fake.redirects['https://agent-getway.f-proj.com/'] = 'https://agent-getway.f-proj.com/#/chat';
  } });
  assert.equal(code, 1);
  assert.equal(report.lastGuard, null);
  assert.equal(report.url, 'https://agent-getway.f-proj.com/');
  assert.ok(report.trace.some((t) => t.endsWith('did-redirect-navigation https://agent-getway.f-proj.com/')));
});

test('an expired cookie is not a sign-in; offline shows Try again, which reopens the chat', async () => {
  net();
  let win = await launch({ cookies: [{ ...liveCookie(), expirationDate: Date.now() / 1000 + 30 }] });
  assert.equal(win.webContents.url, START);
  quit();

  net();
  win = await launch({ cookies: [liveCookie()] });
  win.webContents.emit('did-fail-load', {}, -106, 'ERR_INTERNET_DISCONNECTED', CHAT, true);
  assert.equal(win.webContents.url, START);
  assert.equal(lastStatus(win).phase, 'offline');
  await fake.handlers['getway:retry'](startFrame);
  assert.equal(win.webContents.url, CHAT);
  win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', CHAT, true);
  assert.equal(win.webContents.url, CHAT, 'our own guard aborting a load is not offline');
  quit();
});

test('closing hides the window and saves its bounds; quitting really closes', async () => {
  net();
  const win = await launch();
  win.visible = true;
  let prevented = false;
  win.emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(win.visible, false);
  const saved = JSON.parse(readFileSync(path.join(fake.userData, 'window.json'), 'utf8'));
  assert.deepEqual(saved, { x: 10, y: 20, width: 1100, height: 800, maximized: false });
  quit();
  prevented = false;
  win.emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
});

test('the saved bounds come back at the next launch', async () => {
  net();
  reset({ userData: mkdtempSync(path.join(tmpdir(), 'gc-test-')) });
  const dir = fake.userData;
  const { writeJson } = await import('../src/store.js');
  writeJson(path.join(dir, 'window.json'), { x: 300, y: 200, width: 900, height: 650, maximized: true });
  await import(`../src/main.js?launch=${++launches}`);
  await until(() => fake.windows[0]?.webContents.loads.length > 0, 'first load');
  const win = fake.windows[0];
  assert.deepEqual([win.opts.x, win.opts.y, win.opts.width, win.opts.height], [300, 200, 900, 650]);
  assert.equal(win.maximized, true);
  quit();
});
