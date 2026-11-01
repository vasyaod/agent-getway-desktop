// What the window does with a URL a page tries to open. Pure, so `npm test` covers it.
//
//   'gateway'     agent-getway.f-proj.com over https: loads in the window.
//   'signed_out'  auth.f-proj.com/logout…: the gateway's Sign out link. The app revokes its
//                 token and shows its start page.
//   'expired'     any other auth.f-proj.com page: the gateway sends a session that ended to
//                 /login?rd=… (a 302 on a page load, or ui/src/session.js on a 401). The app
//                 forgets the token and shows its start page. auth.f-proj.com's own pages never
//                 load inside the window: signing in happens in the system browser (oauth.js).
//   'external'    any other http(s) or mailto: URL: opens in the system browser.
//   'block'       everything else (file:, javascript:, data:, custom schemes): nothing happens.
//
// This mirrors the Android app's SignInGuardPlugin.java and its allowNavigation.
import { AUTH_HOST, GATEWAY_HOST } from './config.js';

export function classify(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'block'; }
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'https:' && host === GATEWAY_HOST && !u.username && !u.password) return 'gateway';
  if ((u.protocol === 'https:' || u.protocol === 'http:') && host === AUTH_HOST) {
    return u.pathname.startsWith('/logout') ? 'signed_out' : 'expired';
  }
  if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') return 'external';
  return 'block';
}

const CHAT_ID = /^[0-9a-f]{24}$/;

/** The chat a gateway URL has open (https://agent-getway.f-proj.com/#/chat/<id>), or null. */
export function openChatId(raw) {
  if (classify(raw) !== 'gateway') return null;
  const hash = new URL(raw).hash;
  const m = /^#\/chat\/([^/?#]+)/.exec(hash);
  if (!m) return null;
  let id;
  try { id = decodeURIComponent(m[1]); } catch { return null; }
  return CHAT_ID.test(id) ? id : null;
}

export const isChatId = (id) => typeof id === 'string' && CHAT_ID.test(id);
