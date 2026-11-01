import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { authorizeUrl, liveRecord, newRequest, readCallback, redeem, startSignIn, tokenRecord } from '../src/oauth.js';

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('PKCE S256: the challenge is the verifier\'s sha256, fresh state each time', () => {
  const a = newRequest();
  const b = newRequest();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.challenge, b64url(createHash('sha256').update(a.verifier).digest()));
  assert.notEqual(a.state, b.state);
});

test('authorizeUrl names the desktop client and the loopback redirect', () => {
  const u = new URL(authorizeUrl({ challenge: 'c', state: 's' }, 'http://127.0.0.1:5555/callback'));
  assert.equal(u.origin + u.pathname, 'https://auth.f-proj.com/authorize');
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    response_type: 'code', client_id: 'Getway Chat Desktop', redirect_uri: 'http://127.0.0.1:5555/callback',
    code_challenge: 'c', code_challenge_method: 'S256', state: 's',
  });
});

test('readCallback: state must match; Deny and errors are told plainly', () => {
  assert.equal(readCallback('?code=abc&state=s', 's'), 'abc');
  assert.throws(() => readCallback('?code=abc&state=x', 's'), /state mismatch/);
  assert.throws(() => readCallback('?code=abc&state=s', null), /state mismatch/);
  assert.throws(() => readCallback('?error=access_denied&state=s', 's'), /Deny/);
  assert.throws(() => readCallback('?error=server_error&error_description=down&state=s', 's'), /down/);
  assert.throws(() => readCallback('?state=s', 's'), /no code/);
});

test('tokenRecord / liveRecord', () => {
  assert.deepEqual(tokenRecord({ access_token: 'fpu_x', expires_in: 100 }, 1000), { token: 'fpu_x', expiresAt: 101000 });
  assert.equal(tokenRecord({ access_token: '', expires_in: 100 }), null);
  assert.equal(tokenRecord({ access_token: 'fpu_x' }), null);
  assert.deepEqual(liveRecord({ token: 't', expiresAt: 200_000 }, 100_000), { token: 't', expiresAt: 200_000 });
  assert.equal(liveRecord({ token: 't', expiresAt: 150_000 }, 100_000), null, 'under a minute left');
  assert.equal(liveRecord(null), null);
});

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('redeem posts the code, verifier, redirect and client id; maps refusals to user text', async () => {
  let sent;
  const rec = await redeem({ code: 'c1', verifier: 'v1', redirectUri: 'http://127.0.0.1:1/callback' },
    async (url, opts) => { sent = { url, opts }; return reply(200, { access_token: 'fpu_t', expires_in: 60 }); });
  assert.equal(sent.url, 'https://auth.f-proj.com/token');
  assert.equal(sent.opts.method, 'POST');
  assert.deepEqual(JSON.parse(sent.opts.body), {
    grant_type: 'authorization_code', code: 'c1', redirect_uri: 'http://127.0.0.1:1/callback',
    client_id: 'Getway Chat Desktop', code_verifier: 'v1',
  });
  assert.equal(rec.token, 'fpu_t');
  await assert.rejects(redeem({}, async () => reply(400, { error: 'invalid_grant', error_description: 'code expired' })), /expired/);
  await assert.rejects(redeem({}, async () => reply(429, {})), /15 minutes/);
  await assert.rejects(redeem({}, async () => reply(400, { error: 'invalid_request' })), /invalid_request/);
  await assert.rejects(redeem({}, async () => { throw new Error('net'); }), /Could not reach/);
  await assert.rejects(redeem({}, async () => reply(200, {})), /no token/);
});

test('startSignIn: a real loopback round trip; a stranger without our state cannot end it', async () => {
  let authorize;
  const s = startSignIn((url) => { authorize = new URL(url); });
  while (!authorize) await new Promise((r) => setTimeout(r, 5));
  const redirect = new URL(authorize.searchParams.get('redirect_uri'));
  assert.equal(redirect.hostname, '127.0.0.1');
  assert.equal(redirect.pathname, '/callback');
  const state = authorize.searchParams.get('state');

  assert.equal((await fetch(new URL('/other', redirect))).status, 404);
  assert.equal((await fetch(`${redirect}?code=evil&state=wrong`)).status, 400, 'wrong state: refused');
  const ok = await fetch(`${redirect}?code=good&state=${state}`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /signed in/);
  const answer = await s.done;
  assert.equal(answer.code, 'good');
  assert.equal(answer.redirectUri, redirect.href);
  assert.equal(createHash('sha256').update(answer.verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));
  await assert.rejects(fetch(`${redirect}?code=again&state=${state}`), 'the port is closed after one answer');
});

test('startSignIn: Deny ends it with the reason; cancel() and the timeout end it too', async () => {
  let url;
  const s = startSignIn((u) => { url = new URL(u); });
  while (!url) await new Promise((r) => setTimeout(r, 5));
  const denied = assert.rejects(s.done, /Deny/);
  const r = await fetch(`${url.searchParams.get('redirect_uri')}?error=access_denied&state=${url.searchParams.get('state')}`);
  assert.equal(r.status, 400);
  await denied;

  const c = startSignIn(() => {});
  c.cancel();
  await assert.rejects(c.done, /cancelled/);

  const t = startSignIn(() => {}, { timeoutMs: 20 });
  await assert.rejects(t.done, /too long/);

  const f = startSignIn(() => { throw new Error('no browser'); });
  await assert.rejects(f.done, /open the browser/);
});
