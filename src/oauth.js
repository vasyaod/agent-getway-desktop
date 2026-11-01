// Signing in at auth.f-proj.com: the OAuth flow for apps (authorization code + PKCE S256,
// auth-service#23), as a native app does it per RFC 8252.
//
// The app opens /authorize in the SYSTEM browser (you are usually signed in there already, and
// Google sign-in works because it is a real browser), with a loopback redirect_uri:
// http://127.0.0.1:<port>/callback. auth-service allows loopback http for any port
// (service/src/oauth.py redirect_uri_error). A one-shot server on that port takes the answer,
// checks `state`, and POST /token trades the code for an app token `fpu_…`.
//
// The token is never logged and never handed to a page: it goes into the session's cookie jar
// as the HttpOnly `fproj_auth` cookie (main.js), and into the poller's Authorization header.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { AUTH, CLIENT_ID } from './config.js';

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE pair and a state, fresh per sign-in. */
export function newRequest() {
  const verifier = b64url(randomBytes(32)); // 43 characters of [A-Za-z0-9_-]
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, state: b64url(randomBytes(16)) };
}

export function authorizeUrl({ challenge, state }, redirectUri) {
  const q = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  return `${AUTH}/authorize?${q}`;
}

/**
 * What the browser came back with, checked against the sign-in we started. Returns the code, or
 * throws an Error whose message is for the user.
 */
export function readCallback(search, expectedState) {
  const p = new URLSearchParams(search);
  if (!expectedState || p.get('state') !== expectedState) {
    throw new Error('This sign-in answer does not belong to the sign-in this app started '
      + '(state mismatch). Sign in again.');
  }
  const error = p.get('error');
  if (error === 'access_denied') throw new Error('You chose Deny on auth.f-proj.com. Sign in again to allow Getway Chat.');
  if (error) throw new Error(`auth.f-proj.com: ${p.get('error_description') || error}. Sign in again.`);
  const code = p.get('code');
  if (!code) throw new Error('auth.f-proj.com sent no code. Sign in again.');
  return code;
}

/** What to keep from a /token answer ({access_token, expires_in}), or null. */
export function tokenRecord(body, now = Date.now()) {
  const token = body && body.access_token;
  const ttl = body && body.expires_in;
  if (typeof token !== 'string' || !token || !(ttl > 0)) return null;
  return { token, expiresAt: now + ttl * 1000 };
}

/** The record if it is still good for at least a minute, else null. */
export function liveRecord(rec, now = Date.now()) {
  if (!rec || typeof rec.token !== 'string' || !rec.token) return null;
  if (!(rec.expiresAt > now + 60_000)) return null;
  return { token: rec.token, expiresAt: rec.expiresAt };
}

/** POST /token. Returns {token, expiresAt}; throws an Error whose message is for the user. */
export async function redeem({ code, verifier, redirectUri }, fetchImpl = fetch) {
  let r;
  try {
    r = await fetchImpl(`${AUTH}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        client_id: CLIENT_ID, code_verifier: verifier,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('Could not reach auth.f-proj.com to finish signing in. Sign in again.');
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    // RFC 6749 §5.2: {error, error_description}; a code lives 60 s and is single use.
    if (r.status === 429) throw new Error('Too many failed sign-ins from this network. Try again in 15 minutes.');
    if (/expired|unknown/i.test(body.error_description || '')) {
      throw new Error('The sign-in code expired before the app could use it (it lasts 60 seconds). Sign in again.');
    }
    const why = body.error_description || body.error || `answered ${r.status}`;
    throw new Error(`auth.f-proj.com refused the sign-in: ${why}. Sign in again.`);
  }
  const rec = tokenRecord(body);
  if (!rec) throw new Error('auth.f-proj.com sent no token. Sign in again.');
  return rec;
}

/** Revokes this app's token only (the browser and other apps stay signed in). Best effort. */
export async function revoke(token, fetchImpl = fetch) {
  if (!token) return;
  try {
    await fetchImpl(`${AUTH}/logout`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
  } catch { /* offline: the token still expires, and Connected apps can revoke it */ }
}

const PAGE = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 1em;color:#1d2733}
h1{font-size:1.3em;color:#29B6D1}</style><h1>${title}</h1><p>${text}</p>`;

/**
 * Starts a sign-in: listens on 127.0.0.1 (an ephemeral port), calls `open` with the /authorize
 * URL, and resolves with {code, verifier, redirectUri} when the browser comes back, or rejects
 * with a user-facing Error. `cancel()` ends it early (a second Sign in, quitting). It serves
 * one answer and closes; anything but GET /callback is a 404.
 */
export function startSignIn(open, { timeoutMs = 5 * 60_000 } = {}) {
  const req = newRequest();
  let server;
  let redirect;
  let timer;
  let settle;
  const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const finish = (err, value) => {
    clearTimeout(timer);
    if (server) server.close();
    server = null;
    if (err) settle.reject(err); else settle.resolve(value);
  };

  server = createServer((httpReq, res) => {
    const url = new URL(httpReq.url, 'http://127.0.0.1');
    if (httpReq.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    let code;
    try {
      code = readCallback(url.search, req.state);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(PAGE('Getway Chat: not signed in', `${e.message} You can close this tab.`));
      // A request without our state is not auth.f-proj.com's answer (another local page
      // guessing the port): it must not end the sign-in. A Deny or an error with it does.
      if (url.searchParams.get('state') === req.state) finish(e);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(PAGE('Getway Chat: signed in', 'You can close this tab and go back to Getway Chat.'));
    finish(null, { code, verifier: req.verifier, redirectUri: redirect });
  });

  server.on('error', () => finish(new Error('Could not start the sign-in (no local port). Try again.')));
  server.listen(0, '127.0.0.1', async () => {
    redirect = `http://127.0.0.1:${server.address().port}/callback`;
    timer = setTimeout(() => finish(new Error('The sign-in took too long. Sign in again.')), timeoutMs);
    try {
      await open(authorizeUrl(req, redirect));
    } catch {
      finish(new Error('Could not open the browser for signing in.'));
    }
  });

  return {
    done,
    cancel: () => { if (server) finish(new Error('Sign-in cancelled.')); },
  };
}
