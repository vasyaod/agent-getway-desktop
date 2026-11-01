// Which chats hold a reply you have not looked at yet: the source of the tray/dock badge.
// A chat becomes unread when its reply is notified, and read when it is on screen in a focused
// window, or when you click its notification. Pure, so `npm test` covers it.

export class Unread {
  constructor(onChange = () => {}) {
    this.ids = new Set();
    this.onChange = onChange;
  }

  get count() { return this.ids.size; }

  add(id) {
    if (!id || this.ids.has(id)) return;
    this.ids.add(id);
    this.onChange(this.count);
  }

  read(id) {
    if (!id || !this.ids.delete(id)) return;
    this.onChange(this.count);
  }

  clear() {
    if (this.ids.size === 0) return;
    this.ids.clear();
    this.onChange(0);
  }
}

/** The tray tooltip for `n` unread chats. */
export const trayTooltip = (n) => (n > 0
  ? `Getway Chat: ${n} unread ${n === 1 ? 'reply' : 'replies'}`
  : 'Getway Chat');
