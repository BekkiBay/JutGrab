'use strict';
/* Content widget injected on jut.su: a floating FAB + context panel.
   Styles live inside a Shadow DOM so jut.su's CSS can't leak in or out. */
(() => {
  const api = globalThis.browser || globalThis.chrome;
  if (window.__jdWidgetMounted) return;
  window.__jdWidgetMounted = true;

  const QOPTS = [
    { v: '1080', label: '1080p Full HD' },
    { v: '720', label: '720p' },
    { v: '480', label: '480p' },
    { v: '360', label: '360p' },
    { v: 'max', label: 'Максимальное' },
  ];
  const qLabel = (v) => (QOPTS.find((q) => q.v === v) || { label: v }).label;

  const state = {
    open: false, quality: '1080', skip: true, qOpen: false,
    seasons: {}, selectedSeasons: new Set(),
    queue: [], recent: [], progress: {},
    pageType: jdIsEpisode(location.href) ? 'episode' : (jdIsAnimeRoot(location.href) ? 'anime' : 'other'),
  };

  // ---------- styling (scoped to shadow) ----------
  const CSS = `
  :host { all: initial; }
  .wrap { position: fixed; right: 22px; bottom: 22px; z-index: 2147483000;
    font-family: Inter, system-ui, -apple-system, sans-serif; }
  .wrap, .wrap * { box-sizing: border-box; }
  .wrap[data-theme="dark"]{--bg:#181820;--card:#15151C;--chip:#20202B;--btn2:#1E1E28;--bd:#2A2A38;--bd2:#22222E;--tx:#EDEDF2;--mut:#9A9AB0;--mut2:#6B6B80;--accent:#6C5CE7;--ok:#34D399;--warn:#F5A623;--err:#FF5C5C;--track:#26263480;--okbg:#1E3A28;--errbg:#2A1518;--infobg:#241C42;--sh:0 26px 64px -16px rgba(0,0,0,.75);}
  .wrap[data-theme="light"]{--bg:#FFFFFF;--card:#F1F1F6;--chip:#ECECF2;--btn2:#ECECF2;--bd:#DDDDE6;--bd2:#E2E2EA;--tx:#1A1A22;--mut:#6B6B7A;--mut2:#9A9AA8;--accent:#6C5CE7;--ok:#1E9E63;--warn:#C6851B;--err:#E14D4D;--track:#E4E4EC;--okbg:#CDEED9;--errbg:#FBE6E6;--infobg:#EBE8FB;--sh:0 26px 64px -18px rgba(0,0,0,.16);}
  .fab { position: relative; width: 58px; height: 58px; border-radius: 50%; border: none;
    background: var(--accent); color: #fff; font-size: 24px; cursor: pointer; display: flex;
    align-items: center; justify-content: center; box-shadow: 0 10px 30px rgba(108,92,231,.5); }
  .fab:hover { filter: brightness(1.06); }
  .badge { position: absolute; top: -3px; right: -3px; min-width: 20px; height: 20px; padding: 0 6px;
    border-radius: 10px; background: var(--err); border: 2px solid var(--bg); color: #fff; font-size: 11px;
    font-weight: 700; display: flex; align-items: center; justify-content: center; }
  .panel { position: absolute; right: 0; bottom: 70px; width: 344px; background: var(--bg);
    border: 1px solid var(--bd); border-radius: 16px; box-shadow: var(--sh); padding: 16px; color: var(--tx);
    animation: pop .15s ease; }
  @keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.98);} to { opacity: 1; transform: none; } }
  .head { font-size: 15px; font-weight: 800; display: flex; align-items: center; gap: 8px; }
  .badge2 { font-size: 11px; font-weight: 700; color: var(--accent); background: var(--infobg); padding: 2px 8px; border-radius: 8px; }
  .sub { font-size: 12.5px; color: var(--mut); margin-top: 3px; }
  .qsel { position: relative; margin-top: 12px; }
  .qbtn { width: 100%; height: 38px; border-radius: 10px; border: 1px solid var(--bd); background: var(--chip);
    color: var(--tx); font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center;
    justify-content: space-between; padding: 0 13px; }
  .qmenu { position: absolute; left: 0; right: 0; bottom: 44px; background: var(--chip); border: 1px solid var(--bd);
    border-radius: 10px; padding: 5px; box-shadow: var(--sh); z-index: 5; }
  .qopt { padding: 9px 11px; border-radius: 7px; font-size: 13px; color: var(--tx); cursor: pointer; }
  .qopt:hover { background: var(--btn2); } .qopt.sel { color: var(--accent); font-weight: 700; }
  .primary { margin-top: 11px; width: 100%; height: 42px; border-radius: 11px; border: none; background: var(--accent);
    color: #fff; font-weight: 700; font-size: 13.5px; cursor: pointer; box-shadow: 0 8px 20px rgba(108,92,231,.4); }
  .primary:hover { filter: brightness(1.05); }
  .link { display: inline-block; margin-top: 11px; font-size: 12.5px; color: #8B7CF0; cursor: pointer; }
  .link:hover { color: #A99CF7; }
  .seasons { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
  .chip { padding: 6px 12px; border-radius: 9px; border: 1px solid var(--bd); background: var(--chip);
    color: var(--tx); font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .toggle { display: flex; align-items: center; justify-content: space-between; margin-top: 13px; font-size: 13px; color: var(--tx); }
  .sw { width: 40px; height: 23px; border-radius: 12px; background: #3A3A4C; position: relative; cursor: pointer; transition: background .15s; }
  .sw.on { background: var(--accent); } .sw i { position: absolute; top: 2px; left: 2px; width: 19px; height: 19px;
    border-radius: 50%; background: #fff; transition: left .15s; } .sw.on i { left: 19px; }
  .stat { margin-top: 12px; font-size: 12px; color: var(--mut); }
  .mini { margin-top: 14px; border-top: 1px solid var(--bd2); padding-top: 12px; max-height: 168px; overflow-y: auto; }
  .mini-h { font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--mut2); margin-bottom: 9px; }
  .row { margin-bottom: 10px; }
  .row-top { display: flex; align-items: center; gap: 8px; }
  .row-title { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row-pct { font-size: 11.5px; color: var(--mut); }
  .row-ctrl { width: 24px; height: 24px; border-radius: 7px; border: none; background: var(--chip); color: var(--tx); font-size: 11px; cursor: pointer; }
  .row-ctrl.x { color: var(--err); }
  .bar { margin-top: 6px; height: 5px; border-radius: 3px; background: var(--track); overflow: hidden; }
  .bar > i { display: block; height: 100%; background: var(--accent); border-radius: 3px; transition: width .5s linear; }
  .toasts { position: fixed; right: 22px; bottom: 92px; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  .toast { display: flex; align-items: center; gap: 9px; background: var(--card); border: 1px solid var(--bd); border-radius: 11px;
    padding: 10px 14px; box-shadow: var(--sh); font-size: 13px; font-weight: 600; color: var(--tx); animation: pop .2s ease; }
  .toast .i { width: 20px; height: 20px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 11px; }
  .toast.ok .i { background: var(--okbg); color: var(--ok); } .toast.err .i { background: var(--errbg); color: var(--err); }
  .toast.info .i { background: var(--infobg); color: #8B7CF0; }
  .hidden { display: none !important; }`;

  // ---------- mount ----------
  const host = document.createElement('div');
  host.id = 'jd-widget-host';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = CSS; root.appendChild(style);
  const wrap = document.createElement('div'); wrap.className = 'wrap'; root.appendChild(wrap);

  function applyTheme(mode) {
    let t = mode;
    if (!t || t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    wrap.dataset.theme = t;
  }
  applyTheme('dark');

  const human = (n) => { n = Number(n) || 0; const u = ['Б', 'КБ', 'МБ', 'ГБ']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return (i >= 2 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i]; };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- render ----------
  function activeJobs() { return state.queue.filter((j) => j.status === 'active' || j.status === 'queued' || j.status === 'paused'); }

  function render() {
    const badge = activeJobs().length;
    wrap.innerHTML = `
      <div class="panel ${state.open ? '' : 'hidden'}">${panelHTML()}</div>
      <button class="fab" id="fab">⬇${badge ? `<span class="badge">${badge}</span>` : ''}</button>
      <div class="toasts" id="toasts"></div>`;
    wire();
    // re-mount toasts container content is transient; toasts use a separate persistent node
    mountToasts();
  }

  function qselHTML(cur) {
    const menu = state.qOpen ? `<div class="qmenu">${QOPTS.map((q) => `<div class="qopt ${q.v === cur ? 'sel' : ''}" data-q="${q.v}">${q.label}</div>`).join('')}</div>` : '';
    return `<div class="qsel"><button class="qbtn" id="qbtn"><span>Качество: ${qLabel(cur)}</span><span style="color:var(--mut)">▾</span></button>${menu}</div>`;
  }

  function miniHTML() {
    const jobs = activeJobs();
    if (!jobs.length) return '';
    const rows = jobs.slice(0, 6).map((j) => {
      const p = state.progress[j.id] || {};
      const pct = p.total ? Math.min(100, Math.floor((p.received / p.total) * 100)) : 0;
      const label = j.status === 'paused' || p.paused ? 'Пауза' : j.status === 'queued' ? 'ожидание' : pct + '%';
      const ctrl = (j.status === 'paused' || p.paused) ? '▶' : '❚❚';
      return `<div class="row" data-id="${j.id}">
        <div class="row-top">
          <div class="row-title">${esc(j.animeTitle)} — С${j.season}·Э${j.episode}</div>
          <span class="row-pct">${label}</span>
          <button class="row-ctrl" data-pause="${j.id}">${ctrl}</button>
          <button class="row-ctrl x" data-cancel="${j.id}">✕</button>
        </div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>`;
    }).join('');
    return `<div class="mini"><div class="mini-h">Загрузки (${jobs.length})</div>${rows}</div>`;
  }

  function panelHTML() {
    if (state.pageType === 'episode') {
      const { season, episode } = jdSeasonEp(location.href);
      const anime = jdAnimeTitle(document.title) || jdSlug(location.href);
      return `
        <div class="head">Скачать эту серию</div>
        <div class="sub">${esc(anime)} · Сезон ${season} · Серия ${episode}</div>
        ${qselHTML(state.quality)}
        <button class="primary" id="dlEp">⬇ Скачать серию</button>
        <div style="margin-top:11px;display:flex;gap:16px">
          <span class="link" id="dlSeason">Скачать весь сезон →</span>
          <span class="link" id="copyLink">⧉ Скопировать ссылку</span>
        </div>
        ${miniHTML()}`;
    }
    if (state.pageType === 'anime') {
      const seasonNums = Object.keys(state.seasons).map(Number).sort((a, b) => a - b);
      const total = seasonNums.reduce((n, s) => n + state.seasons[s].length, 0);
      const chips = seasonNums.map((s) => `<button class="chip ${state.selectedSeasons.has(s) ? 'on' : ''}" data-season="${s}">Сезон ${s}</button>`).join('');
      const sel = state.selectedSeasons.size;
      const selCount = sel ? [...state.selectedSeasons].reduce((n, s) => n + (state.seasons[s] ? state.seasons[s].length : 0), 0) : total;
      const btnLabel = sel ? `⬇ Скачать сезоны (${selCount})` : `⬇ Скачать всё аниме`;
      return `
        <div class="head">${esc(jdAnimeTitle(document.title) || 'Аниме')} <span class="badge2">${total} серий</span></div>
        <div class="sub">Пакетная загрузка</div>
        <div class="seasons">${chips}</div>
        ${qselHTML(state.quality)}
        <div class="toggle">Пропускать уже скачанные <span class="sw ${state.skip ? 'on' : ''}" id="skipSw"><i></i></span></div>
        <button class="primary" id="dlBatch">${btnLabel}</button>
        ${miniHTML()}`;
    }
    return `
      <div class="head">Jutsu Downloader</div>
      <div class="sub">Откройте страницу серии или аниме на jut.su.</div>
      ${miniHTML()}`;
  }

  // ---------- toasts (persist across re-render) ----------
  let toastHost = null;
  function mountToasts() { toastHost = wrap.querySelector('#toasts'); }
  function toast(kind, text) {
    if (!toastHost) return;
    const icons = { ok: '✓', err: '✕', info: '⬇' };
    const n = document.createElement('div');
    n.className = 'toast ' + kind;
    n.innerHTML = `<span class="i">${icons[kind] || 'ⓘ'}</span><span>${esc(text)}</span>`;
    toastHost.appendChild(n);
    setTimeout(() => { n.style.transition = 'opacity .3s'; n.style.opacity = '0'; setTimeout(() => n.remove(), 300); }, 3400);
  }

  // ---------- wiring ----------
  function wire() {
    const fab = wrap.querySelector('#fab');
    if (fab) fab.onclick = () => { state.open = !state.open; state.qOpen = false; render(); };

    const qbtn = wrap.querySelector('#qbtn');
    if (qbtn) qbtn.onclick = () => { state.qOpen = !state.qOpen; render(); };
    wrap.querySelectorAll('.qopt').forEach((o) => o.onclick = () => { state.quality = o.dataset.q; state.qOpen = false; render(); });

    const dlEp = wrap.querySelector('#dlEp');
    if (dlEp) dlEp.onclick = () => {
      const anime = jdAnimeTitle(document.title) || jdSlug(location.href);
      enqueue([{ pageUrl: location.href, quality: state.quality, animeTitle: anime }]);
    };
    const dlSeason = wrap.querySelector('#dlSeason');
    if (dlSeason) dlSeason.onclick = downloadCurrentSeason;
    const copyLink = wrap.querySelector('#copyLink');
    if (copyLink) copyLink.onclick = copyCurrentLink;

    wrap.querySelectorAll('[data-season]').forEach((c) => c.onclick = () => {
      const s = Number(c.dataset.season);
      if (state.selectedSeasons.has(s)) state.selectedSeasons.delete(s); else state.selectedSeasons.add(s);
      render();
    });
    const skipSw = wrap.querySelector('#skipSw');
    if (skipSw) skipSw.onclick = async () => { state.skip = !state.skip; await api.runtime.sendMessage({ type: 'setSettings', settings: { skip: state.skip } }); render(); };
    const dlBatch = wrap.querySelector('#dlBatch');
    if (dlBatch) dlBatch.onclick = downloadBatch;

    wrap.querySelectorAll('[data-pause]').forEach((b) => b.onclick = () => {
      const j = state.queue.find((x) => x.id === b.dataset.pause);
      const paused = j && (j.status === 'paused' || (state.progress[j.id] && state.progress[j.id].paused));
      api.runtime.sendMessage({ type: paused ? 'resume' : 'pause', id: b.dataset.pause });
    });
    wrap.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = () => api.runtime.sendMessage({ type: 'cancel', id: b.dataset.cancel }));
  }

  const animeTitleNow = () => jdAnimeTitle(document.title) || jdSlug(location.href);

  async function enqueue(items) {
    try {
      const r = await api.runtime.sendMessage({ type: 'enqueue', items });
      toast('info', `В очередь: ${r.added}${r.skipped ? `, пропущено ${r.skipped}` : ''}`);
    } catch (e) { toast('err', 'Не удалось добавить'); }
  }

  async function downloadBatch() {
    const seasonNums = Object.keys(state.seasons).map(Number);
    const targetSeasons = state.selectedSeasons.size ? [...state.selectedSeasons] : seasonNums;
    const items = [];
    for (const s of targetSeasons) for (const url of (state.seasons[s] || [])) {
      items.push({ pageUrl: url, quality: state.quality, animeTitle: animeTitleNow() });
    }
    if (!items.length) { toast('err', 'Нет серий'); return; }
    enqueue(items);
  }

  async function copyCurrentLink() {
    const players = jdExtractPlayers(document.documentElement.outerHTML);
    const picked = jdPick(players, state.quality);
    if (!picked) { toast('err', 'Ссылка не найдена — вы залогинены?'); return; }
    try { await navigator.clipboard.writeText(picked.url); toast('ok', `Ссылка ${picked.res}p скопирована`); }
    catch (e) { toast('err', 'Не удалось скопировать'); }
  }

  async function downloadCurrentSeason() {
    const { season } = jdSeasonEp(location.href);
    const slug = jdSlug(location.href);
    try {
      const html = await jdFetchPage(`https://jut.su/${slug}/`);
      const items = jdListEpisodes(html)
        .map((p) => 'https://jut.su' + p)
        .filter((u) => jdSeasonEp(u).season === season)
        .map((u) => ({ pageUrl: u, quality: state.quality, animeTitle: animeTitleNow() }));
      if (!items.length) { toast('err', 'Серии сезона не найдены'); return; }
      enqueue(items);
    } catch (e) { toast('err', 'Не удалось прочитать список серий'); }
  }

  function applyProgress(items) {
    for (const it of items) state.progress[it.id] = it;
    // patch bars in place (avoid full re-render churn)
    for (const it of items) {
      const row = wrap.querySelector(`.row[data-id="${it.id}"]`);
      if (!row) continue;
      const pct = it.total ? Math.min(100, Math.floor((it.received / it.total) * 100)) : 0;
      const bar = row.querySelector('.bar > i'); if (bar) bar.style.width = pct + '%';
      const lbl = row.querySelector('.row-pct'); if (lbl) lbl.textContent = it.paused ? 'Пауза' : pct + '%';
    }
  }

  // ---------- background link ----------
  const port = api.runtime.connect({ name: 'jd-widget' });
  const onMsg = (m) => {
    if (!m) return;
    if (m.type === 'state') { state.queue = m.queue || []; state.recent = m.recent || []; render(); }
    else if (m.type === 'progress') { applyProgress(m.items || []); }
    else if (m.type === 'done') { toast('info', `Готово: ${m.title || ''}`); }
    else if (m.type === 'auth') { toast('err', 'Войдите на jut.su'); }
  };
  port.onMessage.addListener(onMsg);
  api.runtime.onMessage.addListener(onMsg);

  // init
  (async () => {
    try {
      const st = await api.runtime.sendMessage({ type: 'getSettings' });
      if (st) { state.quality = st.quality || '1080'; state.skip = st.skip !== false; applyTheme(st.theme); }
    } catch (e) { /* */ }
    if (state.pageType === 'anime') {
      const groups = {};
      for (const p of jdListEpisodes(document.documentElement.outerHTML)) {
        const url = 'https://jut.su' + p; const { season } = jdSeasonEp(url);
        (groups[season] = groups[season] || []).push(url);
      }
      state.seasons = groups;
    }
    try { const s = await api.runtime.sendMessage({ type: 'getState' }); if (s) { state.queue = s.queue || []; state.recent = s.recent || []; } } catch (e) { /* */ }
    render();
  })();
})();
