import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, isGatewayDownload, openChatId } from '../src/navigation.js';

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

test('classify: a file the agent sent is a download in the app, never the system browser', () => {
  const file = 'https://agent-getway.f-proj.com/api/web/chats/0123456789abcdef01234567/files/f1';
  assert.equal(classify(file), 'download');
  assert.equal(classify(`${file}?x=1#y`), 'download');
  assert.equal(classify('https://AGENT-GETWAY.f-proj.com/api/web/chats/c/files/f'), 'download');
  assert.equal(classify('https://agent-getway.f-proj.com/api/web/chats/c/x/../files/f'), 'download', 'the path as the server sees it');
  for (const u of [
    'https://agent-getway.f-proj.com/api/web/chats/c/files', // the list, not a file
    'https://agent-getway.f-proj.com/api/web/chats/c/files/',
    'https://agent-getway.f-proj.com/api/web/chats/c/files/f/more',
    'https://agent-getway.f-proj.com/api/web/chats/c/messages',
    'https://agent-getway.f-proj.com/#/api/web/chats/c/files/f', // the hash is the page's route
  ]) assert.equal(classify(u), 'gateway', u);
  assert.equal(classify('http://agent-getway.f-proj.com/api/web/chats/c/files/f'), 'external', 'plain http is not the gateway');
  assert.equal(classify('https://user:pw@agent-getway.f-proj.com/api/web/chats/c/files/f'), 'external');
  assert.equal(classify('https://evil.example/api/web/chats/c/files/f'), 'external');
  assert.equal(openChatId(file), null);
});

test('isGatewayDownload: the gateway and its page\'s blobs; nothing else', () => {
  assert.equal(isGatewayDownload('https://agent-getway.f-proj.com/api/web/chats/c/files/f'), true);
  assert.equal(isGatewayDownload('https://agent-getway.f-proj.com/export.csv'), true);
  assert.equal(isGatewayDownload('blob:https://agent-getway.f-proj.com/6c1f0d6e-1d3b-4f5e-9a51-2b0b6c8e7f10'), true);
  for (const u of ['https://evil.example/x.pdf', 'blob:https://evil.example/1', 'blob:null/1', 'data:application/pdf,x',
    'http://agent-getway.f-proj.com/api/web/chats/c/files/f', 'https://auth.f-proj.com/x', 'file:///etc/passwd', 'nonsense']) {
    assert.equal(isGatewayDownload(u), false, u);
  }
});
