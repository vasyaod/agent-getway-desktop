import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, openChatId } from '../src/navigation.js';

test('classify: the gateway loads, auth.f-proj.com is turned back, the rest goes out or nowhere', () => {
  assert.equal(classify('https://agent-getway.f-proj.com/#/chat'), 'gateway');
  assert.equal(classify('https://AGENT-GETWAY.f-proj.com/api/x'), 'gateway');
  assert.equal(classify('http://agent-getway.f-proj.com/'), 'external', 'plain http is not the gateway');
  assert.equal(classify('https://user:pw@agent-getway.f-proj.com/'), 'external');
  assert.equal(classify('https://auth.f-proj.com/logout?rd=x'), 'signed_out');
  assert.equal(classify('https://auth.f-proj.com/login?rd=x'), 'expired');
  assert.equal(classify('https://auth.f-proj.com/'), 'expired');
  assert.equal(classify('https://agent-swarm.f-proj.com/session/1'), 'external');
  assert.equal(classify('https://github.com/'), 'external');
  assert.equal(classify('mailto:a@b.c'), 'external');
  assert.equal(classify('https://agent-getway.f-proj.com.evil.example/'), 'external');
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'com.fproj.getway://chat/1', 'nonsense']) {
    assert.equal(classify(u), 'block', u);
  }
});

test('openChatId: only a 24-hex chat id on the gateway', () => {
  const id = '0123456789abcdef01234567';
  assert.equal(openChatId(`https://agent-getway.f-proj.com/#/chat/${id}`), id);
  assert.equal(openChatId(`https://agent-getway.f-proj.com/#/chat/${id}?x=1`), id);
  assert.equal(openChatId('https://agent-getway.f-proj.com/#/chat'), null);
  assert.equal(openChatId('https://agent-getway.f-proj.com/#/chat/nothex'), null);
  assert.equal(openChatId(`https://evil.example/#/chat/${id}`), null);
});
