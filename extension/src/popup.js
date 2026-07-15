'use strict';
const api = globalThis.browser || globalThis.chrome;
const app = document.getElementById('app');
const toastHost = document.getElementById('toasts');

const QSEG = ['1080', '720', '480', '360'];
const state = { queue: [], recent: [], settings: { quality: '1080', theme: 'system' }, progress: {}, tabUrl: null };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const human = (n) => { n = Number(n) || 0; const u = ['Б', 'КБ', 'МБ', 'ГБ']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return (i >= 2 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i]; };
const isJutsuUrl = (u) => /^https?:\/\/([^/]+\.)?jut\.su\//.test(u || '');

function applyTheme(mode) {
  let t = mode; if (!t || t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
}

function activeJobs() { return state.queue.filter((j) => ['active', 'queued', 'paused'].includes(j.status)); }

function header() {
  return `<div class="hdr">
    <div class="logo"><span class="mark">⬇</span> Jutsu Downloader</div>
    <div class="grow"></div>
    <button class="iconbtn" id="gear" title="Настройки">⚙</button>
  </div>`;
}
function qrow() {
  const q = state.settings.quality || '1080';
  return `<div class="qrow">
    <span class="lbl">Качество по умолчанию</span>
    <div class="seg" id="qseg">${QSEG.map((v) => `<button class="${v === q ? 'on' : ''}" data-q="${v}">${v}</button>`).join('')}</div>
  </div>`;
}

function dlRow(j) {
  const p = state.progress[j.id] || {};
  const pct = p.total ? Math.min(100, Math.floor((p.received / p.total) * 100)) : 0;
  const paused = j.status === 'paused' || p.paused;
  const right = paused ? 'Пауза' : j.status === 'queued' ? 'ожидание' : pct + '%';
  const meta = p.total ? `${human(p.received)} / ${human(p.total)} · ${human(p.speed || 0)}/с` : 'подготовка…';
  return `<div class="dlrow" data-id="${j.id}">
    <div class="top">
      <div class="grow" style="min-width:0">
        <div class="dl-title">${esc(j.animeTitle)}</div>
        <div class="dl-sub">С${j.season}·Э${j.episode} · ${esc(j.quality)} · <span class="rpct">${right}</span></div>
      </div>
      <button class="ctrl" data-pause="${j.id}">${paused ? '▶' : '❚❚'}</button>
      <button class="ctrl x" data-cancel="${j.id}">✕</button>
    </div>
    <div class="progress"><i style="width:${pct}%"></i></div>
    <div class="meta rmeta">${meta}</div>
  </div>`;
}

function notJutsu() {
  return header() + `<div class="body"><div class="empty">
    <div class="ic">🌐</div>
    <div style="font-weight:700;color:var(--tx);margin-bottom:6px">Вы не на jut.su</div>
    <div>Откройте jut.su, чтобы качать аниме.</div>
    <div style="margin-top:16px"><button class="btn-accent" id="openJutsu">Открыть jut.su</button></div>
  </div></div>`;
}

function render() {
  if (state.tabUrl && !isJutsuUrl(state.tabUrl)) { app.innerHTML = notJutsu(); wire(); return; }
  const active = activeJobs();
  let body = '';
  if (active.length) {
    body += `<div class="section">
      <div class="section-h"><span class="t">Активные загрузки</span><span class="count">${active.length}</span>
        <div class="grow"></div>
        <button class="btn" id="pauseAll">Пауза всех</button>
        <button class="btn danger" id="cancelAll">Отменить всё</button>
      </div>
      ${active.map(dlRow).join('')}
    </div>`;
  }
  if (state.recent.length) {
    body += `<div class="section">
      <div class="section-h"><span class="t">Недавно скачано</span><button class="tiny-link grow" id="clearRecent" style="text-align:right">очистить</button></div>
      ${state.recent.slice(0, 12).map((r) => `<div class="recent-row">
        <span class="ok-check">✓</span>
        <div class="grow" style="min-width:0"><div class="dl-title">${esc(r.title)}</div><div class="dl-sub">${esc(r.sub || '')}</div></div>
        ${r.dlId != null ? `<span class="tiny-link" data-open="${r.dlId}">Открыть папку</span>` : ''}
      </div>`).join('')}
    </div>`;
  }
  if (!active.length && !state.recent.length) {
    body += `<div class="empty"><div class="ic">📥</div><div style="font-weight:700;color:var(--tx);margin-bottom:6px">Пока пусто</div><div>Открой серию на jut.su и нажми ⬇</div></div>`;
  }
  app.innerHTML = header() + qrow() + `<div class="body">${body}</div>`;
  wire();
}

function wire() {
  const gear = document.getElementById('gear'); if (gear) gear.onclick = () => api.runtime.openOptionsPage();
  const oj = document.getElementById('openJutsu'); if (oj) oj.onclick = () => api.tabs.create({ url: 'https://jut.su/' });
  document.querySelectorAll('#qseg button').forEach((b) => b.onclick = async () => {
    state.settings.quality = b.dataset.q;
    await api.runtime.sendMessage({ type: 'setSettings', settings: { quality: b.dataset.q } });
    render(); toast('ok', `Качество: ${b.dataset.q}p`);
  });
  const pa = document.getElementById('pauseAll'); if (pa) pa.onclick = () => api.runtime.sendMessage({ type: 'pauseAll' });
  const ca = document.getElementById('cancelAll'); if (ca) ca.onclick = () => { api.runtime.sendMessage({ type: 'cancelAll' }); toast('info', 'Очередь очищена'); };
  const cr = document.getElementById('clearRecent'); if (cr) cr.onclick = () => api.runtime.sendMessage({ type: 'clearRecent' });
  document.querySelectorAll('[data-pause]').forEach((b) => b.onclick = () => {
    const j = state.queue.find((x) => x.id === b.dataset.pause);
    const paused = j && (j.status === 'paused' || (state.progress[j.id] && state.progress[j.id].paused));
    api.runtime.sendMessage({ type: paused ? 'resume' : 'pause', id: b.dataset.pause });
  });
  document.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = () => api.runtime.sendMessage({ type: 'cancel', id: b.dataset.cancel }));
  document.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => api.runtime.sendMessage({ type: 'openFolder', dlId: Number(b.dataset.open) }));
}

function applyProgress(items) {
  for (const it of items) state.progress[it.id] = it;
  for (const it of items) {
    const row = document.querySelector(`.dlrow[data-id="${it.id}"]`); if (!row) continue;
    const pct = it.total ? Math.min(100, Math.floor((it.received / it.total) * 100)) : 0;
    const bar = row.querySelector('.progress > i'); if (bar) bar.style.width = pct + '%';
    const rp = row.querySelector('.rpct'); if (rp) rp.textContent = it.paused ? 'Пауза' : pct + '%';
    const rm = row.querySelector('.rmeta'); if (rm && it.total) rm.textContent = `${human(it.received)} / ${human(it.total)} · ${human(it.speed || 0)}/с`;
  }
}

function toast(kind, text) {
  const icons = { ok: '✓', err: '✕', info: '⬇' };
  const n = document.createElement('div'); n.className = 'toast ' + kind;
  n.innerHTML = `<span class="i">${icons[kind] || 'ⓘ'}</span><span>${esc(text)}</span>`;
  toastHost.appendChild(n);
  setTimeout(() => { n.style.transition = 'opacity .3s'; n.style.opacity = '0'; setTimeout(() => n.remove(), 300); }, 3000);
}

// keep the SW alive while the popup is open + receive broadcasts
const port = api.runtime.connect({ name: 'jd-popup' });
const onMsg = (m) => {
  if (!m) return;
  if (m.type === 'state') { state.queue = m.queue || []; state.recent = m.recent || []; render(); }
  else if (m.type === 'progress') applyProgress(m.items || []);
  else if (m.type === 'done') toast('info', `Готово: ${m.title || ''}`);
  else if (m.type === 'auth') toast('err', 'Войдите на jut.su');
};
port.onMessage.addListener(onMsg);
api.runtime.onMessage.addListener(onMsg);

(async () => {
  try { const [tab] = await api.tabs.query({ active: true, currentWindow: true }); state.tabUrl = tab && tab.url; } catch (e) { /* */ }
  try { const st = await api.runtime.sendMessage({ type: 'getSettings' }); if (st) { state.settings = st; applyTheme(st.theme); } } catch (e) { /* */ }
  try { const s = await api.runtime.sendMessage({ type: 'getState' }); if (s) { state.queue = s.queue || []; state.recent = s.recent || []; } } catch (e) { /* */ }
  render();
})();
