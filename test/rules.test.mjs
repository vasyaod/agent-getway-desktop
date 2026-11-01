import test from 'node:test';
import assert from 'node:assert/strict';
import { BODY_MAX, FALLBACK_BODY, body, isNews, settledReply, title, turnToken } from '../src/rules.js';

test('turnToken: null while running, count@updated_at once settled', () => {
  assert.equal(turnToken(true, 3, 'x'), null);
  assert.equal(turnToken(false, 3, '2026-11-01T00:00:00Z'), '3@2026-11-01T00:00:00Z');
  assert.equal(turnToken(false, 0, null), '0@');
});

test('isNews: same rules as the Android app (ReplyRulesTest)', () => {
  const seen = { token: '2@a', count: 2, replyId: 'r1' };
  assert.equal(isNews(seen, null, 2, true), false, 'a running turn is never news');
  assert.equal(isNews(null, '1@a', 1, false), false, 'first poll after sign-in replays nothing');
  assert.equal(isNews(null, '1@a', 1, true), true, 'a chat never seen, once primed');
  assert.equal(isNews(seen, '2@a', 2, true), false, 'unchanged');
  assert.equal(isNews(seen, '2@b', 2, true), false, 'rename/archive/folder: updated_at alone');
  assert.equal(isNews(seen, '4@b', 4, true), true, 'messages were added');
  assert.equal(isNews({ token: '', count: 2, replyId: '' }, '2@b', 2, true), true, 'it was running');
});

test('body: collapsed, capped at 180, error as fallback, then the fixed text', () => {
  assert.equal(body('  hello\n\n world ', null), 'hello world');
  assert.equal(body('', 'boom'), 'boom');
  assert.equal(body(null, null), FALLBACK_BODY);
  const long = body('x'.repeat(500), null);
  assert.equal(long.length, BODY_MAX);
  assert.ok(long.endsWith('…'));
});

test('title: chat title capped at 80, else the app name', () => {
  assert.equal(title(' Deploy  check '), 'Deploy check');
  assert.equal(title(''), 'Getway Chat');
  assert.equal(title('t'.repeat(100)).length, 80);
});

test('settledReply: the last message, if the agent\'s and done', () => {
  assert.equal(settledReply([]), null);
  assert.equal(settledReply(null), null);
  assert.equal(settledReply([{ role: 'user', text: 'hi' }]), null);
  assert.equal(settledReply([{ role: 'assistant', status: 'pending' }]), null);
  const r = { id: 'm2', role: 'assistant', text: 'done' };
  assert.equal(settledReply([{ role: 'user' }, r]), r);
});
