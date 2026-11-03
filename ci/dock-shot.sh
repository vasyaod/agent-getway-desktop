#!/usr/bin/env bash
# macOS only, after the native build: screenshots of the Dock with the latest release ("before")
# and this build ("after", in smoke mode, so with the unread badge "2") running side by side,
# for a person to look at (issue #5). Uploaded as the `dock-mac` artifact; never a pass/fail.
#
#   ci/dock-shot.sh      after `electron-builder --mac --arm64`; writes $RUNNER_TEMP/dock/*.png
set -uo pipefail
work="${RUNNER_TEMP:-/tmp}"
shots="$work/dock"
mkdir -p "$shots"
app="$(ls -d dist/mac*/'Getway Chat.app' | head -n1)"

old="$work/old-release"
rm -rf "$old" && mkdir -p "$old"
if curl -fsSL -o "$old/app.zip" \
    https://github.com/vasyaod/agent-getway-desktop/releases/latest/download/GetwayChat-mac-arm64.zip \
  && ditto -x -k "$old/app.zip" "$old"; then
  # Its own profile, so its single-instance lock is not the build's.
  "$old/Getway Chat.app/Contents/MacOS/Getway Chat" --user-data-dir="$work/old-profile" &
  oldpid=$!
  sleep 8
else
  echo "no latest release to compare with: the shots show this build only"
  oldpid=
fi

GETWAY_CHAT_SMOKE="$shots/smoke.json" "$app/Contents/MacOS/Getway Chat" &
newpid=$!
for i in $(seq 1 10); do
  sleep 2
  kill -0 "$newpid" 2>/dev/null || break
  screencapture -x "$shots/dock-$i.png" || true
done
wait "$newpid" || true
[ -n "$oldpid" ] && kill "$oldpid" 2>/dev/null
ls -l "$shots"
exit 0
