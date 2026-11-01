import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpStatus, getJson, poll } from '../src/poller.js';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function gateway() {
  const g = {
    chats: [],
    messages: {},
    fail: {},
    calls: [],
    get: async (path, token) => {
      g.calls.push([path, token]);
      if (g.fail[path]) throw new HttpStatus(g.fail[path]);
      if (path === 'api/web/chats') return { chats: g.chats };
      const id = /chats\/(\w+)\/messages/.exec(path)[1];
      return { messages: g.messages[id] || [] };
    },
  };
  return g;
}

function deps(g, extra = {}) {
  const shown = [];
  const d = {
    token: () => 'fpu_tok',
    get: g.get,
    state: { primed: false, chats: {} },
    saved: 0,
    save: () => { d.saved += 1; },
    visibleChatId: () => null,
    notify: (n) => shown.push(n),
    shown,
    ...extra,
  };
  return d;
}

test('first poll after sign-in primes without notifying; a new reply then notifies once', async () => {
  const g = gateway();
  const d = deps(g);
  g.chats = [{ id: A, title: 'Deploy', message_count: 2, updated_at: 't1', pending: false }];
  g.messages[A] = [{ role: 'user', text: 'go' }, { id: 'm2', role: 'assistant', text: 'ok' }];
  assert.equal(await poll(d), 'ok');
  assert.equal(d.shown.length, 0);
  assert.equal(d.state.primed, true);

  g.chats = [{ id: A, title: 'Deploy', message_count: 2, updated_at: 't2', pending: true }];
  await poll(d); // running
  g.chats = [{ id: A, title: 'Deploy', message_count: 4, updated_at: 't3', pending: false }];
  g.messages[A].push({ role: 'user', text: 'more' }, { id: 'm4', role: 'assistant', text: 'done\n\nnow' });
  await poll(d);
  assert.deepEqual(d.shown, [{ chatId: A, title: 'Deploy', body: 'done now' }]);
  await poll(d);
  assert.equal(d.shown.length, 1, 'no repeat');
  assert.ok(g.calls.every(([, t]) => t === 'fpu_tok'), 'every call carries the token');
});

test('rename, archived chats and the chat on screen do not notify; gone chats are forgotten', async () => {
  const g = gateway();
  let visible = null;
  const d = deps(g, { visibleChatId: () => visible });
  d.state = { primed: true, chats: { [A]: { token: '2@t1', count: 2, replyId: 'm2' }, [B]: { token: '1@t1', count: 1, replyId: '' } } };
  g.chats = [{ id: A, title: 'Renamed', message_count: 2, updated_at: 't9' }];
  await poll(d);
  assert.equal(d.shown.length, 0, 'rename');
  assert.equal(d.state.chats[B], undefined, 'B was deleted');

  g.chats = [{ id: A, message_count: 4, updated_at: 'u', archived_at: '2026' }];
  g.messages[A] = [{ id: 'm4', role: 'assistant', text: 'x' }];
  await poll(d);
  assert.equal(d.shown.length, 0, 'archived');

  visible = B;
  g.chats = [{ id: B, message_count: 2, updated_at: 'u' }];
  g.messages[B] = [{ id: 'b2', role: 'assistant', text: 'y' }];
  await poll(d);
  assert.equal(d.shown.length, 0, 'on screen');
});

test('401 = signed out, 403 = forbidden, other failures retry; a bad thread keeps its old state', async () => {
  const g = gateway();
  const d = deps(g);
  g.fail['api/web/chats'] = 401;
  assert.equal(await poll(d), 'signed_out');
  g.fail['api/web/chats'] = 403;
  assert.equal(await poll(d), 'forbidden');
  g.fail['api/web/chats'] = 502;
  assert.equal(await poll(d), 'retry');
  assert.equal(await poll(deps(g, { token: () => null })), 'signed_out');

  delete g.fail['api/web/chats'];
  d.state = { primed: true, chats: {} };
  g.chats = [{ id: A, message_count: 2, updated_at: 'x' }];
  g.fail[`api/web/chats/${A}/messages`] = 500;
  await poll(d);
  assert.equal(d.state.chats[A], undefined, 'not recorded, so the next poll tries again');
  delete g.fail[`api/web/chats/${A}/messages`];
  g.messages[A] = [{ id: 'm', role: 'assistant', text: 'hi' }];
  await poll(d);
  assert.equal(d.shown.length, 1);
});

test('getJson sends the bearer, refuses redirects and non-200s', async () => {
  let seen;
  const out = await getJson('https://agent-getway.f-proj.com/', 'api/web/chats', 'fpu_x', async (url, opts) => {
    seen = { url: String(url), opts };
    return { status: 200, text: async () => '{"chats":[]}' };
  });
  assert.deepEqual(out, { chats: [] });
  assert.equal(seen.url, 'https://agent-getway.f-proj.com/api/web/chats');
  assert.equal(seen.opts.headers.Authorization, 'Bearer fpu_x');
  assert.equal(seen.opts.redirect, 'manual');
  await assert.rejects(getJson('https://g/', 'p', 't', async () => ({ status: 302, text: async () => '' })),
    (e) => e instanceof HttpStatus && e.code === 302);
});
