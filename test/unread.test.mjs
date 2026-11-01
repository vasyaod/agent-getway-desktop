import test from 'node:test';
import assert from 'node:assert/strict';
import { Unread, trayTooltip } from '../src/unread.js';

test('Unread counts chats, not replies, and reports only changes', () => {
  const seen = [];
  const u = new Unread((n) => seen.push(n));
  u.add('a'); u.add('a'); u.add('b');
  u.read('a'); u.read('zzz');
  u.clear(); u.clear();
  assert.deepEqual(seen, [1, 2, 1, 0]);
  assert.equal(trayTooltip(0), 'Getway Chat');
  assert.equal(trayTooltip(1), 'Getway Chat: 1 unread reply');
  assert.equal(trayTooltip(3), 'Getway Chat: 3 unread replies');
});
