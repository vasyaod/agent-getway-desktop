// What the window does with a URL a page tries to open. Pure, so `npm test` covers it.
//
//   'gateway'     agent-getway.f-proj.com over https: loads in the window.
//   'download'    a file the agent sent into a chat (agent-getway#223), on the gateway:
//                 /api/web/chats/<chat>/files/<file>. Never loaded in the window and never handed
//                 to the system browser, which has no sign-in for it: the app downloads it with
//                 its own session (main.js saveDownloads).
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

const GATEWAY_FILE = /^\/api\/web\/chats\/[^/]+\/files\/[^/]+$/; // agent-getway agent_files.file_url

export function classify(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'block'; }
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'https:' && host === GATEWAY_HOST && !u.username && !u.password) {
    return GATEWAY_FILE.test(u.pathname) ? 'download' : 'gateway';
  }
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

/**
 * A download the app saves: one from the gateway (a file the agent sent, or any other gateway
 * URL its page downloads), or a blob: the gateway page made. Anything else is cancelled.
 */
export function isGatewayDownload(raw) {
  const kind = classify(raw);
  if (kind === 'download' || kind === 'gateway') return true;
  let u;
  try { u = new URL(raw); } catch { return false; }
  return u.protocol === 'blob:' && classify(u.origin) === 'gateway';
}
