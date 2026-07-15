# Jutsu Downloader — browser extension (Chrome + Firefox)

A focused **jut.su downloader** that lives inside your browser. Browse jut.su as usual
(already logged in), and a floating button lets you download the current episode, a whole
season, or the entire anime. The browser's own download manager does the downloading.

## What it does
- Injects a floating **⬇ widget** on jut.su:
  - on an **episode** page → “Скачать серию” (+ quality) and “Скачать весь сезон”;
  - on an **anime** page → season chips + “Скачать всё аниме”, with a “skip already
    downloaded” toggle.
- **Toolbar popup** — the download queue (progress, pause/resume/cancel, “отменить всё”),
  a default-quality switch, and recent downloads.
- **Options** — default quality, filename template (live preview), download sub-folder,
  concurrency (1–5), skip-downloaded, theme.

No password is ever handled: the extension reuses your existing jut.su session in the
browser. Session cookies stay first-party; the signed video CDN is self-authorising.

## Install (development)

### Chrome / Edge / Brave
1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select this `extension/` folder

### Firefox
1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `extension/manifest.json`
   (temporary add-ons are removed on restart; for a permanent install, sign the package
   via [AMO](https://addons.mozilla.org/developers/) or use Firefox Developer/Nightly with
   `xpinstall.signatures.required=false`).

Then open jut.su, log in, and use the ⬇ widget.

## How it works
jut.su serves the real mp4 links in `data-player-1080/720/480/360` attributes (a
`pixel.png` placeholder for anonymous requests). The content script reads them from the
page (or fetches other episode pages same-site, with your cookies) and hands the signed
URL to `chrome.downloads.download()` with a templated filename.

## Files
```
manifest.json          MV3, cross-browser (Chrome service_worker + Firefox scripts)
icons/                 16/32/48/128 png
src/parser.js          shared jut.su parsing (players, episodes, banner, filename)
src/background.js       queue + chrome.downloads + progress polling
src/content.js          in-page widget (Shadow DOM, isolated styles)
src/popup.html|css|js   toolbar popup (queue)
src/options.html|css|js settings
src/tokens.css          shared design tokens
```

## Packaging for stores
Zip the **contents** of `extension/` (manifest at the zip root):
```bash
cd extension && zip -r ../jutsu-downloader-extension.zip . -x '*.DS_Store'
```
Chrome Web Store / Firefox AMO may review downloader/scraper extensions closely; you can
always distribute the unpacked folder or a signed `.xpi` directly.

## Permissions
`downloads` (save files), `storage` (settings/queue/history), `alarms` (progress),
`activeTab` (detect jut.su in the popup), host `*://jut.su/*` (read episode pages with
your session). No analytics, no remote code.
