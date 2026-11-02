#!/usr/bin/env bash
# Launches the packaged app on this runner in its smoke mode (src/main.js smoke()) and checks
# what it reports: the window and start page with its bridge, the tray and its icons (templates
# on macOS), the UA marker, and the sign-in guard turning a signed-out visit to
# agent-getway.f-proj.com back to the start page.
# The app runs on a throwaway profile and exits by itself: in seconds, or, while the gateway
# answers 5xx or cannot be reached (agent-getway's Recreate rollout), after retrying it for up
# to 12 minutes (src/main.js SMOKE_RETRY_MS); each attempt has 60 s.
#
#   ci/smoke.sh <linux|mac|win>      after `electron-builder` + `ci/collect.mjs`
set -euo pipefail
platform="$1"
report="${RUNNER_TEMP:-/tmp}/getway-chat-smoke.json"
rm -f "$report"
export GETWAY_CHAT_SMOKE="$report"

case "$platform" in
  linux)
    # The AppImage itself, as shipped. No FUSE on the runner: extract-and-run. The runner's
    # AppArmor forbids the unprivileged user namespaces Chromium's sandbox wants: --no-sandbox.
    chmod +x out/GetwayChat-linux-x64.AppImage
    xvfb-run -a out/GetwayChat-linux-x64.AppImage --appimage-extract-and-run --no-sandbox || true
    ;;
  mac)
    app="$(ls -d dist/mac*/'Getway Chat.app' | head -n1)"
    "$app/Contents/MacOS/Getway Chat" || true
    ;;
  win)
    "dist/win-unpacked/Getway Chat.exe" || true
    ;;
  *) echo "usage: $0 <linux|mac|win>"; exit 2 ;;
esac

[ -s "$report" ] || { echo "the app wrote no smoke report"; exit 1; }
cat "$report"; echo
node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!r.ok) { console.error(`smoke failed at: ${r.step}`); process.exit(1); }
  console.log(`smoke ok: Getway Chat ${r.version} on ${r.platform}/${r.arch}, Electron ${r.electron}` +
    `, gateway retries: ${(r.attempts || []).length}`);' "$report"
