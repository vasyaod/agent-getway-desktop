// The window's size and position, remembered across restarts. Pure, so `npm test` covers it:
// main.js reads/writes the file and hands in screen.getAllDisplays().

export const DEFAULT = { width: 1100, height: 800 };
export const MIN = { width: 360, height: 480 };

const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);

/**
 * The bounds to open the window with: the saved ones if they are sane and at least 100x50 px of
 * the window's top lands on a display that is connected now (a monitor unplugged since would
 * otherwise open the window off screen); else the default size, centred by Electron.
 */
export function restore(saved, displays) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const width = Math.max(MIN.width, num(s.width) ?? DEFAULT.width);
  const height = Math.max(MIN.height, num(s.height) ?? DEFAULT.height);
  const out = { width, height, maximized: s.maximized === true };
  const x = num(s.x);
  const y = num(s.y);
  if (x == null || y == null) return out;
  const top = { x, y, width, height: Math.min(height, 50) };
  const visible = (displays || []).some(({ workArea: a }) => a
    && overlap(top.x, top.width, a.x, a.width) >= Math.min(100, top.width)
    && overlap(top.y, top.height, a.y, a.height) >= top.height);
  if (!visible) return out;
  return { ...out, x, y };
}

function overlap(a, aLen, b, bLen) {
  return Math.max(0, Math.min(a + aLen, b + bLen) - Math.max(a, b));
}

/** What to save: the normal (un-maximized) bounds plus whether it was maximized. */
export function snapshot(normalBounds, maximized) {
  const { x, y, width, height } = normalBounds;
  return { x, y, width, height, maximized: !!maximized };
}
