# Security

## Reporting a vulnerability
Please open a **private** security advisory on GitHub (Security → Report a vulnerability)
or email the maintainer. Do not open a public issue for security bugs.

## Threat model in one line
The app embeds the **jut.su** website in a webview and downloads video the logged-in
user is entitled to. The main risks are (a) leaking the user's jut.su session and
(b) the embedded remote site. Both are addressed below.

## What the app does with your credentials
- **Your password is never entered, stored, or transmitted by this app.** You log
  into jut.su inside the embedded browser; auth lives only as normal cookies in
  Electron's `persist:jutsu` session on your machine.
- Session cookies are sent **only to `jut.su` hosts**. Poster images (AniList) and the
  signed video CDN (`*.yandexwebcache.org`) are fetched **without** your cookies.
- All outbound URLs that receive cookies are validated with a host check (`isJutsu`).

## Hardening in place
- `contextIsolation: true`, `nodeIntegration: false` — the UI cannot touch Node.
- Renderer talks to the main process only through a fixed `contextBridge` API
  (`preload.js`); there is no arbitrary IPC surface.
- The embedded browser is **locked to jut.su** — navigation to any other host is
  blocked and pop-ups to external sites are denied (opened in the system browser).
- A **Content-Security-Policy** restricts the UI to `script-src 'self'` and a small
  allow-list of image/font hosts.
- Filesystem writes/deletes are confined to the downloads folder (path-traversal guard
  `resolveInside`), and anime slugs are sanitised before being used as paths.
- The video CDN URL is self-authorising (signed), so no session data is exposed to it.

## Known residual risks (documented, not bugs)
- The embedded webview renders third-party content (jut.su and its ads). It runs
  sandboxed with no Node access, like a normal browser tab, but you are still browsing
  a third-party site.
- Electron ships a full Chromium; keep the `electron` dependency up to date and run
  `npm audit` in `app/` periodically.

## For users / self-hosters
- **Never commit `cookies.txt`** (the CLI credential file) — it is git-ignored. If you
  ever exposed it, log out of jut.su to rotate the session.
- Downloaded videos are your responsibility — keep them private (see the disclaimer
  in the README).
