// Where the app points, and the names it signs in under. Pure constants, no Electron.

/** agent-getway's web chat. The window shows this origin and nothing else. */
export const GATEWAY = 'https://agent-getway.f-proj.com/';
export const GATEWAY_HOST = 'agent-getway.f-proj.com';
export const CHAT_URL = `${GATEWAY}#/chat`;

/** auth.f-proj.com, the SSO for every *.f-proj.com service (auth-service README "OAuth for apps"). */
export const AUTH = 'https://auth.f-proj.com';
export const AUTH_HOST = 'auth.f-proj.com';

/**
 * Free text: the consent page shows it and lists it under Connected apps, and /token must repeat
 * it string for string. Its own name, so it can be revoked apart from the Android app.
 */
export const CLIENT_ID = 'Getway Chat Desktop';

/** The cookie auth.f-proj.com's SSO reads on every *.f-proj.com host (agent-getway server/src/sso.py). */
export const COOKIE = 'fproj_auth';
export const COOKIE_DOMAIN = '.f-proj.com';

/**
 * Appended to the user agent. agent-getway's dashboard then shows the chat and nothing else, as it
 * does in the Android app (agent-getway ui/src/appMode.js, agent-getway#136).
 */
export const UA_MARKER = 'AgentGetwayChat/1';

/** How often the reply watcher reads the chat list while signed in. */
export const POLL_MS = 30_000;
