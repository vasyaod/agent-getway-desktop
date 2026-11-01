// One look at agent-getway for agent replies: the chat list, then the thread of each chat whose
// turn just settled, then a notification per new reply. A port of the Android app's
// ReplyPoller.java, minus Android: everything it touches comes in as `deps`, so `npm test`
// drives it with a fake gateway.
//
// Signed in with the app token as `Authorization: Bearer`, which agent-getway's SSO
// (server/src/sso.py, issue #148) takes from native clients. The token is only ever copied into
// that header; it is never logged.
import { isChatId } from './navigation.js';
import { body, isNews, settledReply, title, turnToken } from './rules.js';

export class HttpStatus extends Error {
  constructor(code) { super(`HTTP ${code}`); this.code = code; }
}

const MAX_BYTES = 8 << 20;

/** A read-only GET on the gateway, signed in with the token. */
export async function getJson(gateway, path, token, fetchImpl = fetch) {
  const r = await fetchImpl(new URL(path, gateway), {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status !== 200) throw new HttpStatus(r.status);
  const text = await r.text();
  if (text.length > MAX_BYTES) throw new Error('response too large');
  return JSON.parse(text);
}

/**
 * deps:
 *   token()            the live app token, or null when signed out
 *   get(path, token)   getJson bound to the gateway
 *   state              {primed: bool, chats: {[id]: {token, count, replyId}}}, mutated in place
 *   save()             persists `state`
 *   visibleChatId()    the chat on screen in a focused window, or null (asked late, per reply)
 *   notify({chatId, title, body})
 * Returns 'ok' | 'retry' | 'signed_out' | 'forbidden'.
 */
export async function poll(deps) {
  const token = deps.token();
  if (!token) return 'signed_out';
  try {
    const list = await deps.get('api/web/chats', token);
    if (!list || !Array.isArray(list.chats)) return 'retry';
    await scan(deps, token, list.chats);
    return 'ok';
  } catch (e) {
    // 401 = the sign-in ended: the app forgets it and shows Sign in. 403 = no grant for it.
    if (e instanceof HttpStatus && e.code === 401) return 'signed_out';
    if (e instanceof HttpStatus && e.code === 403) return 'forbidden';
    return 'retry';
  }
}

async function scan(deps, token, chats) {
  const { state } = deps;
  state.chats ||= {};
  const primed = !!state.primed;
  const listed = new Set();

  for (const chat of chats) {
    if (!chat || !isChatId(chat.id)) continue;
    const { id } = chat;
    listed.add(id);
    const count = Number(chat.message_count) || 0;
    const tok = turnToken(!!chat.pending, count, chat.updated_at);
    const prior = state.chats[id] || null;
    const priorReply = prior ? prior.replyId : '';

    if (!isNews(prior, tok, count, primed)) {
      state.chats[id] = { token: tok ?? '', count, replyId: priorReply };
      continue;
    }
    let reply;
    try {
      reply = settledReply((await deps.get(`api/web/chats/${id}/messages`, token))?.messages);
    } catch (e) {
      if (e instanceof HttpStatus && (e.code === 401 || e.code === 403)) throw e;
      continue; // keep the old state: the next poll tries this chat again
    }
    const replyId = reply ? String(reply.id ?? '') : priorReply;
    state.chats[id] = { token: tok, count, replyId };
    if (!reply || (replyId && replyId === priorReply)) continue;
    if (chat.archived_at != null) continue; // put away by the operator: no alerts
    // Asked now, not at the start of the scan: the message fetches above take a moment.
    if (id === deps.visibleChatId()) continue; // on screen already
    deps.notify({ chatId: id, title: title(chat.title), body: body(reply.text, reply.error) });
  }

  for (const id of Object.keys(state.chats)) if (!listed.has(id)) delete state.chats[id];
  state.primed = true;
  deps.save();
}
