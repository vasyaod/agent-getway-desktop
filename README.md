# agent-getway-desktop

**Getway Chat** for macOS, Windows and Linux: [agent-getway](https://github.com/vasyaod/agent-getway)'s
web chat in its own window. It does on the desktop what
[agent-getway-phone](https://github.com/vasyaod/agent-getway-phone) does on Android. You sign in
once with your [auth.f-proj.com](https://auth.f-proj.com) account, and it stays signed in across
restarts. It runs in the tray, notifies you of new agent replies, and badges the unread ones.

## Download

| OS | Intel / x64 | Apple Silicon / ARM64 |
|---|---|---|
| macOS (disk image) | [GetwayChat-mac-x64.dmg](https://github.com/vasyaod/agent-getway-desktop/releases/latest/download/GetwayChat-mac-x64.dmg) | [GetwayChat-mac-arm64.dmg](https://github.com/vasyaod/agent-getway-desktop/releases/latest/download/GetwayChat-mac-arm64.dmg) |
| macOS (zip) | [GetwayChat-mac-x64.zip](https://github.com/vasyaod/agent-getway-desktop/releases/latest/download/GetwayChat-mac-x64.zip) | [GetwayChat-mac-arm64.zip](https://github.com/vasyaod/agent-getway-desktop/releases/latest/download/GetwayChat-mac-arm64.zip) |
| Windows (installer) | [GetwayChat-win-x64.exe](https://github.com/vasyaod/agent-getway-desktop/releases/latest/download/GetwayChat-win-x64.exe) | [GetwayChat-win-arm64.exe](https://github.com/vasyaod/agent-getway-desktop/releases/latest/download/GetwayChat-win-arm64.exe) |
| Linux (AppImage) | [GetwayChat-linux-x64.AppImage](https://github.com/vasyaod/agent-getway-desktop/releases/latest/download/GetwayChat-linux-x64.AppImage) | [GetwayChat-linux-arm64.AppImage](https://github.com/vasyaod/agent-getway-desktop/releases/latest/download/GetwayChat-linux-arm64.AppImage) |
| Linux (Debian/Ubuntu) | [GetwayChat-linux-x64.deb](https://github.com/vasyaod/agent-getway-desktop/releases/latest/download/GetwayChat-linux-x64.deb) | [GetwayChat-linux-arm64.deb](https://github.com/vasyaod/agent-getway-desktop/releases/latest/download/GetwayChat-linux-arm64.deb) |

Every release is on the [Releases](https://github.com/vasyaod/agent-getway-desktop/releases) page.

The builds are **not code-signed**. Each OS asks once:

- **macOS:** the app is not notarized, so the first open says it "cannot be opened" or "is
  damaged". Drag it to Applications, then run
  `xattr -dr com.apple.quarantine "/Applications/Getway Chat.app"` once, or right-click it
  and choose **Open**.
- **Windows:** SmartScreen says "Windows protected your PC". Choose **More info**, then
  **Run anyway**. The installer installs for your user only and needs no admin rights.
- **Linux:** run `chmod +x GetwayChat-linux-*.AppImage` first, or install the deb with
  `sudo apt install ./GetwayChat-linux-x64.deb`. On GNOME the tray icon needs the
  AppIndicator extension. Without it, launching the app again brings the window back.

### Verify a download

Each release carries `SHA256SUMS`, signed keyless with [cosign](https://github.com/sigstore/cosign)
by this repo's `build.yml` on `main`, plus a GitHub build provenance attestation for every file:

```bash
cosign verify-blob SHA256SUMS --bundle SHA256SUMS.sigstore.json \
  --certificate-identity https://github.com/vasyaod/agent-getway-desktop/.github/workflows/build.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify GetwayChat-linux-x64.AppImage -R vasyaod/agent-getway-desktop
```

(`--signature SHA256SUMS.sig --certificate SHA256SUMS.pem` works in place of `--bundle`.)

## What it does

- **No chat code here.** The window loads `https://agent-getway.f-proj.com/` itself, so the app
  always runs the chat the gateway is deployed with: folders, archive, images, voice messages
  and commands. The app appends `AgentGetwayChat/1` to its user agent. When the gateway sees
  it, it hides everything but the chat, as it does for the Android app (agent-getway
  `ui/src/appMode.js`, agent-getway#136).
- **Links to other sites** (the swarm session link, GitHub, anything not
  agent-getway.f-proj.com) open in your browser. So does anything the chat opens in a new tab.
  Nothing else can be navigated to inside the window (`src/navigation.js`).
- **The window** remembers its size, position and maximized state (`window.json` in the app's
  data folder). If the monitor it was on is gone, it opens centred instead (`src/windowstate.js`).
  Closing the window hides it. The app keeps running in the tray, or in the dock on macOS.
  **Quit Getway Chat** is in the tray menu, and on macOS also in the app menu.
- **The microphone** is the only device the chat may use (voice messages), and only
  agent-getway.f-proj.com may ask for it. macOS asks once.

## How sign-in works

The app uses auth.f-proj.com's OAuth flow for apps (authorization code + PKCE S256,
auth-service#23), the way a desktop app should do it (RFC 8252). `src/oauth.js`:

1. **Sign in** on the start page opens
   `https://auth.f-proj.com/authorize?…&client_id=Getway%20Chat%20Desktop&redirect_uri=http://127.0.0.1:<port>/callback…`
   in **your browser**. You are usually signed in there already. If not, sign in with your
   password, or with Google, which works because it is a real browser. Then **Allow**.
2. For that one answer, the app listens on `127.0.0.1` on a random port. auth-service accepts
   loopback redirects on any port. The app checks `state`, then trades the code for an app
   token `fpu_…` (30 days) at `POST /token`. A request to the port without the right `state`
   is refused and does not end the sign-in. After one answer, or after 5 minutes, the port
   closes.
3. The token is kept in **one place**: the app's cookie jar, as the `fproj_auth` cookie for
   `.f-proj.com` (Secure, HttpOnly, SameSite=Lax, expiring with the token). Electron keeps that
   jar across restarts, encrypted with the OS keychain: Keychain on macOS, DPAPI on Windows,
   libsecret/KWallet on Linux where there is one. No page can read the cookie, no file of the
   app's own holds the token, and it is never logged.
4. The window goes to `https://agent-getway.f-proj.com/#/chat`. The gateway's SSO
   (`server/src/sso.py`) asks auth.f-proj.com about that cookie as it would for any browser
   session. The chat's API calls are the page's own same-origin fetches.
5. **Leaving:** the gateway sends the browser to auth.f-proj.com in two cases: its **Sign out**
   link, and a session that ended (revoked under *Connected apps*, expired, or a password
   change). The app catches every navigation and redirect to auth.f-proj.com and shows its
   start page instead:
   - `/logout…` revokes this app's token (`POST /logout` with the bearer, which signs out only
     this app) and removes the cookie;
   - anything else just removes the cookie.

   Either way, **Sign in** is offered again. auth.f-proj.com's own pages never load inside the
   window.

At launch the app skips the start page if it holds a token with more than a minute left. If
the gateway cannot be reached, the start page says so and offers **Try again**.

*Connected apps* on auth.f-proj.com lists the app as **Getway Chat Desktop**, apart from the
Android app, so either one can be revoked on its own.

## Notifications and the unread badge

While you are signed in, the app reads `GET /api/web/chats` every 30 s with the token as
`Authorization: Bearer`, which the gateway's SSO accepts from apps (`src/poller.js`). For each
chat whose turn just settled, it reads that chat's messages and shows one native notification
for the agent's last message. The title is the chat's title, and the text is a preview of the
reply. The rules are the Android app's `ReplyRules.java`, ported to `src/rules.js`:

- **No first-run flood:** the first poll after sign-in only records what is already there.
- **No noise:** renaming, archiving or moving a chat does not notify, and archived chats never
  notify.
- **One per chat:** a newer reply replaces the chat's older notification.
- **The open chat:** no notification for the chat on screen in the focused window. Other chats
  still notify while the window is in front, but silently.
- **Clicking a notification** brings the window up on that chat.
- **One notifier:** the chat page's own browser notifications are switched off inside the app,
  so a reply is never shown twice.

**The unread badge** counts chats with a reply you have not looked at. A chat counts as read
once it is on screen in the focused window, or when you click its notification. The badge
shows as a red dot on the tray icon (its tooltip gives the count), the count on the macOS dock
icon, a dot overlay on the Windows taskbar button, and the count on Linux launchers that show
badges (Unity, Dash to Dock). Signing out clears it.

A 401 means the sign-in ended: the app removes the cookie and shows **Sign in**.

## Develop

Needs Node 22.

```bash
npm install
npm test          # unit tests + src/main.js against a fake Electron (test/fake-electron/)
npm start         # runs the app
npm run dist      # electron-builder for this OS → dist/
```

`npm test` needs no Electron binary (`ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` is enough).
`test/main.test.mjs` runs the real `src/main.js` against a recording stand-in for Electron's
API. It covers the sign-in round trip over a real loopback port, the cookie's flags,
navigation and permission rules, notifications, the badge, sign-out and window state.

`GETWAY_CHAT_SMOKE=<file>` starts the app in its launch check (`smoke()` in `src/main.js`,
run by `ci/smoke.sh`). It uses a throwaway profile. It checks the window, the start page and
its bridge, the tray and the UA marker, and that a signed-out visit to the gateway is turned
back to the start page. It writes the result to `<file>` and exits. If 60 s pass first, the
result also says what the app knew then: `lastGuard`, the URL on screen, whether it was still
loading, a `trace` of the main-frame navigation events and guard steps since the gateway load
began, and a `probe`: what one plain request to the gateway got (status and Location, or the
network error). The stand-in in `test/fake-electron` replays Electron 45's event order for a
redirect cancelled from `will-redirect`. It does not model Chromium's timing or the network,
so the CI smoke is the only real test of that path.

## Brand

The app uses the **Getway Chat** entry from the [vasyaod/icons](https://github.com/vasyaod/icons)
registry, the same one as the Android app: a white speech bubble on **#29B6D1**.
`resources/brand.json` is the registry record, and `resources/icon.png` is its PNG, byte for
byte (`test/brand.test.mjs` checks the sha256). `npm run icons` (`scripts/make-icons.py`, needs
Pillow) makes the app, window, tray and badge icons from that PNG. Commit the result.

## Releases

`.github/workflows/build.yml` runs on every push. It runs the tests. It then builds every OS
and arch on that OS's runner: macOS on `macos-15`, Linux on `ubuntu-24.04`, Windows on
`windows-latest`, each for x64 and arm64. On each OS it **launches** the native build with
`ci/smoke.sh`: on Linux the AppImage itself under Xvfb, on macOS the `.app`, on Windows the
unpacked `.exe`. On `main` it then publishes the release `v0.1.<run>`:

- fixed asset names (`ci/collect.mjs`), which the links above use through
  `/releases/latest/download/`;
- `SHA256SUMS`, signed keyless with cosign. The signature is bound to this workflow on
  `refs/heads/main`, and the bundle, detached signature and certificate are all published;
- a build provenance attestation for every installer and for `SHA256SUMS`;
- all of it published with the workflow's own `GITHUB_TOKEN`. There is no PAT and no
  cross-repo upload. The job then verifies the attestations and the anonymous download URLs.

The release job runs only in `vasyaod/agent-getway-desktop`. A copy of this tree anywhere else
builds and launches, but publishes nothing.
