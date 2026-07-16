'use strict';
// Node port of the jut.su download mechanism (validated against the site):
// a logged-in request returns the real mp4 URLs inside data-player-1080/720/480/360
// attributes; otherwise those hold a pixel.png placeholder. We fetch the page with
// the webview session cookies, read those attributes, and stream the chosen quality.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const BASE = 'https://jut.su';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const DATA_PLAYER_RE = /data-player-(\d+)\s*=\s*"([^"]+)"/g;
const EPISODE_HREF_RE = /href="(\/[^"]*?\/episode-\d+\.html)"/g;
const TITLE_RE = /<title>([\s\S]*?)<\/title>/i;
const SEASON_EP_RE = /\/season-(\d+)\/episode-(\d+)\.html/;
const PLAIN_EP_RE = /\/episode-(\d+)\.html/;

function isJutsu(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'jut.su' || h.endsWith('.jut.su');
  } catch { return false; }
}

// jut.su serves pages in windows-1251
function decode1251(buf) {
  return new TextDecoder('windows-1251').decode(buf);
}

async function fetchPage(url, cookieHeader) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Referer': BASE + '/',
      'Accept-Language': 'ru,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Cookie': cookieHeader || '',
    },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  return decode1251(buf);
}

// { res(number): url } — real mp4 only, placeholders dropped
function extractPlayers(html) {
  const out = {};
  let m;
  DATA_PLAYER_RE.lastIndex = 0;
  while ((m = DATA_PLAYER_RE.exec(html))) {
    const res = Number(m[1]);
    const url = m[2];
    if (url.includes('.mp4') && !url.includes('pixel.png')) out[res] = url;
  }
  return out;
}

function extractTitle(html) {
  const m = TITLE_RE.exec(html);
  if (!m) return null;
  let t = m[1].replace(/\s+/g, ' ').trim();
  t = t.replace(/^Смотреть\s+/i, '').replace(/\s+на\s+Jut\.su\s*$/i, '').trim();
  return t;
}

// clean anime name from any jut.su page <title>
function animeTitleFrom(pageTitle) {
  if (!pageTitle) return null;
  let t = String(pageTitle).replace(/^Смотреть\s+/i, '').replace(/\s+на\s+Jut\.su.*$/i, '').trim();
  t = t.replace(/\s+\d+\s+сезон\s+\d+\s+серия.*$/i, '').replace(/\s+\d+\s+серия.*$/i, '');
  t = t.replace(/\s+все\s+серии\s+и\s+сезоны.*$/i, '');
  t = t.replace(/\s+смотреть\s+онлайн.*$/i, '');
  return t.trim() || String(pageTitle);
}

// low-res anime thumbnail from the jut.su page itself (fallback poster)
function extractPoster(html) {
  const m = /https?:\/\/[^"')\s]*\/uploads\/animethumbs\/[^"')\s]+\.(?:jpe?g|png|webp)/i.exec(html);
  if (m) return m[0];
  const og = /property="og:image"\s+content="([^"]+)"/i.exec(html)
    || /content="([^"]+)"\s+property="og:image"/i.exec(html);
  return og ? og[1] : null;
}

// wide 2560x1440 banner referenced on the jut.su page (prefer the dark variant)
function extractBanner(html) {
  const m = /chakranature\/background\/anime\/[a-z0-9_-]+\.dark\.jpg/i.exec(html)
    || /chakranature\/background\/anime\/[a-z0-9_-]+\.jpg/i.exec(html);
  return m ? 'https://gen.jut.su/' + m[0] : null;
}

// latin/romaji title, e.g. description "Серии Фейри Тейл (Fairy Tail) ..." → "Fairy Tail"
function extractLatinTitle(html) {
  const desc = /<meta name="description" content="([^"]*)"/i.exec(html);
  if (desc) {
    const m = /\(([A-Za-z][A-Za-z0-9 :!'’,.\-]*)\)/.exec(desc[1]);
    if (m) return m[1].trim();
  }
  return null;
}

// high-res official cover from AniList (public GraphQL API) by anime name
async function fetchAnilistCover(name) {
  if (!name) return null;
  try {
    const query = 'query($s:String){Media(search:$s,type:ANIME){coverImage{extraLarge large medium}}}';
    const r = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { s: name } }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const c = j && j.data && j.data.Media && j.data.Media.coverImage;
    return c ? (c.extraLarge || c.large || c.medium) : null;
  } catch { return null; }
}

function slugFromUrl(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  return parts[0] || 'anime';
}

function seasonEpFrom(url) {
  const m = SEASON_EP_RE.exec(url);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  const p = PLAIN_EP_RE.exec(url);
  return { season: 1, episode: p ? Number(p[1]) : 0 };
}

function isEpisodeUrl(url) {
  try { return PLAIN_EP_RE.test(new URL(url).pathname); } catch { return false; }
}

function listEpisodes(html) {
  const seen = [];
  let m;
  EPISODE_HREF_RE.lastIndex = 0;
  while ((m = EPISODE_HREF_RE.exec(html))) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

function pickQuality(players, quality) {
  const keys = Object.keys(players).map(Number);
  if (!keys.length) return null;
  if (quality === 'max') return { res: Math.max(...keys), url: players[Math.max(...keys)] };
  if (quality === 'min') return { res: Math.min(...keys), url: players[Math.min(...keys)] };
  const want = Number(quality);
  if (players[want]) return { res: want, url: players[want] };
  const lower = keys.filter((k) => k <= want);
  const res = lower.length ? Math.max(...lower) : Math.min(...keys);
  return { res, url: players[res] };
}

// ---------------------------------------------------------------------------
// Concurrent download queue. Emits: 'queue', 'progress', 'done', 'error'.
// deps: { getCookieHeader(): Promise<string>, resolve(job): Promise<{res,url}>, concurrency }
// resolve() throws {code:'auth'} when the session no longer returns real links.
// ---------------------------------------------------------------------------
class DownloadManager extends EventEmitter {
  constructor(deps) {
    super();
    this.getCookieHeader = deps.getCookieHeader;
    this.resolve = deps.resolve;
    // Sequential, one episode at a time. jut.su throttles bulk grabbing per
    // account (many parallel/rapid fetches trip its anti-scrape limiter), so we
    // download strictly one-by-one with a polite gap between episodes.
    this.concurrency = 1;
    this.gapMs = 30000;           // pause between finishing one episode and starting the next
    this._gapTimer = null;
    this.jobs = [];               // all jobs not yet done
    this.active = new Map();      // id -> AbortController
  }

  // kept for API compatibility; sequential download is enforced regardless
  setConcurrency() {
    this.concurrency = 1;
    this._tick();
  }

  snapshot() {
    return this.jobs.map((j) => ({
      id: j.id, animeTitle: j.animeTitle, slug: j.slug,
      season: j.season, episode: j.episode, quality: j.quality,
      title: j.title, sub: j.sub, status: j.status,
      done: j.done, total: j.total, speed: j.speed,
      pct: j.total ? Math.min(100, Math.floor((j.done / j.total) * 100)) : 0,
    }));
  }

  // durable fields for on-disk persistence
  dump() {
    return this.jobs.map((j) => ({
      id: j.id, slug: j.slug, animeTitle: j.animeTitle, season: j.season,
      episode: j.episode, quality: j.quality, pageUrl: j.pageUrl, dest: j.dest,
      title: j.title, sub: j.sub,
      status: (j.status === 'error' || j.status === 'active') ? 'queued' : j.status,
    }));
  }

  _emitQueue() { this.emit('queue', this.snapshot()); }

  _mk(job) {
    return Object.assign({ status: 'queued', done: 0, total: 0, speed: 0, intent: null }, job);
  }

  add(job) { this.jobs.push(this._mk(job)); this._emitQueue(); this._tick(); }

  // restore persisted jobs on startup (active->queued, keep paused)
  restore(jobs) {
    for (const j of jobs) {
      const status = j.status === 'active' ? 'queued' : (j.status || 'queued');
      this.jobs.push(this._mk(Object.assign({}, j, { status })));
    }
    this._emitQueue();
    this._tick();
  }

  cancel(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return;
    if (this.active.has(id)) { job.intent = 'cancel'; this.active.get(id).abort(); }
    else {
      this.jobs = this.jobs.filter((j) => j.id !== id);
      try { fs.rmSync(job.dest + '.part', { force: true }); } catch {}
      this._emitQueue();
    }
  }

  cancelAll() {
    for (const job of this.jobs) {
      if (this.active.has(job.id)) { job.intent = 'cancel'; this.active.get(job.id).abort(); }
      else { try { fs.rmSync(job.dest + '.part', { force: true }); } catch {} }
    }
    // keep only jobs still aborting; they get removed when their _run settles
    this.jobs = this.jobs.filter((j) => this.active.has(j.id));
    this._emitQueue();
  }

  pause(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return;
    if (this.active.has(id)) { job.intent = 'pause'; this.active.get(id).abort(); }
    else { job.status = 'paused'; this._emitQueue(); }
  }

  resume(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.status !== 'paused') return;
    job.status = 'queued'; this._emitQueue(); this._tick();
  }

  resumeAll() {
    for (const j of this.jobs) if (j.status === 'paused') j.status = 'queued';
    this._emitQueue(); this._tick();
  }

  _tick() {
    if (this._gapTimer) return;       // waiting out the polite gap between episodes
    if (this.active.size >= 1) return; // strictly one at a time
    const next = this.jobs.find((j) => j.status === 'queued' && !this.active.has(j.id));
    if (next) this._run(next);
  }

  // after an episode settles, wait gapMs before starting the next one so we
  // don't hammer jut.su and trip its per-account rate limit
  _scheduleNext() {
    if (this._gapTimer) return;
    const hasNext = this.jobs.some((j) => j.status === 'queued');
    if (!hasNext) return;
    this._gapTimer = setTimeout(() => {
      this._gapTimer = null;
      this._tick();
    }, this.gapMs);
  }

  async _run(job) {
    const controller = new AbortController();
    this.active.set(job.id, controller);
    job.status = 'active'; job.intent = null;
    this._emitQueue();
    try {
      const picked = await this.resolve(job);
      job.url = picked.url; job.resLabel = picked.res + 'p';
      await this._download(job, controller);
      this.jobs = this.jobs.filter((j) => j.id !== job.id);
      this.emit('done', {
        id: job.id, slug: job.slug, animeTitle: job.animeTitle, season: job.season,
        episode: job.episode, title: job.title, quality: job.resLabel || (job.quality + 'p'),
        dest: job.dest, bytes: job.total,
      });
    } catch (err) {
      if (job.intent === 'cancel') {
        this.jobs = this.jobs.filter((j) => j.id !== job.id);
        try { fs.rmSync(job.dest + '.part', { force: true }); } catch {}
        this.emit('error', { id: job.id, code: 'cancelled', title: job.title });
      } else if (job.intent === 'pause') {
        job.status = 'paused'; job.speed = 0;
      } else if (err && err.code === 'auth') {
        // session gone: pause it (no tight retry loop) and let the user re-login
        job.status = 'paused'; job.speed = 0;
        this.emit('error', { id: job.id, code: 'auth', title: job.title });
      } else {
        job.status = 'error'; job.error = String((err && err.message) || err);
        this.emit('error', { id: job.id, code: 'failed', title: job.title, message: job.error });
      }
      job.intent = null;
    } finally {
      this.active.delete(job.id);
      this._emitQueue();
      this._scheduleNext();
    }
  }

  async _download(job, controller) {
    const dest = job.dest;
    const part = dest + '.part';
    let resume = 0;
    try { resume = fs.statSync(part).size; } catch {}

    // the mp4 lives on a signed CDN URL (yandexwebcache) that authorises itself —
    // never send jut.su session cookies to a non-jut.su host
    const headers = { 'User-Agent': UA, 'Referer': BASE + '/' };
    if (isJutsu(job.url)) headers['Cookie'] = await this.getCookieHeader();
    if (resume) headers['Range'] = `bytes=${resume}-`;

    const res = await fetch(job.url, { headers, signal: controller.signal });
    if (resume && res.status === 200) resume = 0;          // server ignored Range → restart
    if (res.status !== 200 && res.status !== 206) throw new Error('HTTP ' + res.status);

    const total = Number(res.headers.get('content-length') || 0) + resume;
    job.total = total;
    job.done = resume;

    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(part, { flags: resume ? 'a' : 'w' });
    const stream = Readable.fromWeb(res.body);
    const signal = controller.signal;

    let lastEmit = 0, lastBytes = resume, lastTime = Date.now();

    await new Promise((resolve, reject) => {
      let settled = false;
      const abortErr = () => Object.assign(new Error('aborted'), { aborted: true });
      const finish = (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (err) reject(err); else resolve();
      };
      // deterministically settle on pause/cancel (destroy() alone never emits end/error)
      const onAbort = () => { stream.destroy(); out.end(() => finish(abortErr())); };

      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });

      stream.on('data', (chunk) => {
        const ok = out.write(chunk);
        job.done += chunk.length;
        if (!ok) { stream.pause(); out.once('drain', () => stream.resume()); }
        const now = Date.now();
        if (now - lastEmit > 400) {
          const dt = (now - lastTime) / 1000;
          job.speed = dt > 0 ? (job.done - lastBytes) / dt : 0;
          lastBytes = job.done; lastTime = now; lastEmit = now;
          this.emit('progress', {
            id: job.id, done: job.done, total: job.total, speed: job.speed,
            pct: total ? Math.min(100, Math.floor((job.done / total) * 100)) : 0,
          });
        }
      });
      stream.on('end', () => out.end(() => finish()));
      stream.on('error', (e) => out.end(() => finish(signal.aborted ? abortErr() : e)));
    });

    fs.renameSync(part, dest);
  }
}

module.exports = {
  BASE, UA, isJutsu, fetchPage, extractPlayers, extractTitle,
  animeTitleFrom, extractPoster, extractBanner, extractLatinTitle, fetchAnilistCover,
  slugFromUrl, seasonEpFrom, isEpisodeUrl,
  listEpisodes, pickQuality, DownloadManager,
};
