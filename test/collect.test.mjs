import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalName, collect, expected } from '../ci/collect.mjs';

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

// dist/ exactly as `electron-builder --<os> --x64` left it in the red staging run
// (agent-getway actions run 41361793403) while package.json targets listed ["x64","arm64"].
const TWO_ARCH_DIST = {
  linux: ['GetwayChat-linux-x86_64.AppImage', 'GetwayChat-linux-arm64.AppImage', 'GetwayChat-linux-amd64.deb', 'GetwayChat-linux-arm64.deb'],
  mac: ['GetwayChat-mac-x64.zip', 'GetwayChat-mac-x64.dmg', 'GetwayChat-mac-arm64.zip', 'GetwayChat-mac-arm64.dmg', 'GetwayChat-mac-x64.dmg.blockmap', 'GetwayChat-mac-arm64.zip.blockmap'],
  win: ['GetwayChat-win.exe', 'GetwayChat-win-x64.exe', 'GetwayChat-win-arm64.exe', 'GetwayChat-win.exe.blockmap', 'GetwayChat-win-x64.exe.blockmap', 'GetwayChat-win-arm64.exe.blockmap'],
};

function distOf(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'collect-'));
  const dist = path.join(dir, 'dist');
  mkdirSync(dist);
  for (const f of files) writeFileSync(path.join(dist, f), 'x');
  return { dist, out: path.join(dir, 'out') };
}

test('collect refuses a dist holding both arches or a multi-arch installer, naming the cause', () => {
  for (const [platform, files] of Object.entries(TWO_ARCH_DIST)) {
    for (const arch of ['x64', 'arm64']) {
      const { dist, out } = distOf(files);
      assert.throws(() => collect(platform, arch, dist, out), /unexpected build output .*package\.json "build" targets must leave the arch to the CLI/, `${platform}/${arch}`);
    }
  }
  // The arch-less NSIS installer alone is refused too, not silently skipped.
  const { dist, out } = distOf(['GetwayChat-win.exe', 'GetwayChat-win-x64.exe']);
  assert.throws(() => collect('win', 'x64', dist, out), /unexpected build output GetwayChat-win\.exe:/);
});

test('collect takes the one-arch dist each `--<os> --<arch>` pass builds once targets leave the arch to the CLI', () => {
  const pass = (arch) => ({
    linux: TWO_ARCH_DIST.linux.filter((f) => f.includes(arch === 'x64' ? (f.endsWith('.deb') ? 'amd64' : 'x86_64') : 'arm64')),
    mac: TWO_ARCH_DIST.mac.filter((f) => f.includes(`-${arch}.`)),
    win: TWO_ARCH_DIST.win.filter((f) => f.includes(`-${arch}.`)),
  });
  for (const arch of ['x64', 'arm64']) {
    for (const [platform, files] of Object.entries(pass(arch))) {
      const { dist, out } = distOf(files);
      assert.deepEqual(collect(platform, arch, dist, out), expected(platform, arch).sort(), `${platform}/${arch}`);
      assert.deepEqual(readdirSync(out).sort(), expected(platform, arch).sort());
    }
  }
});

test('package.json build targets name no arch, so build.yml\'s --x64/--arm64 loop builds one arch per pass', () => {
  const { build } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const platform of ['mac', 'win', 'linux']) {
    for (const t of [].concat(build[platform].target)) {
      assert.equal(typeof t, 'string', `${platform} target ${JSON.stringify(t)} must be a bare format name`);
    }
    assert.equal(build[platform].arch, undefined, `${platform}.arch`);
  }
});
