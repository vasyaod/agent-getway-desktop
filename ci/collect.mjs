// After one `electron-builder --<platform> --<arch>`: copies that build's installers from dist/
// into out/ under the fixed names the README links (/releases/latest/download/<name>), and fails
// unless exactly the expected ones are there. electron-builder spells the arch per format
// (AppImage x86_64, deb amd64, the rest x64), so ${arch} alone does not give stable names.
//
//   node ci/collect.mjs <mac|win|linux> <x64|arm64> [dist] [out]
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMATS = { mac: ['dmg', 'zip'], win: ['exe'], linux: ['AppImage', 'deb'] };
const ARCH = { x64: 'x64', x86_64: 'x64', amd64: 'x64', arm64: 'arm64', aarch64: 'arm64' };

/** GetwayChat-<os>-<arch>.<ext> for one of our build outputs, or null for anything else. */
export function canonicalName(file) {
  const m = /^GetwayChat-(mac|win|linux)-([A-Za-z0-9_]+)\.(dmg|zip|exe|AppImage|deb)$/.exec(file);
  if (!m || !ARCH[m[2]]) return null;
  return `GetwayChat-${m[1]}-${ARCH[m[2]]}.${m[3]}`;
}

export const expected = (platform, arch) => FORMATS[platform].map((ext) => `GetwayChat-${platform}-${arch}.${ext}`);

export function collect(platform, arch, dist = 'dist', out = 'out') {
  if (!FORMATS[platform] || !['x64', 'arm64'].includes(arch)) throw new Error(`usage: collect.mjs <mac|win|linux> <x64|arm64>`);
  mkdirSync(out, { recursive: true });
  const got = [];
  for (const f of readdirSync(dist)) {
    const name = canonicalName(f);
    if (!name) continue;
    if (!expected(platform, arch).includes(name)) throw new Error(`unexpected build output ${f} (${name})`);
    copyFileSync(path.join(dist, f), path.join(out, name));
    got.push(name);
  }
  const missing = expected(platform, arch).filter((n) => !got.includes(n));
  if (missing.length) throw new Error(`missing build outputs: ${missing.join(', ')}`);
  return got.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [platform, arch, dist, out] = process.argv.slice(2);
  console.log(collect(platform, arch, dist, out).join('\n'));
}
