'use strict';
/* Background service worker: resolves the mp4 for each episode, hands it to the
   browser's own downloader (chrome.downloads), and tracks the queue.
   Cross-browser: `browser` (Firefox) or `chrome`. */

// Chrome loads only this file as the SW → pull in the parser. Firefox loads
// parser.js first via manifest "scripts", so it's already defined there.
try {
  if (typeof jdExtractPlayers === 'undefined' && typeof importScripts === 'function') {
    importScripts('parser.js');
  }
} catch (e) { /* noop */ }

const api = globalThis.browser || globalThis.chrome;

const DEFAULTS = {
  quality: '1080',
  template: '{anime}/Season {s}/{anime} S{s}E{e}.mp4',
  subfolder: 'Jutsu',
  concurrency: 3,
  skip: true,
  theme: 'system',
};

// ---- in-memory state (authoritative within a SW lifetime), mirrored to storage
let QUEUE = null, RECENT = null, HISTORY = null;

const getLS = (k) => api.storage.local.get(k);
const setLS = (o) => api.storage.local.set(o);

async function ensureLoaded() {
  if (QUEUE === null) {
    const d = await getLS(['queue', 'recent', 'history']);
    QUEUE = d.queue || [];
    RECENT = d.recent || [];
    HISTORY = d.history || {};
  }
}
const persistQueue = () => setLS({ queue: QUEUE });
const persistRecent = () => setLS({ recent: RECENT });
const persistHistory = () => setLS({ history: HISTORY });

async function getSettings() {
  const { settings } = await getLS('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

// ---- broadcast (popup/options via runtime, content widgets via ports) --------
const ports = new Set();
api.runtime.onConnect.addListener((p) => {
  ports.add(p);
  p.onDisconnect.addListener(() => ports.delete(p));
});
function broadcast(msg) {
  try { const r = api.runtime.sendMessage(msg); if (r && r.catch) r.catch(() => {}); } catch (e) { /* */ }
  ports.forEach((p) => { try { p.postMessage(msg); } catch (e) { /* */ } });
}
function pubJob(j) {
  return {
    id: j.id, animeTitle: j.animeTitle, slug: j.slug, season: j.season, episode: j.episode,
    quality: j.res ? j.res + 'p' : j.quality, status: j.status, paused: !!j.paused, error: j.error,
    dlId: j.dlId,
  };
}
async function broadcastState() {
  await ensureLoaded();
  broadcast({ type: 'state', queue: QUEUE.map(pubJob), recent: RECENT });
}

// ---- enqueue -----------------------------------------------------------------
async function addJobs(items) {
  await ensureLoaded();
  const st = await getSettings();
  const existing = new Set(QUEUE.map((j) => j.key));
  let added = 0, skipped = 0;
  for (const it of (items || [])) {
    if (!it || !it.pageUrl) continue;
    const slug = jdSlug(it.pageUrl);
    const { season, episode } = jdSeasonEp(it.pageUrl);
    const key = jdKey(slug, season, episode);
    if ((st.skip && HISTORY[key]) || existing.has(key)) { skipped++; continue; }
    existing.add(key);
    const animeTitle = it.animeTitle || slug;
    QUEUE.push({
      id: crypto.randomUUID(), key, slug, animeTitle, season, episode,
      quality: it.quality || st.quality, pageUrl: it.pageUrl,
      filename: jdBuildFilename(st.template, st.subfolder, { anime: animeTitle, season, episode }),
      status: 'queued',
    });
    added++;
  }
  await persistQueue();
  broadcastState();
  pump();
  return { added, skipped };
}

// ---- queue pump --------------------------------------------------------------
let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    await ensureLoaded();
    const st = await getSettings();
    const active = QUEUE.filter((j) => j.status === 'active').length;
    let slots = Math.max(0, st.concurrency - active);
    const starts = [];
    for (const j of QUEUE) {
      if (slots <= 0) break;
      if (j.status === 'queued') { j.status = 'active'; j.paused = false; slots--; starts.push(j.id); }
    }
    if (starts.length) { await persistQueue(); broadcastState(); }
    for (const id of starts) startJob(id);
  } finally { pumping = false; }
}

async function startJob(id) {
  await ensureLoaded();
  const j = QUEUE.find((x) => x.id === id);
  if (!j) return;
  try {
    const html = await jdFetchPage(j.pageUrl);
    const picked = jdPick(jdExtractPlayers(html), j.quality);
    if (!picked) {                                  // no real links → not logged in
      j.status = 'error'; j.error = 'auth';
      await persistQueue(); broadcast({ type: 'auth' }); broadcastState(); pump();
      return;
    }
    if (!j.animeTitle || j.animeTitle === j.slug) {
      const t = jdAnimeTitle(jdExtractTitle(html));
      if (t) {
        const st = await getSettings();
        j.animeTitle = t;
        j.filename = jdBuildFilename(st.template, st.subfolder, { anime: t, season: j.season, episode: j.episode });
      }
    }
    j.res = picked.res;
    const dlId = await api.downloads.download({
      url: picked.url, filename: j.filename, conflictAction: 'uniquify', saveAs: false,
    });
    j.dlId = dlId; j.status = 'active';
    await persistQueue();
    startPolling();
    broadcastState();
  } catch (e) {
    j.status = 'error'; j.error = String((e && e.message) || e);
    await persistQueue(); broadcastState(); pump();
  }
}

// ---- browser download events -------------------------------------------------
api.downloads.onChanged.addListener(async (delta) => {
  await ensureLoaded();
  const j = QUEUE.find((x) => x.dlId === delta.id);
  if (!j) return;
  if (delta.paused) { j.paused = delta.paused.current; await persistQueue(); broadcastState(); }
  if (delta.state) {
    if (delta.state.current === 'complete') {
      QUEUE = QUEUE.filter((x) => x.id !== j.id);
      HISTORY[j.key] = true;
      RECENT.unshift({
        id: j.id, dlId: j.dlId, title: j.animeTitle,
        sub: `Сезон ${j.season} · Серия ${j.episode} · ${j.res || ''}p`, ts: Date.now(),
      });
      RECENT = RECENT.slice(0, 30);
      await persistQueue(); await persistHistory(); await persistRecent();
      broadcast({ type: 'done', title: j.animeTitle, sub: `Серия ${j.episode}` });
      broadcastState(); pump();
    } else if (delta.state.current === 'interrupted') {
      if (j.intent === 'cancel') QUEUE = QUEUE.filter((x) => x.id !== j.id);
      else { j.status = 'error'; j.error = (delta.error && delta.error.current) || 'interrupted'; }
      await persistQueue(); broadcastState(); pump();
    }
  }
});

// ---- controls ----------------------------------------------------------------
async function pauseJob(id) {
  await ensureLoaded();
  const j = QUEUE.find((x) => x.id === id); if (!j) return;
  if (j.dlId != null) { try { await api.downloads.pause(j.dlId); } catch (e) { /* */ } j.paused = true; }
  else j.status = 'paused';
  await persistQueue(); broadcastState();
}
async function resumeJob(id) {
  await ensureLoaded();
  const j = QUEUE.find((x) => x.id === id); if (!j) return;
  if (j.dlId != null) { try { await api.downloads.resume(j.dlId); } catch (e) { /* */ } j.paused = false; startPolling(); }
  else if (j.status === 'paused') { j.status = 'queued'; pump(); }
  await persistQueue(); broadcastState();
}
async function cancelJob(id) {
  await ensureLoaded();
  const j = QUEUE.find((x) => x.id === id); if (!j) return;
  if (j.dlId != null) { j.intent = 'cancel'; try { await api.downloads.cancel(j.dlId); } catch (e) { /* */ } }
  else QUEUE = QUEUE.filter((x) => x.id !== id);
  await persistQueue(); broadcastState(); pump();
}
async function cancelAll() {
  await ensureLoaded();
  const keep = [];
  for (const j of QUEUE) {
    if (j.status === 'active' && j.dlId != null) { j.intent = 'cancel'; try { await api.downloads.cancel(j.dlId); } catch (e) { /* */ } keep.push(j); }
  }
  QUEUE = keep; await persistQueue(); broadcastState();
}
async function pauseAll() {
  await ensureLoaded();
  for (const j of QUEUE) {
    if (j.dlId != null) { try { await api.downloads.pause(j.dlId); } catch (e) { /* */ } j.paused = true; }
    else if (j.status === 'queued') j.status = 'paused';
  }
  await persistQueue(); broadcastState();
}
async function resumeAll() {
  await ensureLoaded();
  for (const j of QUEUE) {
    if (j.dlId != null) { try { await api.downloads.resume(j.dlId); } catch (e) { /* */ } j.paused = false; }
    else if (j.status === 'paused') j.status = 'queued';
  }
  await persistQueue(); broadcastState(); pump();
}

// ---- progress polling (kept alive by content-widget ports) -------------------
let pollTimer = null;
const speedMap = new Map();
function startPolling() { if (!pollTimer) pollTimer = setInterval(pollProgress, 900); }
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
async function pollProgress() {
  await ensureLoaded();
  const actives = QUEUE.filter((j) => j.dlId != null && j.status === 'active');
  if (!actives.length) { stopPolling(); return; }
  const items = [];
  for (const j of actives) {
    try {
      const [it] = await api.downloads.search({ id: j.dlId });
      if (!it) continue;
      const now = Date.now(); const prev = speedMap.get(j.id);
      let speed = 0;
      if (prev && now > prev.t) speed = (it.bytesReceived - prev.b) / ((now - prev.t) / 1000);
      speedMap.set(j.id, { b: it.bytesReceived, t: now });
      items.push({ id: j.id, received: it.bytesReceived, total: it.totalBytes, paused: it.paused, speed });
    } catch (e) { /* */ }
  }
  if (items.length) broadcast({ type: 'progress', items });
}

// ---- reconcile after a SW restart -------------------------------------------
async function reconcile() {
  await ensureLoaded();
  let changed = false;
  for (const j of [...QUEUE]) {
    if (j.dlId == null) continue;
    try {
      const [it] = await api.downloads.search({ id: j.dlId });
      if (!it) { j.status = 'error'; j.error = 'lost'; changed = true; }
      else if (it.state === 'complete') {
        QUEUE = QUEUE.filter((x) => x.id !== j.id); HISTORY[j.key] = true;
        RECENT.unshift({ id: j.id, dlId: j.dlId, title: j.animeTitle, sub: `Серия ${j.episode}`, ts: Date.now() });
        changed = true;
      } else if (it.state === 'interrupted') { j.status = 'error'; changed = true; }
    } catch (e) { /* */ }
  }
  if (changed) { await persistQueue(); await persistHistory(); await persistRecent(); }
  startPolling(); pump();
}

// ---- messaging ---------------------------------------------------------------
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ensureLoaded();
    switch (msg && msg.type) {
      case 'enqueue': sendResponse(await addJobs(msg.items)); break;
      case 'getState': sendResponse({ queue: QUEUE.map(pubJob), recent: RECENT }); break;
      case 'getSettings': sendResponse(await getSettings()); break;
      case 'setSettings': {
        await setLS({ settings: { ...(await getSettings()), ...msg.settings } });
        sendResponse(await getSettings()); broadcast({ type: 'settings' }); break;
      }
      case 'pause': await pauseJob(msg.id); sendResponse({ ok: true }); break;
      case 'resume': await resumeJob(msg.id); sendResponse({ ok: true }); break;
      case 'cancel': await cancelJob(msg.id); sendResponse({ ok: true }); break;
      case 'cancelAll': await cancelAll(); sendResponse({ ok: true }); break;
      case 'pauseAll': await pauseAll(); sendResponse({ ok: true }); break;
      case 'resumeAll': await resumeAll(); sendResponse({ ok: true }); break;
      case 'openFolder': if (msg.dlId != null) { try { api.downloads.show(msg.dlId); } catch (e) { /* */ } } sendResponse({ ok: true }); break;
      case 'clearRecent': RECENT = []; await persistRecent(); broadcastState(); sendResponse({ ok: true }); break;
      default: sendResponse({});
    }
  })();
  return true; // async response
});

reconcile();
