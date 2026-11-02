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
  const trays = ['tray', 'tray-unread'].flatMap((t) => [`${t}.png`, `${t}@1.5x.png`, `${t}@2x.png`,
    `${t}Template.png`, `${t}Template@2x.png`]).map((f) => `src/assets/${f}`);
  for (const f of ['build/icon.png', 'src/assets/icon.png', ...trays, 'src/assets/overlay-unread.png']) {
    assert.ok(existsSync(new URL(f, root)), f);
  }
  const css = readFileSync(new URL('src/start/styles.css', root), 'utf8');
  assert.match(css, new RegExp(brand.color, 'i'), 'the start page accent is the brand colour');
});
