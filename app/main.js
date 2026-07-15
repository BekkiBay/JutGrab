'use strict';
const { app, BrowserWindow, session, ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const D = require('./downloader');

const PARTITION = 'persist:jutsu';
let mainWindow = null;
let jutsuSession = null;
let manager = null;
let settings = null;

// --------------------------------------------------------------------------
// settings + library persistence
// --------------------------------------------------------------------------
function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }

function defaultDownloadDir() {
  // reuse the project's downloads folder if present (keeps already-downloaded eps),
  // otherwise ~/Downloads/Anime
  const proj = path.join(__dirname, '..', 'downloads');
  if (fs.existsSync(proj)) return proj;
  return path.join(app.getPath('home'), 'Downloads', 'Anime');
}

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (!s.downloadDir) s.downloadDir = defaultDownloadDir();
    if (!s.defaultQuality) s.defaultQuality = 'max';
    if (!s.concurrency) s.concurrency = 3;
    return s;
  } catch {
    return { downloadDir: defaultDownloadDir(), defaultQuality: 'max', concurrency: 3 };
  }
}

// --- queue + watch persistence (userData, independent of the downloads folder) ---
function queuePath() { return path.join(app.getPath('userData'), 'queue.json'); }
function loadQueue() { try { return JSON.parse(fs.readFileSync(queuePath(), 'utf8')); } catch { return []; } }
function saveQueue(jobs) { try { fs.writeFileSync(queuePath(), JSON.stringify(jobs, null, 2)); } catch {} }

function watchedPath() { return path.join(app.getPath('userData'), 'watched.json'); }
function loadWatched() { try { return JSON.parse(fs.readFileSync(watchedPath(), 'utf8')); } catch { return {}; } }
function saveWatched(w) { try { fs.writeFileSync(watchedPath(), JSON.stringify(w, null, 2)); } catch {} }

function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsPath()), { recursive: true }); } catch {}
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function libraryPath() { return path.join(settings.downloadDir, 'library.json'); }

function loadLibrary() {
  try { return JSON.parse(fs.readFileSync(libraryPath(), 'utf8')); }
  catch { return { animes: {} }; }
}

function saveLibrary(lib) {
  try { fs.mkdirSync(settings.downloadDir, { recursive: true }); } catch {}
  fs.writeFileSync(libraryPath(), JSON.stringify(lib, null, 2));
}

// --------------------------------------------------------------------------
// cookies from the webview session (this is the whole auth story — no cookies.txt)
// --------------------------------------------------------------------------
async function cookieHeader() {
  const cookies = await jutsuSession.cookies.get({ url: 'https://jut.su' });
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function loginStatus() {
  const cookies = await jutsuSession.cookies.get({ url: 'https://jut.su' });
  const uid = cookies.find((c) => c.name === 'dle_user_id');
  return { loggedIn: !!(uid && uid.value && uid.value !== '0'), userId: uid ? uid.value : null };
}

// --------------------------------------------------------------------------
// job helpers
// --------------------------------------------------------------------------
let jobSeq = 1;

function safeSlug(s) { return String(s).replace(/[^a-z0-9_-]/gi, '') || 'anime'; }

function destFor(slug, season, episode) {
  return path.join(settings.downloadDir, safeSlug(slug), `season-${Number(season)}`, `episode-${Number(episode)}.mp4`);
}

function relFrom(abs) { return path.relative(settings.downloadDir, abs); }

// guard against path traversal via renderer-supplied relative paths
function resolveInside(rel) {
  const root = path.resolve(settings.downloadDir);
  const abs = path.resolve(root, String(rel));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

async function resolveJob(job) {
  if (!D.isJutsu(job.pageUrl)) { const e = new Error('not jut.su'); e.code = 'failed'; throw e; }
  const html = await D.fetchPage(job.pageUrl, await cookieHeader());
  const players = D.extractPlayers(html);
  const picked = D.pickQuality(players, job.quality);
  if (!picked) { const e = new Error('no real links'); e.code = 'auth'; throw e; }
  if (!job.animeTitle) job.animeTitle = D.animeTitleFrom(D.extractTitle(html)) || job.slug;
  return picked;
}

async function downloadPoster(url, absPath) {
  try {
    // only attach jut.su cookies/referer to jut.su hosts (posters may come from AniList)
    const headers = { 'User-Agent': D.UA };
    if (D.isJutsu(url)) { headers['Referer'] = D.BASE + '/'; headers['Cookie'] = await cookieHeader(); }
    const res = await fetch(url, { headers });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, buf);
    return true;
  } catch { return false; }
}

// best cover for an anime page: wide jut.su banner → AniList cover → jut.su thumb
async function resolveCover(html) {
  const banner = D.extractBanner(html);
  if (banner) return banner;
  const latin = D.extractLatinTitle(html);
  let url = latin ? await D.fetchAnilistCover(latin) : null;
  if (!url) url = D.extractPoster(html);
  return url;
}

const COVER_V = 3; // bump to force re-fetch of already-cached posters

// read an image file into a data URI with the correct MIME (png/jpeg/webp/gif)
function dataUriFor(p) {
  const b = fs.readFileSync(p);
  let mime = 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) mime = 'image/png';
  else if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) mime = 'image/webp';
  else if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) mime = 'image/gif';
  return `data:${mime};base64,` + b.toString('base64');
}

// fetch + cache the real title/poster for a slug into library.json (network once)
async function ensureAnimeMeta(slug) {
  const lib = loadLibrary();
  const a = lib.animes[slug] || { slug, title: slug, url: `https://jut.su/${slug}/`, episodes: {} };
  const hasTitle = a.title && a.title !== slug;
  const hasPoster = a.poster && fs.existsSync(path.join(settings.downloadDir, a.poster));
  if (hasTitle && hasPoster && a.coverV === COVER_V) return a;
  try {
    const html = await D.fetchPage(`https://jut.su/${slug}/`, await cookieHeader());
    const title = D.animeTitleFrom(D.extractTitle(html));
    if (title) a.title = title;
    const coverUrl = await resolveCover(html);
    if (coverUrl) {
      const abs = path.join(settings.downloadDir, slug, 'poster.jpg');
      if (await downloadPoster(coverUrl, abs)) { a.poster = path.join(slug, 'poster.jpg'); a.coverV = COVER_V; }
    }
    lib.animes[slug] = a;
    saveLibrary(lib);
  } catch {}
  return a;
}

// --------------------------------------------------------------------------
// window
// --------------------------------------------------------------------------
function createWindow() {
  jutsuSession = session.fromPartition(PARTITION);
  jutsuSession.setUserAgent(D.UA);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#0E0E13',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // push login status to the renderer whenever jut.su cookies change
  let loginTimer = null;
  jutsuSession.cookies.on('changed', () => {
    clearTimeout(loginTimer);
    loginTimer = setTimeout(async () => {
      if (mainWindow) mainWindow.webContents.send('login-changed', await loginStatus());
    }, 400);
  });
}

// keep the embedded browser locked to jut.su
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (!D.isJutsu(url)) { shell.openExternal(url); return { action: 'deny' }; }
    contents.loadURL(url);
    return { action: 'deny' };
  });
  const guard = (ev, url) => { if (!D.isJutsu(url)) ev.preventDefault(); };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
});

// --------------------------------------------------------------------------
// download manager wiring
// --------------------------------------------------------------------------
function setupManager() {
  manager = new D.DownloadManager({
    getCookieHeader: cookieHeader, resolve: resolveJob, concurrency: settings.concurrency,
  });

  manager.on('queue', (snap) => {
    if (mainWindow) mainWindow.webContents.send('dl-queue', snap);
    saveQueue(manager.dump());          // persist so the queue survives a restart
  });
  manager.on('progress', (p) => mainWindow && mainWindow.webContents.send('dl-progress', p));
  manager.on('error', (e) => mainWindow && mainWindow.webContents.send('dl-error', e));

  manager.on('done', (info) => {
    // record into library.json with the real on-disk size
    const lib = loadLibrary();
    const a = lib.animes[info.slug] || {
      slug: info.slug, title: info.animeTitle || info.slug,
      url: `https://jut.su/${info.slug}/`, episodes: {},
    };
    if (info.animeTitle) a.title = info.animeTitle;
    let bytes = info.bytes || 0;
    try { bytes = fs.statSync(info.dest).size; } catch {}
    const key = `s${info.season}e${info.episode}`;
    a.episodes[key] = {
      season: info.season, episode: info.episode,
      title: info.title || `Серия ${info.episode}`,
      quality: info.quality, file: relFrom(info.dest), bytes,
    };
    lib.animes[info.slug] = a;
    saveLibrary(lib);
    if (mainWindow) mainWindow.webContents.send('dl-done', info);
  });
}

// --------------------------------------------------------------------------
// IPC
// --------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('login-status', () => loginStatus());
  ipcMain.handle('get-settings', () => ({ ...settings }));
  ipcMain.handle('queue-state', () => manager.snapshot());

  ipcMain.handle('parse-episode', async (_e, url) => {
    try {
      if (!D.isJutsu(url)) return { ok: false, error: 'Разрешён только jut.su' };
      const html = await D.fetchPage(url, await cookieHeader());
      const players = D.extractPlayers(html);
      const pageTitle = D.extractTitle(html);
      const { season, episode } = D.seasonEpFrom(url);
      const status = await loginStatus();
      return {
        ok: true,
        slug: D.slugFromUrl(url),
        animeTitle: D.animeTitleFrom(pageTitle) || D.slugFromUrl(url),
        pageTitle, season, episode,
        qualities: Object.keys(players).map(Number).sort((a, b) => b - a),
        loggedIn: status.loggedIn,
      };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('parse-anime', async (_e, url) => {
    try {
      if (!D.isJutsu(url)) return { ok: false, error: 'Разрешён только jut.su' };
      // normalise to the anime root (strip season/episode if an episode url was passed)
      const u = new URL(url);
      const slug = u.pathname.split('/').filter(Boolean)[0];
      const rootUrl = `https://jut.su/${slug}/`;
      const html = await D.fetchPage(rootUrl, await cookieHeader());
      const title = D.animeTitleFrom(D.extractTitle(html)) || slug;
      const posterUrl = await resolveCover(html);
      // cache title + poster into library.json (download poster in the background)
      {
        const l2 = loadLibrary();
        const a = l2.animes[slug] || { slug, title, url: rootUrl, episodes: {} };
        a.title = title; a.url = rootUrl;
        l2.animes[slug] = a; saveLibrary(l2);
        if (posterUrl) {
          downloadPoster(posterUrl, path.join(settings.downloadDir, slug, 'poster.jpg')).then((ok) => {
            if (!ok) return;
            const l3 = loadLibrary();
            if (l3.animes[slug]) { l3.animes[slug].poster = path.join(slug, 'poster.jpg'); l3.animes[slug].coverV = COVER_V; saveLibrary(l3); }
          });
        }
      }
      const paths = D.listEpisodes(html);
      const lib = loadLibrary();
      const have = lib.animes[slug] ? lib.animes[slug].episodes : {};

      const seasonsMap = new Map();
      for (const p of paths) {
        const full = 'https://jut.su' + p;
        const { season, episode } = D.seasonEpFrom(full);
        if (!seasonsMap.has(season)) seasonsMap.set(season, []);
        const key = `s${season}e${episode}`;
        seasonsMap.get(season).push({
          key, url: full, season, episode,
          label: `Серия ${episode}`,
          downloaded: !!have[key],
        });
      }
      const seasons = [...seasonsMap.entries()].sort((a, b) => a[0] - b[0]).map(([n, eps]) => ({
        season: n, name: `Сезон ${n}`, count: eps.length,
        eps: eps.sort((a, b) => a.episode - b.episode),
      }));
      return { ok: true, slug, title, rootUrl, total: paths.length, seasons, poster: posterUrl };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('enqueue', async (_e, items) => {
    const inQueue = new Set(manager.dump().map((j) => j.dest));
    let queued = 0, skipped = 0;
    for (const it of items) {
      const slug = D.slugFromUrl(it.pageUrl);
      const { season, episode } = D.seasonEpFrom(it.pageUrl);
      const dest = destFor(slug, season, episode);
      // skip what's already on disk or already queued
      if (fs.existsSync(dest) || inQueue.has(dest)) { skipped++; continue; }
      inQueue.add(dest);
      manager.add({
        id: jobSeq++,
        slug, animeTitle: it.animeTitle || slug,
        season, episode,
        quality: it.quality || settings.defaultQuality,
        pageUrl: it.pageUrl,
        dest,
        title: it.title || `Серия ${episode}`,
        sub: `${it.animeTitle || slug} · Сезон ${season} · Серия ${episode}`,
      });
      queued++;
    }
    return { queued, skipped };
  });

  ipcMain.handle('library-list', async () => {
    // scan the downloads folder from disk (source of truth); enrich title/poster
    // via library.json + a one-time page fetch (ensureAnimeMeta)
    const dir = settings.downloadDir;
    const animes = [];
    let top = [];
    try { top = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const ent of top) {
      if (!ent.isDirectory()) continue;
      const slug = ent.name;
      const baseMeta = (loadLibrary().animes[slug] || { episodes: {} });
      const eps = [];
      let seasonDirs = [];
      try { seasonDirs = fs.readdirSync(path.join(dir, slug), { withFileTypes: true }); } catch {}
      for (const sd of seasonDirs) {
        const sm = /^season-(\d+)$/.exec(sd.name);
        if (!sd.isDirectory() || !sm) continue;
        const season = Number(sm[1]);
        let files = [];
        try { files = fs.readdirSync(path.join(dir, slug, sd.name)); } catch {}
        for (const f of files) {
          const em = /^episode-(\d+)\.mp4$/.exec(f);
          if (!em) continue;
          const episode = Number(em[1]);
          const rel = path.join(slug, sd.name, f);
          let bytes = 0; try { bytes = fs.statSync(path.join(dir, rel)).size; } catch {}
          const em2 = (baseMeta.episodes || {})[`s${season}e${episode}`] || {};
          eps.push({ season, episode, title: em2.title || `Серия ${episode}`, quality: em2.quality || '', file: rel, bytes });
        }
      }
      if (!eps.length) continue;
      const meta = await ensureAnimeMeta(slug);        // title + poster (cached)
      eps.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
      const bytes = eps.reduce((s, e) => s + e.bytes, 0);
      const seasons = new Set(eps.map((e) => e.season)).size;
      // deliver the poster as a data URI (file:// images don't render reliably in the renderer)
      let poster = null;
      if (meta.poster) {
        try { poster = dataUriFor(path.join(dir, meta.poster)); } catch {}
      }
      animes.push({
        slug, title: meta.title || slug, url: meta.url || `https://jut.su/${slug}/`,
        poster,
        episodes: eps, count: eps.length, bytes, seasons,
      });
    }
    const totalBytes = animes.reduce((s, a) => s + a.bytes, 0);
    return { animes, totalBytes, downloadDir: dir };
  });

  ipcMain.handle('open-file', (_e, rel) => {
    // opening a downloaded file counts as "watched"
    const m = /^(.+?)\/season-(\d+)\/episode-(\d+)\.mp4$/.exec(String(rel).replace(/\\/g, '/'));
    if (m) {
      const w = loadWatched();
      const slug = m[1], key = `s${m[2]}e${m[3]}`;
      w[slug] = w[slug] || {};
      w[slug][key] = Object.assign({}, w[slug][key], { done: true, ts: Date.now() });
      saveWatched(w);
      if (mainWindow) mainWindow.webContents.send('watch-changed');
    }
    const abs = resolveInside(rel);
    if (!abs) return 'blocked';
    return shell.openPath(abs);
  });

  ipcMain.handle('delete-episode', (_e, { slug, key }) => {
    const lib = loadLibrary();
    const a = lib.animes[slug];
    if (!a || !a.episodes[key]) return { ok: false };
    const abs = resolveInside(a.episodes[key].file);
    if (abs) { try { fs.rmSync(abs, { force: true }); } catch {} }
    delete a.episodes[key];
    if (!Object.keys(a.episodes).length) delete lib.animes[slug];
    saveLibrary(lib);
    return { ok: true };
  });

  ipcMain.handle('choose-folder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.downloadDir,
    });
    if (!r.canceled && r.filePaths[0]) {
      settings.downloadDir = r.filePaths[0];
      saveSettings();
    }
    return { downloadDir: settings.downloadDir };
  });

  ipcMain.handle('dl-pause', (_e, id) => manager.pause(id));
  ipcMain.handle('dl-resume', (_e, id) => manager.resume(id));
  ipcMain.handle('dl-cancel', (_e, id) => manager.cancel(id));
  ipcMain.handle('dl-cancel-all', () => manager.cancelAll());
  ipcMain.handle('dl-resume-all', () => manager.resumeAll());
  ipcMain.handle('set-concurrency', (_e, n) => {
    settings.concurrency = Math.max(1, Math.min(6, (n | 0) || 3));
    saveSettings();
    manager.setConcurrency(settings.concurrency);
    return settings.concurrency;
  });

  // --- watch tracking (point 4) ---
  ipcMain.handle('watch-state', () => loadWatched());
  ipcMain.handle('watch-progress', (_e, { slug, season, episode, pos, dur, url }) => {
    if (!slug || !episode || !dur) return;
    const w = loadWatched();
    const key = `s${season}e${episode}`;
    w[slug] = w[slug] || {};
    const done = dur > 0 && pos / dur >= 0.9;
    w[slug][key] = Object.assign({}, w[slug][key], { pos, dur, done, url, ts: Date.now() });
    saveWatched(w);
  });
  ipcMain.handle('mark-watched', (_e, { slug, key, watched }) => {
    const w = loadWatched();
    w[slug] = w[slug] || {};
    const cur = w[slug][key] || {};
    if (watched) w[slug][key] = Object.assign({}, cur, { done: true, pos: cur.dur || 0, ts: Date.now() });
    else w[slug][key] = Object.assign({}, cur, { done: false, pos: 0, ts: Date.now() });
    saveWatched(w);
    return { ok: true };
  });
}

// --------------------------------------------------------------------------
app.whenReady().then(() => {
  settings = loadSettings();
  saveSettings();
  createWindow();
  setupManager();
  registerIpc();

  // resume a queue left over from a previous run (cookies persist in the webview session)
  const pending = loadQueue();
  if (pending.length) {
    // continue ids after the highest persisted one
    jobSeq = Math.max(jobSeq, ...pending.map((j) => (j.id || 0) + 1));
    manager.restore(pending);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
