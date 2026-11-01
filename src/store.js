// Small JSON files under the app's userData dir (window bounds, what the reply watcher has seen).
// Never the token: that lives in the session's cookie jar only (main.js).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function readJson(file, fallback) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Write-then-rename, so a crash mid-write leaves the old file, not half a new one. */
export function writeJson(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* a full or read-only disk loses this state, nothing worse */ }
}
