# JutGrab 🍥

*Grab your anime.* Turn your **jut.su** account into an offline library — via a desktop
app, a browser extension, or a CLI. Watch, then download episodes (one by one or a whole
anime at once) for offline viewing.

> **No password required.** You log into jut.su inside the app; the downloader reuses
> that session. Your credentials never leave your machine.

<!-- Add a screenshot/GIF here once you have one: docs/screenshot.png -->

## Features
- 🖥️ **Single-site browser** — jut.su embedded, locked to that domain (not a full browser).
- ⬇️ **Download** the current episode, selected episodes, or a whole anime in one click.
- ⚡ **Parallel queue** (3 at a time), with pause / resume / cancel-all, that **survives
  a restart** and resumes half-finished files.
- 🚫 **Skips what you already have** — never re-downloads an episode.
- 🖼️ **Rich library** — real anime banners (jut.su / AniList), sizes, seasons.
- 👁️ **Watch tracking** — “Continue watching”, per-anime progress, watched marks.
- 🎚️ **Quality picker** (1080p / 720p / 480p / 360p).

## How it works
jut.su hides the real `.mp4` links inside `data-player-1080/720/480/360` attributes and
serves a `pixel.png` placeholder to anonymous requests. With your logged-in session the
server returns the real signed CDN links, which the app reads and streams to disk. See
[SECURITY.md](SECURITY.md) for the trust model.

## Desktop app (recommended)
Requires **Node.js 18+**.
```bash
cd app
npm install        # first time (downloads Electron)
npm start
```
Then log into jut.su inside the window and start downloading. Files land in
`downloads/<anime>/season-N/episode-M.mp4`.

> If Electron's binary fails to unzip on install (a known npm quirk), delete
> `~/Library/Caches/electron` and run `npm install` again, or unzip the cached archive
> into `app/node_modules/electron/dist` and write `Electron.app/Contents/MacOS/Electron`
> to `app/node_modules/electron/path.txt`.

## CLI (headless alternative)
Requires **Python 3.9+**.
```bash
pip install -r requirements.txt
# uses cookies from your browser — no password needed
python3 jutsu_dl.py "https://jut.su/faairytail/season-1/episode-1.html"
python3 jutsu_dl.py "https://jut.su/faairytail/" --quality 1080   # whole anime
```
See `python3 jutsu_dl.py --help` for cookie source, quality and range options.

## Browser extension (Chrome + Firefox)
The lightest way to grab episodes: browse jut.su as usual, a floating ⬇ widget downloads
the current episode / whole season via the browser's own download manager.
```
Chrome:  chrome://extensions → Developer mode → Load unpacked → extension/
Firefox: about:debugging → Load Temporary Add-on → extension/manifest.json
```
See [extension/README.md](extension/README.md).

## Project layout
```
app/                 Electron desktop app
  main.js            window, session/auth, domain lock, IPC, download queue
  downloader.js      jut.su parsing + concurrent DownloadManager
  preload.js         contextBridge API
  renderer/          index.html · styles.css · app.js  (3 screens)
extension/           MV3 browser extension (Chrome + Firefox)
  src/               parser · background worker · content widget · popup · options
jutsu_dl.py          Python CLI downloader
requirements.txt     CLI dependencies
```

## Roadmap
- 🎬 Built-in offline player: skip intro/outro, autoplay next, resume position.
- 🔔 Subscribe to airing anime → auto-download new episodes + notify.
- 📚 Jellyfin/Plex-ready export (folder naming + `.nfo` + posters).
- 🌐 Multi-source plugins (beyond jut.su).

## Contributing
Issues and PRs welcome. Keep the renderer dependency-free (vanilla JS) and match the
existing design tokens in `app/renderer/styles.css`. Please read [SECURITY.md](SECURITY.md)
before touching auth, IPC, or filesystem code.

## Disclaimer
This project is a **client** for a site you already have access to. It does **not** host,
stream, or distribute any video, and ships with no content. Use it only to make personal,
offline copies of material you are entitled to watch, keep those copies to yourself, and
respect jut.su's Terms of Service and applicable copyright law in your country. You are
responsible for how you use it.

## License
[MIT](LICENSE)
