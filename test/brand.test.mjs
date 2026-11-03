import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const root = new URL('../', import.meta.url);

test('the icon is the Getway Chat registry PNG, and every derived icon is there', () => {
  const brand = JSON.parse(readFileSync(new URL('resources/brand.json', root)));
  assert.equal(brand.name, 'Getway Chat');
  const sha = createHash('sha256').update(readFileSync(new URL('resources/icon.png', root))).digest('hex');
  assert.equal(sha, brand.sha256);
  const trays = ['tray', 'tray-unread'].flatMap((t) => [`${t}.png`, `${t}@1.5x.png`, `${t}@2x.png`,
    `${t}Template.png`, `${t}Template@2x.png`]).map((f) => `src/assets/${f}`);
  for (const f of ['build/icon.png', 'build/icon.ico', 'build/icon-mac.png', 'src/assets/icon.png', ...trays, 'src/assets/overlay-unread.png']) {
    assert.ok(existsSync(new URL(f, root)), f);
  }
  const css = readFileSync(new URL('src/start/styles.css', root), 'utf8');
  assert.match(css, new RegExp(brand.color, 'i'), 'the start page accent is the brand colour');
});

/** The entries of an .icns file: {type: png bytes}. */
function icns(buf) {
  assert.equal(buf.toString('latin1', 0, 4), 'icns');
  assert.equal(buf.readUInt32BE(4), buf.length);
  const out = {};
  for (let at = 8; at < buf.length;) {
    const len = buf.readUInt32BE(at + 4);
    out[buf.toString('latin1', at, at + 4)] = buf.subarray(at + 8, at + len);
    at += len;
  }
  return out;
}

/** An 8-bit RGBA, non-interlaced PNG (what Pillow writes): {width, height, alpha(x, y)}. */
function png(buf) {
  assert.equal(buf.toString('latin1', 1, 4), 'PNG');
  let width = 0, height = 0;
  const idat = [];
  for (let at = 8; at < buf.length;) {
    const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.deepEqual([data[8], data[9], data[12]], [8, 6, 0], 'RGBA, 8 bit, not interlaced');
    }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), row = width * 4, px = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (row + 1)], src = raw.subarray(y * (row + 1) + 1, (y + 1) * (row + 1));
    for (let i = 0; i < row; i++) {
      const a = i >= 4 ? px[y * row + i - 4] : 0, b = y ? px[(y - 1) * row + i] : 0;
      const c = i >= 4 && y ? px[(y - 1) * row + i - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      px[y * row + i] = (src[i] + pred) & 255;
    }
  }
  return { width, height, alpha: (x, y) => px[y * row + x * 4 + 3] };
}

test('the macOS icon is a full .icns set, a rounded tile on Apple\'s 824-in-1024 grid', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root)));
  assert.equal(pkg.build.mac.icon, 'build/icon.icns');
  assert.equal(pkg.build.win.icon, 'build/icon.ico');
  const entries = icns(readFileSync(new URL('build/icon.icns', root)));
  // 16 to 512 pt, @1x and @2x.
  const want = { icp4: 16, icp5: 32, ic11: 32, ic12: 64, ic07: 128, ic13: 256, ic08: 256, ic14: 512, ic09: 512, ic10: 1024 };
  for (const [type, px] of Object.entries(want)) {
    assert.ok(entries[type], type);
    const img = png(entries[type]);
    assert.deepEqual([img.width, img.height], [px, px], type);
  }
  const big = png(entries.ic10);
  const opaque = (pts) => pts.filter(([x, y]) => big.alpha(x, y) === 255);
  const across = opaque(Array.from({ length: 1024 }, (_, x) => [x, 512]));
  const down = opaque(Array.from({ length: 1024 }, (_, y) => [512, y]));
  // The tile: 824 px from 100 to 923, with transparent padding all round.
  assert.deepEqual([across[0][0], across.at(-1)[0], down[0][1], down.at(-1)[1]], [101, 923, 101, 923]);
  for (const [x, y] of [[0, 0], [1023, 0], [50, 512], [512, 50], [980, 512]]) assert.equal(big.alpha(x, y), 0, `${x},${y}`);
  // Rounded corners: the tile's bounding box corners are empty, the shadow only falls below it.
  for (const [x, y] of [[110, 110], [913, 110]]) assert.equal(big.alpha(x, y), 0, `corner ${x},${y}`);
  assert.ok(big.alpha(512, 935) > 0 && big.alpha(512, 935) < 128, 'a soft drop shadow below the tile');
  assert.equal(big.alpha(512, 990), 0);
});
