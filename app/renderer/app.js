'use strict';
/* Jutsu Downloader — renderer logic. Vanilla JS, no framework. */

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function human(n) {
  n = Number(n) || 0;
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i >= 2 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}
const speed = (n) => human(n) + '/с';

const GRADS = [
  'linear-gradient(160deg,#E24B6B,#8E2DE2)',
  'linear-gradient(160deg,#B24592,#3A1C71)',
  'linear-gradient(160deg,#654ea3,#1a1a2e)',
  'linear-gradient(160deg,#0f9b8e,#134E5E)',
  'linear-gradient(160deg,#f7971e,#8e2de2)',
  'linear-gradient(160deg,#1CB5E0,#2A2A72)',
];
function gradFor(slug) {
  let h = 0;
  for (const ch of String(slug)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GRADS[h % GRADS.length];
}
// gradient stays as a fallback layer under the image, so a failed/missing poster
// still shows something instead of an empty box
function posterStyle(data, slug) {
  const g = gradFor(slug);
  // NB: single quotes inside url() — the whole thing goes into a double-quoted
  // style="..." attribute, so double quotes here would break the attribute.
  if (data) return `background:${g};background-image:url('${data}');background-size:cover;background-position:center;`;
  return `background:${g};`;
}
const posterStyleUrl = posterStyle;

function animeRoot(url) {
  try {
    const slug = new URL(url).pathname.split('/').filter(Boolean)[0];
    return slug ? `https://jut.su/${slug}/` : 'https://jut.su/';
  } catch { return 'https://jut.su/'; }
}
function cleanTitle(t) {
  return String(t || '').replace(/\s*[-—]\s*Jut\.su.*$/i, '').replace(/\s+на\s+Jut\.su.*$/i, '').trim() || 'jut.su';
}

const QUALITIES = [
  { v: 'max', label: 'Максимальное' },
  { v: '1080', label: '1080p' },
  { v: '720', label: '720p' },
  { v: '480', label: '480p' },
  { v: '360', label: '360p' },
];
const qLabel = (v) => (QUALITIES.find((q) => q.v === v) || {}).label || v;

const state = {
  screen: 'watch', theme: 'dark', loggedIn: false,
  currentUrl: '', isEpisode: false,
  fabOpen: false, qualityOpen: false, quality: 'max',
  epInfo: null, epInfoLoading: false,
  queue: [], library: null, expanded: null,
  episodes: null, episodesLoading: false, selected: new Set(),
  batchQuality: 'max', batchQualityOpen: false,
  watched: {},
};

function seasonEpOf(url) {
  const p = new URL(url).pathname;
  let m = /\/season-(\d+)\/episode-(\d+)\.html/.exec(p);
  if (m) return { season: +m[1], episode: +m[2] };
  m = /\/episode-(\d+)\.html/.exec(p);
  return { season: 1, episode: m ? +m[1] : 0 };
}
function animeTitleOf(slug) {
  const a = state.library && state.library.animes.find((x) => x.slug === slug);
  return a ? a.title : slug;
}
function watchedEntry(slug, key) {
  return (state.watched[slug] && state.watched[slug][key]) || null;
}
function watchedCountFor(slug, episodes) {
  const w = state.watched[slug] || {};
  return episodes.reduce((n, e) => n + (w[`s${e.season}e${e.episode}`] && w[`s${e.season}e${e.episode}`].done ? 1 : 0), 0);
}
// episodes started but not finished, most-recent first
function continueList() {
  const out = [];
  const w = state.watched || {};
  for (const slug in w) {
    for (const key in w[slug]) {
      const e = w[slug][key];
      if (!e || e.done || !e.dur || !e.pos) continue;
      const pct = e.pos / e.dur;
      if (pct < 0.02 || pct >= 0.9) continue;
      const m = /s(\d+)e(\d+)/.exec(key) || [0, 0, 0];
      out.push({ slug, key, url: e.url, pos: e.pos, dur: e.dur, ts: e.ts || 0, season: +m[1], episode: +m[2], pct: Math.floor(pct * 100) });
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, 8);
}
async function refreshWatched() { state.watched = await window.api.watchState(); }

const site = $('#site');

/* ===================== navigation ===================== */
function show(screen) {
  state.screen = screen;
  for (const s of ['watch', 'library', 'episodes']) {
    $('#screen-' + s).classList.toggle('hidden', s !== screen);
  }
  if (screen === 'library') refreshLibrary();
}

/* ===================== webview ===================== */
function updateNavButtons() {
  try { $('#btnBack').disabled = !site.canGoBack(); } catch {}
  try { $('#btnFwd').disabled = !site.canGoForward(); } catch {}
}
function onNav() {
  try { state.currentUrl = site.getURL(); } catch {}
  state.isEpisode = /\/episode-\d+\.html/.test(state.currentUrl);
  updateNavButtons();
  if (state.fabOpen) { state.epInfo = null; renderFab(); if (state.isEpisode) loadEpInfo(); }
}
site.addEventListener('did-navigate', onNav);
site.addEventListener('did-navigate-in-page', onNav);
site.addEventListener('did-stop-loading', onNav);
site.addEventListener('page-title-updated', (e) => { $('#pageTitle').textContent = cleanTitle(e.title); });

// poll the jut.su player for watch progress while an episode is open
setInterval(async () => {
  if (state.screen !== 'watch' || !state.isEpisode) return;
  try {
    const info = await site.executeJavaScript(
      "(()=>{const v=document.querySelector('video');return v&&v.duration?{t:v.currentTime,d:v.duration}:null;})()", true);
    if (info && info.d) {
      const slug = new URL(state.currentUrl).pathname.split('/').filter(Boolean)[0];
      const { season, episode } = seasonEpOf(state.currentUrl);
      window.api.watchProgress({ slug, season, episode, pos: info.t, dur: info.d, url: state.currentUrl });
    }
  } catch {}
}, 5000);

$('#btnBack').onclick = () => { if (site.canGoBack()) site.goBack(); };
$('#btnFwd').onclick = () => { if (site.canGoForward()) site.goForward(); };
$('#btnHome').onclick = () => site.loadURL('https://jut.su/');
$('#btnSettings').onclick = () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  $('.app').dataset.theme = state.theme;
  toast('info', '◑', 'Тема: ' + (state.theme === 'dark' ? 'тёмная' : 'светлая'));
};

/* ===================== login indicator ===================== */
function applyLogin(s) {
  state.loggedIn = !!s.loggedIn;
  $('#premium').classList.toggle('off', !state.loggedIn);
  $('#premiumLbl').textContent = state.loggedIn ? 'Вы вошли' : 'Войдите на jut.su';
}
async function refreshLogin() { applyLogin(await window.api.loginStatus()); }
window.api.onLogin(applyLogin);

/* ===================== FAB ===================== */
$('#fab').onclick = () => {
  state.fabOpen = !state.fabOpen;
  state.qualityOpen = false;
  renderFab();
  if (state.fabOpen && state.isEpisode) loadEpInfo();
};

async function loadEpInfo() {
  if (!state.isEpisode) return;
  state.epInfoLoading = true; renderFab();
  const info = await window.api.parseEpisode(state.currentUrl);
  state.epInfo = info; state.epInfoLoading = false;
  if (state.fabOpen) renderFab();
}

function renderFab() {
  const host = $('#fabMenu');
  if (!state.fabOpen) { host.innerHTML = ''; return; }

  let card;
  if (state.isEpisode) {
    const info = state.epInfo;
    const sub = state.epInfoLoading ? 'Определяю серию…'
      : info && info.ok ? `${esc(info.animeTitle)} · Сезон ${info.season} · Серия ${info.episode}`
        : 'Не удалось прочитать страницу';
    const opts = state.qualityOpen ? `
      <div class="qsel-menu">
        ${QUALITIES.map((q) => `<div class="qsel-opt ${q.v === state.quality ? 'sel' : ''}" data-q="${q.v}">${q.label}</div>`).join('')}
      </div>` : '';
    card = `
      <div class="menu-card">
        <div class="menu-row">
          <div class="menu-icon accent">⬇</div>
          <div class="dl-info"><div class="menu-title">Скачать эту серию</div><div class="menu-sub">${sub}</div></div>
        </div>
        <div class="qsel">
          <button class="qsel-btn" id="qselBtn"><span>Качество: ${qLabel(state.quality)}</span><span style="color:var(--c30)">▾</span></button>
          ${opts}
        </div>
        <button class="enqueue-btn" id="dlThis">Добавить в очередь</button>
      </div>`;
  } else {
    card = `
      <div class="menu-card" style="opacity:.9">
        <div class="menu-row">
          <div class="menu-icon muted">⬇</div>
          <div class="dl-info"><div class="menu-title" style="color:var(--c34)">Скачать эту серию</div><div class="menu-sub">Откройте страницу конкретной серии</div></div>
        </div>
        <div class="link" id="openListInline" style="margin-top:10px;font-size:12.5px">…или скачайте всё пачкой — открыть список серий →</div>
      </div>`;
  }

  host.innerHTML = `
    <div class="menu">
      ${card}
      <div class="menu-item" id="fabList">
        <div class="menu-icon muted">☰</div>
        <div class="dl-info"><div class="menu-title">Список серий</div><div class="menu-sub">Разобрать аниме и скачать пачкой</div></div>
        <span style="color:var(--c30)">→</span>
      </div>
      <div class="menu-item" id="fabLib">
        <div class="menu-icon muted">▤</div>
        <div class="dl-info"><div class="menu-title">В библиотеку</div><div class="menu-sub">Скачанное и очередь загрузок</div></div>
        <span style="color:var(--c30)">→</span>
      </div>
    </div>`;

  const qb = $('#qselBtn'); if (qb) qb.onclick = () => { state.qualityOpen = !state.qualityOpen; renderFab(); };
  host.querySelectorAll('.qsel-opt').forEach((o) => { o.onclick = () => { state.quality = o.dataset.q; state.qualityOpen = false; renderFab(); }; });
  const dt = $('#dlThis'); if (dt) dt.onclick = downloadThis;
  const oi = $('#openListInline'); if (oi) oi.onclick = () => openEpisodes(animeRoot(state.currentUrl));
  $('#fabList').onclick = () => openEpisodes(animeRoot(state.currentUrl));
  $('#fabLib').onclick = () => { state.fabOpen = false; renderFab(); show('library'); };
}

async function downloadThis() {
  const info = state.epInfo && state.epInfo.ok ? state.epInfo : {};
  const r = await window.api.enqueue([{
    pageUrl: state.currentUrl, quality: state.quality,
    animeTitle: info.animeTitle, title: info.episode ? `Серия ${info.episode}` : undefined,
  }]);
  state.fabOpen = false; renderFab();
  if (r.queued) toast('ok', '✓', `В очередь: ${info.animeTitle || 'серия'}`);
  else toast('info', '✓', 'Уже скачано или в очереди');
  show('library');
}

function updateFabBadge() {
  const n = state.queue.filter((j) => ['queued', 'active', 'paused'].includes(j.status)).length;
  const b = $('#fabBadge');
  b.textContent = n;
  b.classList.toggle('hidden', n === 0);
}

/* ===================== LIBRARY ===================== */
async function refreshLibrary() {
  state.library = await window.api.libraryList();
  renderLibrary();
}

function renderActive() {
  const active = state.queue.filter((j) => j.status !== 'done');
  if (!active.length) return '';
  const rows = active.map((d) => {
    const pct = d.pct || 0;
    const pauseIcon = d.status === 'paused' ? '▶' : '❚❚';
    const stateColor = d.status === 'paused' ? 'var(--c30)' : d.status === 'error' ? 'var(--err)' : 'var(--c35)';
    const pctLabel = d.status === 'paused' ? 'Пауза' : d.status === 'error' ? 'Ошибка' : pct + '%';
    const meta = d.total ? `${human(d.done)} / ${human(d.total)} · ${speed(d.speed || 0)}` : 'ожидание…';
    return `
      <div class="dl-card" data-dl="${d.id}">
        <div class="dl-top">
          <div class="dl-thumb" style="background:${gradFor(d.slug)}"></div>
          <div class="dl-info">
            <div class="dl-title">${esc(d.animeTitle)} — ${esc(d.title)}</div>
            <div class="dl-sub">Сезон ${d.season} · Серия ${d.episode} · ${qLabel(d.quality)}</div>
          </div>
          <div class="dl-right">
            <div class="dl-pct" data-pct style="color:${stateColor}">${pctLabel}</div>
            <div class="dl-meta" data-meta>${meta}</div>
          </div>
          <div style="display:flex;gap:8px;margin-left:6px">
            <button class="dl-ctrl" data-pause="${d.id}">${pauseIcon}</button>
            <button class="dl-ctrl x" data-cancel="${d.id}">✕</button>
          </div>
        </div>
        <div class="progress"><div class="bar" data-bar style="width:${pct}%;background:${d.status === 'paused' ? 'var(--c32)' : 'var(--accent)'}"></div></div>
      </div>`;
  }).join('');
  const paused = active.filter((j) => j.status === 'paused').length;
  const rest = active.reduce((s, j) => s + Math.max(0, (j.total || 0) - (j.done || 0)), 0);
  return `
    <div style="margin-bottom:26px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span class="section-title" style="margin:0">Активные загрузки</span>
        <span class="count-pill">${active.length}</span>
        ${rest ? `<span class="dl-meta">осталось ~${human(rest)}</span>` : ''}
        <div class="grow"></div>
        ${paused ? '<button class="btn-chip" id="resumeAll">▶ Продолжить всё</button>' : ''}
        <button class="btn-chip danger" id="cancelAll">✕ Отменить всё</button>
      </div>
      <div class="active-list">${rows}</div>
    </div>`;
}

function posterFor(slug) {
  const a = state.library && state.library.animes.find((x) => x.slug === slug);
  return a ? a.poster : null;
}
function fmtTime(s) {
  s = Math.floor(s || 0);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function renderContinue() {
  const list = continueList();
  if (!list.length) return '';
  const rows = list.map((c) => `
    <div class="dl-card">
      <div class="dl-top">
        <div class="dl-thumb" style="${posterStyle(posterFor(c.slug), c.slug)}"></div>
        <div class="dl-info">
          <div class="dl-title">${esc(animeTitleOf(c.slug))} — Серия ${c.episode}</div>
          <div class="dl-sub">Сезон ${c.season} · остановился на ${fmtTime(c.pos)} / ${fmtTime(c.dur)}</div>
        </div>
        <button class="btn-small" data-cont-play="${esc(c.url || '')}">▶ Продолжить</button>
      </div>
      <div class="progress"><div class="bar" style="width:${c.pct}%"></div></div>
    </div>`).join('');
  return `
    <div style="margin-bottom:26px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span class="section-title" style="margin:0">Продолжить смотреть</span>
        <span class="count-pill">${list.length}</span>
      </div>
      <div class="active-list">${rows}</div>
    </div>`;
}

function renderLibrary() {
  const lib = state.library || { animes: [], totalBytes: 0, downloadDir: '' };
  const diskPct = Math.min(100, Math.round((lib.totalBytes / (200 * 1024 ** 3)) * 100));
  const folderName = (lib.downloadDir || '').split('/').slice(-2).join('/');

  const toolbar = `
    <div class="toolbar">
      <button class="iconbtn" id="libBack">‹</button>
      <div class="screen-title">Библиотека</div>
      <div class="grow"></div>
      <div class="disk">
        <span class="lbl">Диск</span>
        <div class="track"><div class="fill" style="width:${diskPct}%"></div></div>
        <span class="val">${human(lib.totalBytes)}</span>
      </div>
      <button class="btn-chip" id="libFolder" title="${esc(lib.downloadDir)}">📁 ${esc(folderName || 'папка')}</button>
    </div>`;

  let body;
  if (!lib.animes.length && !state.queue.length) {
    body = `
      <div class="empty">
        <div class="ic">📥</div>
        <div class="h">Пока ничего не скачано</div>
        <div class="p">Откройте серию на jut.su и нажмите кнопку загрузки — файлы появятся здесь.</div>
        <button class="btn-primary" id="emptyGo">Перейти к просмотру</button>
      </div>`;
  } else {
    const cards = lib.animes.map((a) => {
      const wc = watchedCountFor(a.slug, a.episodes);
      const wpct = a.count ? Math.round((wc / a.count) * 100) : 0;
      return `
      <div class="card" data-anime="${esc(a.slug)}">
        <div class="poster" style="${posterStyle(a.poster, a.slug)}">
          <span class="name">${esc(a.title)}</span>
          <span class="badge">${a.seasons} сез.</span>
        </div>
        <div class="cmeta">${a.count} серий · ${human(a.bytes)}${wc ? ` · просмотрено ${wc}/${a.count}` : ''}</div>
        ${wc ? `<div class="cwatch"><div class="cwatch-bar" style="width:${wpct}%"></div></div>` : ''}
      </div>`;
    }).join('');
    body = `${renderContinue()}${renderActive()}
      <div class="section-title">Скачано</div>
      <div class="grid">${cards || '<div class="cmeta">Очередь загрузок ниже…</div>'}</div>
      <div id="expandedHost"></div>`;
  }

  $('#libRoot').innerHTML = toolbar + `<div class="content">${body}</div>`;

  $('#libBack').onclick = () => show('watch');
  const eg = $('#emptyGo'); if (eg) eg.onclick = () => show('watch');
  $('#libFolder').onclick = async () => { await window.api.chooseFolder(); refreshLibrary(); };
  $('#libRoot').querySelectorAll('[data-pause]').forEach((b) => b.onclick = () => {
    const j = state.queue.find((x) => x.id == b.dataset.pause);
    if (j && j.status === 'paused') window.api.resume(j.id); else window.api.pause(Number(b.dataset.pause));
  });
  $('#libRoot').querySelectorAll('[data-cancel]').forEach((b) => b.onclick = () => window.api.cancel(Number(b.dataset.cancel)));
  const ca = $('#cancelAll'); if (ca) ca.onclick = () => { window.api.cancelAll(); toast('info', '✕', 'Очередь очищена'); };
  const ra = $('#resumeAll'); if (ra) ra.onclick = () => window.api.resumeAll();
  $('#libRoot').querySelectorAll('[data-cont-play]').forEach((b) => b.onclick = () => {
    const u = b.dataset.contPlay; if (u) { show('watch'); site.loadURL(u); }
  });
  $('#libRoot').querySelectorAll('[data-anime]').forEach((c) => c.onclick = () => {
    state.expanded = state.expanded === c.dataset.anime ? null : c.dataset.anime;
    renderExpanded();
  });
  renderExpanded();
}

function renderExpanded() {
  const host = $('#expandedHost');
  if (!host) return;
  const a = state.library.animes.find((x) => x.slug === state.expanded);
  if (!a) { host.innerHTML = ''; return; }
  const rows = a.episodes.map((e) => {
    const wkey = `s${e.season}e${e.episode}`;
    const we = watchedEntry(a.slug, wkey);
    const seen = !!(we && we.done);
    return `
    <div class="ep-row ${seen ? 'seen-row' : ''}">
      <span class="ep-n">${e.episode}</span>
      <div class="ep-title">${esc(e.title)} <span style="color:var(--c30);font-weight:500">· Сезон ${e.season}</span></div>
      <span class="qbadge">${esc(e.quality || '')}</span>
      <span class="ep-dur">${human(e.bytes)}</span>
      <div style="display:flex;gap:8px;flex:none;align-items:center">
        <button class="eye ${seen ? 'on' : ''}" data-watch="${esc(a.slug)}|${wkey}|${seen ? '0' : '1'}" title="${seen ? 'Снять отметку' : 'Отметить просмотренным'}">${seen ? '✓' : '○'}</button>
        <button class="btn-small" data-play="${esc(e.file)}">▶ смотреть</button>
        <button class="btn-del" data-del="${esc(a.slug)}|${wkey}">🗑</button>
      </div>
    </div>`;
  }).join('');
  host.innerHTML = `
    <div class="expanded">
      <div class="head">
        <div class="thumb" style="${posterStyle(a.poster, a.slug)}"></div>
        <div class="grow"><div style="font-size:15px;font-weight:800">${esc(a.title)}</div><div class="menu-sub">${a.count} серий · ${human(a.bytes)}</div></div>
        <button class="iconbtn" id="closeExpanded" style="width:32px;height:32px">✕</button>
      </div>
      <div>${rows}</div>
    </div>`;
  $('#closeExpanded').onclick = () => { state.expanded = null; renderExpanded(); };
  host.querySelectorAll('[data-play]').forEach((b) => b.onclick = () => window.api.openFile(b.dataset.play));
  host.querySelectorAll('[data-watch]').forEach((b) => b.onclick = async () => {
    const [slug, key, w] = b.dataset.watch.split('|');
    await window.api.markWatched({ slug, key, watched: w === '1' });
    await refreshWatched();
    renderLibrary();
  });
  host.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    const [slug, key] = b.dataset.del.split('|');
    await window.api.deleteEpisode({ slug, key });
    await refreshLibrary();
  });
}

/* live progress patch (avoids full re-render every 400ms) */
function patchProgress(p) {
  const card = $(`#libRoot [data-dl="${p.id}"]`);
  if (!card) return;
  const bar = card.querySelector('[data-bar]'); if (bar) bar.style.width = (p.pct || 0) + '%';
  const pct = card.querySelector('[data-pct]'); if (pct) pct.textContent = (p.pct || 0) + '%';
  const meta = card.querySelector('[data-meta]');
  if (meta && p.total) meta.textContent = `${human(p.done)} / ${human(p.total)} · ${speed(p.speed || 0)}`;
}

/* ===================== EPISODES ===================== */
$('#epBack').onclick = () => show('watch');
$('#epToLib').onclick = () => show('library');

async function openEpisodes(url) {
  state.fabOpen = false; renderFab();
  show('episodes');
  state.episodesLoading = true; state.episodes = null; state.selected = new Set();
  renderEpisodes();
  const r = await window.api.parseAnime(url);
  state.episodesLoading = false;
  if (!r.ok) { toast('err', '⚠', 'Не удалось разобрать страницу аниме'); state.episodes = null; renderEpisodes(); return; }
  state.episodes = r;
  renderEpisodes();
}

function episodeStatus(key) {
  const q = state.queue.find((j) => `s${j.season}e${j.episode}` === key);
  if (q) return 'queued';
  return null;
}

function renderEpisodes() {
  const content = $('#epContent');
  const bulk = $('#bulkbar');

  if (state.episodesLoading) {
    bulk.innerHTML = '';
    content.innerHTML = `
      <div style="display:flex;gap:22px;margin-bottom:26px">
        <div class="sk" style="width:150px;height:214px"></div>
        <div style="flex:1;padding-top:8px">
          <div class="sk" style="width:280px;height:26px"></div>
          <div class="sk" style="width:180px;height:16px;margin-top:14px"></div>
          <div class="sk" style="width:120px;height:40px;margin-top:20px"></div>
        </div>
      </div>
      ${Array.from({ length: 8 }).map(() => '<div class="sk" style="height:46px;margin-bottom:10px"></div>').join('')}`;
    return;
  }
  if (!state.episodes) { content.innerHTML = ''; bulk.innerHTML = ''; return; }

  const ep = state.episodes;
  const downloadedKeys = new Set();
  if (state.library) {
    const a = state.library.animes.find((x) => x.slug === ep.slug);
    if (a) a.episodes.forEach((e) => downloadedKeys.add(`s${e.season}e${e.episode}`));
  }

  const seasons = ep.seasons.map((s) => {
    const rows = s.eps.map((e) => {
      const dl = downloadedKeys.has(e.key) || e.downloaded;
      const st = dl ? 'have' : episodeStatus(e.key) === 'queued' ? 'queued' : 'none';
      const stLabel = st === 'have' ? '✓ скачано' : st === 'queued' ? 'В очереди' : 'Не скачано';
      const on = state.selected.has(e.key);
      const we = watchedEntry(ep.slug, e.key);
      const inprog = we && !we.done && we.dur && we.pos ? Math.floor((we.pos / we.dur) * 100) : 0;
      const watchMark = we && we.done ? '<span class="seen-tag">✓ смотрел</span>'
        : inprog ? `<span class="seen-tag part">${inprog}%</span>` : '';
      return `
        <div class="sel-row ${dl ? 'is-dl' : ''}" data-key="${e.key}" data-dl="${dl ? 1 : 0}">
          <span class="check ${on ? 'on' : ''} ${dl ? 'dis' : ''}">${on || dl ? '✓' : ''}</span>
          <span class="ep-title">${esc(e.label)}</span>
          ${watchMark}
          <span class="status ${st}">${stLabel}</span>
        </div>`;
    }).join('');
    return `
      <div class="season">
        <div class="season-head">
          <span class="season-name">${esc(s.name)}</span>
          <span class="season-count">${s.count} серий</span>
          <button class="season-pick" data-season="${s.season}">Выбрать сезон</button>
        </div>
        <div class="season-body">${rows}</div>
      </div>`;
  }).join('');

  content.innerHTML = `
    <div class="ep-header">
      <div class="ep-poster" style="${posterStyleUrl(ep.poster, ep.slug)}"></div>
      <div style="flex:1;padding-top:4px">
        <h1 class="ep-h1">${esc(ep.title)}</h1>
        <div class="ep-meta">Сезонов: ${ep.seasons.length} · Серий: ${ep.total}</div>
        <div style="margin-top:20px"><button class="btn-primary" id="epWatch">▶ Смотреть</button></div>
      </div>
    </div>
    ${seasons}
    <div style="height:20px"></div>`;

  // bulk bar — only not-yet-downloaded episodes are selectable
  const selectableKeys = [];
  ep.seasons.forEach((s) => s.eps.forEach((e) => { if (!downloadedKeys.has(e.key) && !e.downloaded) selectableKeys.push(e.key); }));
  const notDownloaded = selectableKeys.length;
  const allSel = notDownloaded > 0 && selectableKeys.every((k) => state.selected.has(k));
  const bopts = state.batchQualityOpen ? `
    <div class="qsel-menu" style="width:180px;bottom:48px">
      ${QUALITIES.map((q) => `<div class="qsel-opt ${q.v === state.batchQuality ? 'sel' : ''}" data-bq="${q.v}">${q.label}</div>`).join('')}
    </div>` : '';
  bulk.innerHTML = `
    <div class="bulkbar">
      <button class="btn-secondary" id="selectAll">${allSel ? 'Снять выделение' : 'Выбрать всё'}</button>
      <button class="btn-secondary" id="dlAll">⬇ Скачать всё аниме${notDownloaded ? ` (${notDownloaded})` : ''}</button>
      <div style="position:relative">
        <button class="btn-secondary" id="batchQ" style="display:flex;align-items:center;gap:10px">Качество: ${qLabel(state.batchQuality)} <span style="color:var(--c30)">▾</span></button>
        ${bopts}
      </div>
      <div class="grow" style="font-size:13px;color:var(--c29)">${state.selected.size ? `Выбрано: ${state.selected.size}` : `Не скачано: ${notDownloaded}`}</div>
      <button class="btn-primary" id="dlSelected" ${state.selected.size ? '' : 'disabled'}>⬇ Скачать выбранное (${state.selected.size})</button>
    </div>`;

  $('#epWatch').onclick = () => { show('watch'); site.loadURL(ep.rootUrl); };
  content.querySelectorAll('.sel-row').forEach((r) => r.onclick = () => {
    if (r.dataset.dl === '1') return;                 // already downloaded — not selectable
    const k = r.dataset.key;
    if (state.selected.has(k)) state.selected.delete(k); else state.selected.add(k);
    renderEpisodes();
  });
  content.querySelectorAll('[data-season]').forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    const s = ep.seasons.find((x) => x.season == b.dataset.season);
    s.eps.forEach((e) => { if (!downloadedKeys.has(e.key) && !e.downloaded) state.selected.add(e.key); });
    renderEpisodes();
  });
  $('#selectAll').onclick = () => {
    if (allSel) state.selected.clear();
    else selectableKeys.forEach((k) => state.selected.add(k));
    renderEpisodes();
  };
  $('#dlAll').onclick = async () => {
    const items = [];
    ep.seasons.forEach((s) => s.eps.forEach((e) => {
      if (!downloadedKeys.has(e.key) && !e.downloaded) items.push({ pageUrl: e.url, quality: state.batchQuality, animeTitle: ep.title, title: `Серия ${e.episode}` });
    }));
    if (!items.length) { toast('info', '✓', 'Всё уже скачано'); return; }
    const r = await window.api.enqueue(items);
    toast('ok', '✓', `В очередь: ${r.queued}${r.skipped ? `, пропущено ${r.skipped}` : ''}`);
    state.selected = new Set();
    show('library');
  };
  $('#batchQ').onclick = () => { state.batchQualityOpen = !state.batchQualityOpen; renderEpisodes(); };
  bulk.querySelectorAll('[data-bq]').forEach((o) => o.onclick = () => { state.batchQuality = o.dataset.bq; state.batchQualityOpen = false; renderEpisodes(); });
  $('#dlSelected').onclick = downloadSelected;
}

async function downloadSelected() {
  if (!state.selected.size) return;
  const ep = state.episodes;
  const items = [];
  for (const s of ep.seasons) for (const e of s.eps) {
    if (state.selected.has(e.key)) items.push({ pageUrl: e.url, quality: state.batchQuality, animeTitle: ep.title, title: `Серия ${e.episode}` });
  }
  const r = await window.api.enqueue(items);
  toast('ok', '✓', `В очередь: ${r.queued}${r.skipped ? `, пропущено ${r.skipped}` : ''}`);
  state.selected = new Set();
  show('library');
}

/* ===================== error overlay ===================== */
function showError() {
  $('#overlayHost').innerHTML = `
    <div class="overlay">
      <div class="modal">
        <div class="ic">⚠</div>
        <div class="h">Сессия истекла</div>
        <div class="p">Похоже, вы не вошли на jut.su в приложении (или сессия истекла). Войдите на сайте, чтобы скачивать в премиум-качестве.</div>
        <div class="row">
          <button class="later" id="errLater">Позже</button>
          <button class="go" id="errGo">Войти на jut.su</button>
        </div>
      </div>
    </div>`;
  $('#errLater').onclick = closeError;
  $('#errGo').onclick = () => { closeError(); show('watch'); site.loadURL('https://jut.su/'); };
}
function closeError() { $('#overlayHost').innerHTML = ''; }

/* ===================== toasts ===================== */
function toast(kind, icon, text) {
  const node = document.createElement('div');
  node.className = 'toast ' + kind;
  node.innerHTML = `<span class="ic">${icon}</span><span class="tx">${esc(text)}</span>`;
  $('#toasts').appendChild(node);
  setTimeout(() => { node.style.transition = 'opacity .3s'; node.style.opacity = '0'; setTimeout(() => node.remove(), 300); }, 3200);
}

/* ===================== queue events ===================== */
window.api.onQueue((q) => {
  state.queue = q;
  updateFabBadge();
  if (state.screen === 'library') renderLibrary();
  if (state.screen === 'episodes' && state.episodes) renderEpisodes();
});
window.api.onProgress((p) => {
  const j = state.queue.find((x) => x.id === p.id);
  if (j) Object.assign(j, p);
  if (state.screen === 'library') patchProgress(p);
});
window.api.onDone((info) => {
  toast('info', '⬇', `Загрузка завершена: ${info.title || 'Серия ' + info.episode}`);
  if (state.screen === 'library') refreshLibrary();
  if (state.screen === 'episodes' && state.episodes) { refreshLibrary().then(() => renderEpisodes()); }
});
window.api.onError((e) => {
  if (e.code === 'auth') showError();
  else if (e.code === 'failed') toast('err', '⚠', `Ошибка загрузки: ${e.title || ''}`);
  else if (e.code === 'cancelled') toast('info', '✕', `Отменено: ${e.title || ''}`);
});

/* ===================== init ===================== */
window.api.onWatchChanged(async () => {
  await refreshWatched();
  if (state.screen === 'library') renderLibrary();
  if (state.screen === 'episodes' && state.episodes) renderEpisodes();
});

(async function init() {
  $('.app').dataset.theme = state.theme;
  refreshLogin();
  state.queue = await window.api.queueState();
  state.watched = await window.api.watchState();
  updateFabBadge();
  updateNavButtons();
  show('watch');
})();
