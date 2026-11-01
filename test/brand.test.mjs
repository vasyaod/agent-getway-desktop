import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);

test('the icon is the Getway Chat registry PNG, and every derived icon is there', () => {
  const brand = JSON.parse(readFileSync(new URL('resources/brand.json', root)));
  assert.equal(brand.name, 'Getway Chat');
  const sha = createHash('sha256').update(readFileSync(new URL('resources/icon.png', root))).digest('hex');
  assert.equal(sha, brand.sha256);
  for (const f of ['build/icon.png', 'src/assets/icon.png', 'src/assets/tray.png', 'src/assets/tray@2x.png',
    'src/assets/tray-unread.png', 'src/assets/tray-unread@2x.png', 'src/assets/overlay-unread.png']) {
    assert.ok(existsSync(new URL(f, root)), f);
  }
  const css = readFileSync(new URL('src/start/styles.css', root), 'utf8');
  assert.match(css, new RegExp(brand.color, 'i'), 'the start page accent is the brand colour');
});
