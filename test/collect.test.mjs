import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalName, collect } from '../ci/collect.mjs';

test('canonicalName: one spelling per arch, nothing else taken', () => {
  assert.equal(canonicalName('GetwayChat-linux-x86_64.AppImage'), 'GetwayChat-linux-x64.AppImage');
  assert.equal(canonicalName('GetwayChat-linux-amd64.deb'), 'GetwayChat-linux-x64.deb');
  assert.equal(canonicalName('GetwayChat-linux-aarch64.AppImage'), 'GetwayChat-linux-arm64.AppImage');
  assert.equal(canonicalName('GetwayChat-mac-arm64.dmg'), 'GetwayChat-mac-arm64.dmg');
  assert.equal(canonicalName('GetwayChat-win-x64.exe'), 'GetwayChat-win-x64.exe');
  assert.equal(canonicalName('GetwayChat-win-x64.exe.blockmap'), null);
  assert.equal(canonicalName('builder-debug.yml'), null);
  assert.equal(canonicalName('GetwayChat-linux-armv7l.deb'), null);
});

test('collect copies exactly the expected set and fails on gaps or strays', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'collect-'));
  const dist = path.join(dir, 'dist');
  const out = path.join(dir, 'out');
  mkdirSync(dist);
  for (const f of ['GetwayChat-linux-x86_64.AppImage', 'GetwayChat-linux-amd64.deb', 'builder-debug.yml']) writeFileSync(path.join(dist, f), 'x');
  assert.deepEqual(collect('linux', 'x64', dist, out), ['GetwayChat-linux-x64.AppImage', 'GetwayChat-linux-x64.deb']);
  assert.deepEqual(readdirSync(out).sort(), ['GetwayChat-linux-x64.AppImage', 'GetwayChat-linux-x64.deb']);
  assert.throws(() => collect('linux', 'arm64', dist, out), /unexpected/);
  assert.throws(() => collect('mac', 'x64', path.join(dir, 'out'), path.join(dir, 'o2')), /unexpected/);
  const empty = path.join(dir, 'empty');
  mkdirSync(empty);
  assert.throws(() => collect('win', 'x64', empty, out), /missing build outputs: GetwayChat-win-x64.exe/);
});
