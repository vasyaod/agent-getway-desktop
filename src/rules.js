// The decisions behind reply notifications. Pure, so `npm test` covers them. A port of the
// Android app's ReplyRules.java, which mirrors agent-getway's own web announcer
// (ui/src/notify.js: settledReply, createAnnouncer.observe, notificationBody), so the desktop,
// the phone and a browser tab agree on what counts as "the agent replied".

export const FALLBACK_BODY = 'The agent replied.';
export const BODY_MAX = 180;
export const TITLE_MAX = 80;

/** A chat's turn, as the list shows it; null while a turn is still running (notify.js turnToken). */
export function turnToken(pending, messageCount, updatedAt) {
  return pending ? null : `${messageCount}@${updatedAt ?? ''}`;
}

/**
 * Whether a chat's list entry may hold a reply worth fetching. A running turn is never news yet.
 * Nothing is news on the first poll after sign-in (primed false), so history is not replayed;
 * after that a chat never seen before is news once settled (a new chat whose first reply landed
 * between two polls). A known chat's changed token is news only if a turn ended since (it was
 * running, token '') or messages were added: a rename, archive or folder move bumps updated_at
 * alone.
 */
export function isNews(prior, token, count, primed) {
  if (token == null) return false;
  if (!prior) return primed;
  if (token === prior.token) return false;
  return prior.token === '' || count !== prior.count;
}

/** The notification text: whitespace collapsed, capped like the web toast (notify.js notificationBody). */
export function body(text, error) {
  const raw = typeof text === 'string' && text.trim() ? text : error;
  const flat = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!flat) return FALLBACK_BODY;
  if (flat.length <= BODY_MAX) return flat;
  return `${flat.slice(0, BODY_MAX - 1)}…`;
}

/** The notification title: the chat title, trimmed and capped (empty = the app name). */
export function title(raw, appName = 'Getway Chat') {
  const t = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!t) return appName;
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** The reply a finished turn left (notify.js settledReply): the last message, if the agent's and done. */
export function settledReply(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (!last || typeof last !== 'object' || last.role === 'user' || last.status === 'pending') return null;
  return last;
}
