'use strict';
/* JutGrab mobile UI: 3 tabs (browser / library / downloads) + episode picker,
 * download sheet, session-expired modal, player overlay, toasts.
 * Native side (plugin "Jutsu"): embedded jut.su WebView, FAB, page fetcher,
 * download queue in a foreground service, library scan. */

// no bundler: only native-bridge.js is injected (no registerPlugin from
// @capacitor/core), so talk to the plugin through the raw bridge primitives
const Cap = window.Capacitor;
const Jutsu = new Proxy({}, {
  get: (_t, method) => method === 'addListener'
    ? (event, cb) => Cap.addListener('Jutsu', event, cb)
    : (options) => Cap.nativePromise('Jutsu', method, options),
});
const fileSrc = (p) => Cap.convertFileSrc(p);
const $ = (id) => document.getElementById(id);

const state = {
  tab: 'browser',
  url: null,          // current jut.su URL in the embedded browser
  title: '',
  loggedIn: false,
  jobs: [],           // download queue snapshot
  library: null,      // cached libraryList result
  expanded: null,     // expanded anime slug in library
  picker: null,       // { slug, title, rootUrl, seasons:[{season, eps:[{path,season,episode}]}] }
  selected: new Set(),// selected episode paths in picker
  sheet: null,        // { pageUrl, players, qualities, chosen, animeTitle, epTitle }
  playing: null,      // { slug, season, episode }
};

// ---------------------------------------------------------------- utils

function fmtMB(b) { return (b / 1048576).toFixed(b >= 104857600 ? 0 : 1) + ' МБ'; }
function fmtSize(b) {
  if (!b || b <= 0) return '—';
  return b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' ГБ' : fmtMB(b);
}
function lsGet(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function overlayOpen() {
  return !$('picker').classList.contains('hidden')
    || !$('sheet-backdrop').classList.contains('hidden')
    || !$('error-modal').classList.contains('hidden')
    || !$('player').classList.contains('hidden');
}

async function syncNative() {
  const visible = state.tab === 'browser' && !overlayOpen();
  try {
    if (visible) {
      const r = $('webview-area').getBoundingClientRect();
      await Jutsu.browserShow({
        top: Math.round(r.top),
        height: Math.round(r.height),
        fabBottom: Math.round(window.innerHeight - r.bottom + 16),
        url: lsGet('jg_lasturl', 'https://jut.su/anime/'),
      });
    } else {
      await Jutsu.browserHide();
    }
  } catch {}
}

// ---------------------------------------------------------------- toasts

function toast(text, type) {
  const t = el('div', 'toast' + (type ? ' ' + type : ''), text);
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 3000);
  // browser WebView is a native layer above the page — mirror the toast natively
  if (state.tab === 'browser' && !overlayOpen()) Jutsu.nativeToast({ text }).catch(() => {});
}

// ---------------------------------------------------------------- tabs

function switchTab(tab) {
  state.tab = tab;
  closeSheet(true); closePicker(true); closePlayer(true);
  $('error-modal').classList.add('hidden');
  for (const b of document.querySelectorAll('#tabbar .tab'))
    b.classList.toggle('active', b.dataset.tab === tab);
  $('screen-browser').classList.toggle('hidden', tab !== 'browser');
  $('screen-library').classList.toggle('hidden', tab !== 'library');
  $('screen-downloads').classList.toggle('hidden', tab !== 'downloads');
  if (tab === 'library') refreshLibrary();
  if (tab === 'downloads') renderDownloads();
  requestAnimationFrame(syncNative);
}

// ---------------------------------------------------------------- login / browser chrome

async function refreshLogin() {
  try {
    const s = await Jutsu.loginStatus();
    state.loggedIn = !!s.loggedIn;
    $('login-dot').classList.toggle('on', state.loggedIn);
  } catch {}
}

Jutsu.addListener('browserState', (s) => {
  if (s.url) { state.url = s.url; lsSet('jg_lasturl', s.url); }
  state.title = s.title || '';
  $('page-title').textContent = JParse.animeTitleFrom(state.title) || state.title || '';
  refreshLogin();
});

Jutsu.addListener('fabTap', () => {
  const url = state.url || '';
  if (JParse.isEpisodeUrl(url)) openSheet(url);
  else if (JParse.isJutsu(url) && JParse.slugFromUrl(url) !== 'anime') openPicker(JParse.slugFromUrl(url));
  else toast('Открой страницу серии или аниме на jut.su');
});

// ---------------------------------------------------------------- download queue events

Jutsu.addListener('dlQueue', (d) => { state.jobs = d.jobs || []; onQueueChanged(); });
Jutsu.addListener('dlProgress', (p) => patchProgress(p));
Jutsu.addListener('dlDone', (info) => {
  toast(`Загрузка завершена — ${info.title}`, 'ok');
  state.library = null; // invalidate cache
  if (state.tab === 'library') refreshLibrary();
});
Jutsu.addListener('dlError', (e) => {
  if (e.code === 'auth') showAuthError();
  else if (e.code === 'cancelled') toast('Загрузка отменена', 'err');
  else if (e.code === 'failed') toast(`Ошибка: ${e.title}${e.message ? ' — ' + e.message : ''}`, 'err');
});

function activeCount() {
  return state.jobs.filter((j) => j.status === 'active' || j.status === 'queued').length;
}

function onQueueChanged() {
  const n = activeCount();
  const badge = $('tab-badge');
  badge.textContent = n > 9 ? '9+' : String(n);
  badge.classList.toggle('hidden', n === 0);
  Jutsu.setBadge({ count: n }).catch(() => {});
  if (state.tab === 'downloads') renderDownloads();
  if (state.picker) renderSeasons(); // refresh queued badges
}

// ---------------------------------------------------------------- downloads screen

function renderDownloads() {
  const list = $('downloads-list');
  list.textContent = '';
  $('downloads-empty').classList.toggle('hidden', state.jobs.length > 0);
  for (const j of state.jobs) {
    const card = el('div', 'dl-card');
    card.dataset.id = j.id;

    const top = el('div', 'dl-top');
    const info = el('div', 'dl-info');
    info.appendChild(el('div', 'dl-name', j.title));
    info.appendChild(el('div', 'dl-sub', j.sub || ''));
    top.appendChild(info);

    const actions = el('div', 'dl-actions');
    const pb = el('button', 'dl-btn', j.status === 'active' || j.status === 'queued' ? '⏸' : '▶');
    pb.addEventListener('click', () => {
      if (j.status === 'active' || j.status === 'queued') Jutsu.dlPause({ id: j.id });
      else Jutsu.dlResume({ id: j.id });
    });
    const cb = el('button', 'dl-btn cancel', '✕');
    cb.addEventListener('click', () => Jutsu.dlCancel({ id: j.id }));
    actions.appendChild(pb); actions.appendChild(cb);
    top.appendChild(actions);
    card.appendChild(top);

    const bar = el('div', 'dl-bar' + (j.status === 'paused' || j.status === 'error' ? ' paused' : ''));
    const fill = el('i');
    fill.style.width = (j.pct || 0) + '%';
    bar.appendChild(fill);
    card.appendChild(bar);

    const stats = el('div', 'dl-stats');
    const left = el('span', null, statusText(j));
    if (j.status === 'paused') left.className = 'dl-status-paused';
    if (j.status === 'error') left.className = 'dl-status-error';
    const right = el('span', null, j.total > 0 ? `${fmtMB(j.done)} / ${fmtMB(j.total)}` : '');
    stats.appendChild(left); stats.appendChild(right);
    card.appendChild(stats);

    list.appendChild(card);
  }
}

function statusText(j) {
  if (j.status === 'active') return j.speed > 0 ? `${fmtMB(j.speed)}/с` : 'Скачивание…';
  if (j.status === 'queued') return 'В очереди';
  if (j.status === 'paused') return 'Пауза';
  if (j.status === 'error') return 'Ошибка' + (j.error ? ': ' + j.error : '');
  return '';
}

function patchProgress(p) {
  const j = state.jobs.find((x) => x.id === p.id);
  if (j) { j.done = p.done; j.total = p.total; j.speed = p.speed; j.pct = p.pct; }
  if (state.tab !== 'downloads') return;
  const card = document.querySelector(`.dl-card[data-id="${p.id}"]`);
  if (!card) return;
  card.querySelector('.dl-bar i').style.width = (p.pct || 0) + '%';
  const spans = card.querySelectorAll('.dl-stats span');
  spans[0].textContent = p.speed > 0 ? `${fmtMB(p.speed)}/с` : 'Скачивание…';
  spans[1].textContent = p.total > 0 ? `${fmtMB(p.done)} / ${fmtMB(p.total)}` : '';
}

// ---------------------------------------------------------------- library

async function refreshLibrary() {
  try { state.library = await Jutsu.libraryList(); } catch { state.library = { animes: [], totalBytes: 0 }; }
  renderLibrary();
}

function watchedMap() { return lsGet('jg_watched', {}); }

function renderLibrary() {
  const lib = state.library || { animes: [], totalBytes: 0 };
  const list = $('library-list');
  list.textContent = '';
  $('library-empty').classList.toggle('hidden', lib.animes.length > 0);

  $('disk-val').textContent = fmtSize(lib.totalBytes);
  const denom = lib.totalBytes + (lib.freeBytes || 0);
  $('disk-bar-fill').style.width = denom > 0 ? Math.min(100, Math.round(lib.totalBytes / denom * 100)) + '%' : '0%';

  const watched = watchedMap();
  for (const a of lib.animes) {
    const w = watched[a.slug] || {};
    const seen = a.episodes.filter((e) => (w[`s${e.season}e${e.episode}`] || {}).done).length;

    const card = el('div', 'anime-card');
    const cover = el('div', 'anime-cover');
    if (a.poster) cover.style.backgroundImage = `url('${fileSrc(a.poster)}')`;
    cover.appendChild(el('div', 'anime-season-badge',
      a.seasons > 1 ? `${a.seasons} сезона(ов)` : 'Сезон 1'));
    cover.appendChild(el('div', 'anime-title', a.title));
    cover.addEventListener('click', () => {
      state.expanded = state.expanded === a.slug ? null : a.slug;
      renderLibrary();
    });
    card.appendChild(cover);

    const meta = el('div', 'anime-meta');
    meta.appendChild(el('span', 'm', `${a.count} серий · ${fmtSize(a.bytes)} · просмотрено ${seen}/${a.count}`));
    meta.appendChild(el('span', 't', state.expanded === a.slug ? 'Свернуть ▲' : 'Показать серии ▾'));
    card.appendChild(meta);

    const bar = el('div', 'watch-bar');
    const fill = el('i');
    fill.style.width = a.count > 0 ? Math.round(seen / a.count * 100) + '%' : '0%';
    bar.appendChild(fill);
    card.appendChild(bar);

    if (state.expanded === a.slug) {
      const box = el('div', 'ep-list');
      a.episodes.forEach((e, i) => {
        const row = el('div', 'ep-row');
        row.appendChild(el('span', 'ep-idx', String(i + 1)));
        const info = el('div', 'ep-info');
        info.appendChild(el('div', 'ep-name', e.title));
        const done = (w[`s${e.season}e${e.episode}`] || {}).done;
        info.appendChild(el('div', 'ep-sub', `Сезон ${e.season}${done ? ' · просмотрено' : ''}`));
        row.appendChild(info);
        if (e.quality) row.appendChild(el('span', 'ep-q', e.quality));
        const play = el('button', 'ep-play', '▶');
        play.addEventListener('click', () => openPlayer(a, e));
        row.appendChild(play);
        const del = el('button', 'ep-del', '✕');
        del.addEventListener('click', async () => {
          if (!confirm(`Удалить «${e.title}» (${a.title})?`)) return;
          try { await Jutsu.deleteEpisode({ file: e.file }); } catch {}
          toast('Серия удалена', 'err');
          refreshLibrary();
        });
        row.appendChild(del);
        box.appendChild(row);
      });
      card.appendChild(box);
    }
    list.appendChild(card);
  }
}

// ---------------------------------------------------------------- player

function openPlayer(anime, ep) {
  state.playing = { slug: anime.slug, season: ep.season, episode: ep.episode };
  $('player-title').textContent = `${anime.title} — ${ep.title}`;
  const v = $('player-video');
  v.src = fileSrc(ep.path);
  const w = watchedMap();
  const rec = (w[anime.slug] || {})[`s${ep.season}e${ep.episode}`];
  if (rec && rec.pos && rec.dur && rec.pos < rec.dur * 0.95) {
    v.addEventListener('loadedmetadata', () => { v.currentTime = rec.pos; }, { once: true });
  }
  $('player').classList.remove('hidden');
  syncNative();
  v.play().catch(() => {});
}

let lastSave = 0;
$('player-video').addEventListener('timeupdate', () => {
  const p = state.playing;
  const v = $('player-video');
  if (!p || !v.duration) return;
  const now = Date.now();
  if (now - lastSave < 3000) return;
  lastSave = now;
  const w = watchedMap();
  w[p.slug] = w[p.slug] || {};
  const key = `s${p.season}e${p.episode}`;
  const done = v.currentTime / v.duration >= 0.9 || (w[p.slug][key] || {}).done;
  w[p.slug][key] = { pos: v.currentTime, dur: v.duration, done };
  lsSet('jg_watched', w);
});

function closePlayer(silent) {
  if ($('player').classList.contains('hidden')) return;
  const v = $('player-video');
  v.pause();
  v.removeAttribute('src');
  v.load();
  state.playing = null;
  $('player').classList.add('hidden');
  if (!silent) { renderLibrary(); syncNative(); }
}
$('player-close').addEventListener('click', () => closePlayer(false));

// ---------------------------------------------------------------- download sheet

async function openSheet(pageUrl) {
  $('sheet-backdrop').classList.remove('hidden');
  $('sheet-title').textContent = 'Скачать серию';
  $('sheet-sub').textContent = 'Загрузка информации…';
  $('sheet-quality').textContent = '';
  $('sheet-size').textContent = '—';
  $('sheet-download').disabled = true;
  syncNative();

  try {
    const { html } = await Jutsu.fetchPage({ url: pageUrl });
    const players = JParse.extractPlayers(html);
    const qualities = Object.keys(players).map(Number).sort((a, b) => b - a);
    if (!qualities.length) { closeSheet(); showAuthError(); return; }

    const { season, episode } = JParse.seasonEpFrom(pageUrl);
    const animeTitle = JParse.animeTitleFrom(JParse.extractTitle(html)) || JParse.slugFromUrl(pageUrl);
    const epTitle = `Серия ${episode}`;
    state.sheet = { pageUrl, players, qualities, chosen: null, animeTitle, epTitle, season, episode, html };
    $('sheet-sub').textContent = `${animeTitle} · Сезон ${season} · Серия ${episode}`;

    const saved = lsGet('jg_quality', null);
    const grid = $('sheet-quality');
    for (const q of [1080, 720, 480, 360]) {
      const b = el('button', null, q + 'p');
      if (!players[q]) b.disabled = true;
      b.addEventListener('click', () => chooseQuality(q));
      b.dataset.q = q;
      grid.appendChild(b);
    }
    chooseQuality(players[saved] ? saved : qualities[0]);
    $('sheet-download').disabled = false;
  } catch (e) {
    $('sheet-sub').textContent = 'Ошибка: ' + (e.message || e);
  }
}

async function chooseQuality(q) {
  const s = state.sheet;
  if (!s || !s.players[q]) return;
  s.chosen = q;
  lsSet('jg_quality', q);
  for (const b of $('sheet-quality').children) b.classList.toggle('active', Number(b.dataset.q) === q);
  $('sheet-size').textContent = 'Размер: …';
  try {
    const { length } = await Jutsu.fetchHead({ url: s.players[q] });
    if (state.sheet === s && s.chosen === q)
      $('sheet-size').textContent = 'Размер: ' + (length > 0 ? fmtSize(length) : '—');
  } catch { $('sheet-size').textContent = 'Размер: —'; }
}

$('sheet-download').addEventListener('click', async () => {
  const s = state.sheet;
  if (!s || !s.chosen) return;
  const r = await Jutsu.dlEnqueue({
    items: [{ pageUrl: s.pageUrl, quality: String(s.chosen), animeTitle: s.animeTitle, title: s.epTitle }],
  });
  closeSheet();
  if (r.queued > 0) {
    toast('Добавлено в загрузки', 'ok');
    saveMetaFor(JParse.slugFromUrl(s.pageUrl), s.animeTitle, s.html);
  } else {
    toast('Уже скачано или в очереди');
  }
});

function closeSheet(silent) {
  if ($('sheet-backdrop').classList.contains('hidden')) return;
  $('sheet-backdrop').classList.add('hidden');
  state.sheet = null;
  if (!silent) syncNative();
}
$('sheet-backdrop').addEventListener('click', (e) => { if (e.target === $('sheet-backdrop')) closeSheet(); });

// cache anime title + poster for the library (background, best effort)
async function saveMetaFor(slug, title, html) {
  try {
    await Jutsu.setAnimeMeta({ slug, title });
    let url = html ? JParse.extractBanner(html) : null;
    if (!url && html) {
      const latin = JParse.extractLatinTitle(html);
      if (latin) url = await JParse.fetchAnilistCover(latin);
    }
    if (!url && html) url = JParse.extractPoster(html);
    if (!url) {
      const page = await Jutsu.fetchPage({ url: `https://jut.su/${slug}/` });
      url = JParse.extractBanner(page.html) || JParse.extractPoster(page.html);
    }
    if (url) await Jutsu.savePoster({ slug, url });
  } catch {}
}

// ---------------------------------------------------------------- session-expired modal

let authShown = false;
function showAuthError() {
  if (authShown) return;
  authShown = true;
  $('error-modal').classList.remove('hidden');
  syncNative();
}
$('btn-relogin').addEventListener('click', async () => {
  authShown = false;
  $('error-modal').classList.add('hidden');
  switchTab('browser');
  try { await Jutsu.browserLoad({ url: 'https://jut.su/' }); } catch {}
});

// ---------------------------------------------------------------- episode picker

async function openPicker(slug) {
  $('picker').classList.remove('hidden');
  $('picker-skeleton').classList.remove('hidden');
  $('picker-content').classList.add('hidden');
  $('picker-error').classList.add('hidden');
  state.selected = new Set();
  updateBulk();
  syncNative();

  const rootUrl = `https://jut.su/${slug}/`;
  try {
    const [{ html }, lib] = await Promise.all([
      Jutsu.fetchPage({ url: rootUrl }),
      state.library ? Promise.resolve(state.library) : Jutsu.libraryList(),
    ]);
    state.library = lib;
    const title = JParse.animeTitleFrom(JParse.extractTitle(html)) || slug;
    const paths = JParse.listEpisodes(html);
    if (!paths.length) throw new Error('серии не найдены (нужен вход?)');

    const bySeason = new Map();
    for (const p of paths) {
      const { season, episode } = JParse.seasonEpFrom(p);
      if (!bySeason.has(season)) bySeason.set(season, []);
      bySeason.get(season).push({ path: p, season, episode });
    }
    const seasons = [...bySeason.entries()].sort((a, b) => a[0] - b[0])
      .map(([n, eps]) => ({ season: n, eps: eps.sort((a, b) => a.episode - b.episode) }));

    state.picker = { slug, title, rootUrl, seasons, html };
    $('pk-title').textContent = title;
    $('pk-sub').textContent = `Сезонов: ${seasons.length} · Серий: ${paths.length}`;
    $('pk-poster').style.backgroundImage = '';
    resolvePickerPoster(html);

    renderSeasons();
    $('picker-skeleton').classList.add('hidden');
    $('picker-content').classList.remove('hidden');
    saveMetaFor(slug, title, html);
  } catch (e) {
    $('picker-skeleton').classList.add('hidden');
    $('picker-error').classList.remove('hidden');
    $('picker-error-text').textContent = String(e.message || e);
  }
}

async function resolvePickerPoster(html) {
  let url = JParse.extractBanner(html);
  if (!url) {
    const latin = JParse.extractLatinTitle(html);
    if (latin) url = await JParse.fetchAnilistCover(latin);
  }
  if (!url) url = JParse.extractPoster(html);
  if (url && state.picker) $('pk-poster').style.backgroundImage = `url('${url}')`;
}

function libHas(slug, season, episode) {
  const lib = state.library;
  if (!lib) return false;
  const a = lib.animes.find((x) => x.slug === slug);
  return !!(a && a.episodes.some((e) => e.season === season && e.episode === episode));
}

function queueHas(slug, season, episode) {
  return state.jobs.some((j) => j.slug === slug && j.season === season && j.episode === episode);
}

function renderSeasons() {
  const pk = state.picker;
  if (!pk) return;
  const box = $('pk-seasons');
  box.textContent = '';
  for (const s of pk.seasons) {
    const head = el('div', 'season-head');
    const name = el('span', 'season-name', `Сезон ${s.season}`);
    name.appendChild(el('b', null, String(s.eps.length)));
    head.appendChild(name);
    const pickBtn = el('button', 'season-pick', 'Выбрать');
    pickBtn.addEventListener('click', () => {
      const all = s.eps.every((e) => state.selected.has(e.path) || libHas(pk.slug, e.season, e.episode));
      for (const e of s.eps) {
        if (libHas(pk.slug, e.season, e.episode)) continue;
        if (all) state.selected.delete(e.path); else state.selected.add(e.path);
      }
      renderSeasons(); updateBulk();
    });
    head.appendChild(pickBtn);
    box.appendChild(head);

    for (const e of s.eps) {
      const row = el('div', 'pick-row');
      const have = libHas(pk.slug, e.season, e.episode);
      const queued = queueHas(pk.slug, e.season, e.episode);
      const checked = state.selected.has(e.path);
      if (checked) row.classList.add('checked');
      const check = el('span', 'pick-check', checked ? '✓' : '');
      row.appendChild(check);
      const info = el('div', 'pick-info');
      info.appendChild(el('div', 'pick-name', `Серия ${e.episode}`));
      row.appendChild(info);
      const badge = have ? el('span', 'pick-badge have', '✓ Скачано')
        : queued ? el('span', 'pick-badge queued', 'В очереди')
        : el('span', 'pick-badge none', 'Не скачано');
      row.appendChild(badge);
      if (!have && !queued) {
        row.addEventListener('click', () => {
          if (state.selected.has(e.path)) state.selected.delete(e.path);
          else state.selected.add(e.path);
          row.classList.toggle('checked');
          check.textContent = state.selected.has(e.path) ? '✓' : '';
          updateBulk();
        });
      } else {
        row.style.opacity = '.6';
      }
      box.appendChild(row);
    }
  }
}

function updateBulk() {
  const n = state.selected.size;
  const btn = $('bulk-download');
  btn.textContent = `⬇ Скачать выбранное (${n})`;
  btn.disabled = n === 0;
  const pk = state.picker;
  let allSelectable = 0;
  if (pk) for (const s of pk.seasons) for (const e of s.eps)
    if (!libHas(pk.slug, e.season, e.episode) && !queueHas(pk.slug, e.season, e.episode)) allSelectable++;
  $('bulk-toggle-all').textContent = n > 0 && n >= allSelectable ? 'Снять всё' : 'Выбрать всё';
}

$('bulk-toggle-all').addEventListener('click', () => {
  const pk = state.picker;
  if (!pk) return;
  let allSelectable = [];
  for (const s of pk.seasons) for (const e of s.eps)
    if (!libHas(pk.slug, e.season, e.episode) && !queueHas(pk.slug, e.season, e.episode)) allSelectable.push(e.path);
  if (state.selected.size >= allSelectable.length && allSelectable.length > 0) state.selected.clear();
  else state.selected = new Set(allSelectable);
  renderSeasons(); updateBulk();
});

$('bulk-quality').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  for (const x of $('bulk-quality').children) x.classList.toggle('active', x === b);
  lsSet('jg_batchq', b.dataset.q);
});

$('bulk-download').addEventListener('click', async () => {
  const pk = state.picker;
  if (!pk || !state.selected.size) return;
  const q = ($('bulk-quality').querySelector('.active') || {}).dataset?.q || '1080';
  const items = [...state.selected].map((p) => {
    const { episode } = JParse.seasonEpFrom(p);
    return { pageUrl: 'https://jut.su' + p, quality: q, animeTitle: pk.title, title: `Серия ${episode}` };
  });
  const r = await Jutsu.dlEnqueue({ items });
  saveMetaFor(pk.slug, pk.title, pk.html);
  state.selected.clear();
  closePicker(true);
  toast(`В очереди: ${r.queued}${r.skipped ? ` (пропущено: ${r.skipped})` : ''}`, 'ok');
  switchTab('downloads');
});

function closePicker(silent) {
  if ($('picker').classList.contains('hidden')) return;
  $('picker').classList.add('hidden');
  state.picker = null;
  state.selected = new Set();
  if (!silent) syncNative();
}
$('picker-back').addEventListener('click', () => closePicker(false));

// ---------------------------------------------------------------- wiring

for (const b of document.querySelectorAll('#tabbar .tab'))
  b.addEventListener('click', () => switchTab(b.dataset.tab));

$('btn-reload').addEventListener('click', () => Jutsu.browserReload().catch(() => {}));
$('btn-episodes').addEventListener('click', () => {
  const url = state.url || '';
  const slug = JParse.isJutsu(url) ? JParse.slugFromUrl(url) : null;
  if (slug && slug !== 'anime') openPicker(slug);
  else toast('Открой страницу аниме на jut.su');
});

$('btn-resume-all').addEventListener('click', () => Jutsu.dlResumeAll());
$('btn-cancel-all').addEventListener('click', () => {
  if (state.jobs.length && confirm('Отменить все загрузки?')) Jutsu.dlCancelAll();
});

window.addEventListener('resize', () => requestAnimationFrame(syncNative));

// ---------------------------------------------------------------- init

(async function init() {
  const savedQ = lsGet('jg_batchq', '1080');
  for (const x of $('bulk-quality').children) x.classList.toggle('active', x.dataset.q === savedQ);
  try {
    const d = await Jutsu.dlState();
    state.jobs = d.jobs || [];
    onQueueChanged();
  } catch {}
  refreshLogin();
  refreshLibrary();
  requestAnimationFrame(syncNative);
})();
