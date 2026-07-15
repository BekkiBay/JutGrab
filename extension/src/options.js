'use strict';
const api = globalThis.browser || globalThis.chrome;
const toastHost = document.getElementById('toasts');
const QSEG = ['1080', '720', '480', '360'];
const DEFAULTS = { quality: '1080', template: '{anime}/Season {s}/{anime} S{s}E{e}.mp4', subfolder: 'Jutsu', concurrency: 3, skip: true, theme: 'system' };

let settings = { ...DEFAULTS };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function applyTheme(mode) {
  let t = mode; if (!t || t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
}
function sanitizeSeg(s) { return String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function previewName() {
  const info = { anime: 'Fairy Tail', season: 1, episode: 5 };
  const s2 = '01', e2 = '05';
  let p = (settings.template || DEFAULTS.template)
    .replaceAll('{anime}', sanitizeSeg(info.anime)).replaceAll('{s}', s2).replaceAll('{e}', e2)
    .replaceAll('{season}', '1').replaceAll('{episode}', '5');
  if (!/\.mp4$/i.test(p)) p += '.mp4';
  let segs = p.split('/').map(sanitizeSeg).filter((x) => x && x !== '.' && x !== '..');
  const sub = (settings.subfolder != null ? String(settings.subfolder) : 'Jutsu').split('/').map(sanitizeSeg).filter(Boolean);
  return ['…', 'Downloads', ...sub, ...segs].join(' / ');
}

function paintSeg(el, values, current, attr) {
  el.innerHTML = values.map((v) => `<button class="${v.v === current ? 'on' : ''}" ${attr}="${v.v}">${v.label}</button>`).join('');
}

function renderStatic() {
  paintSeg($('qseg'), QSEG.map((v) => ({ v, label: v })), settings.quality, 'data-q');
  $('template').value = settings.template;
  $('subfolder').value = settings.subfolder;
  $('cVal').textContent = settings.concurrency;
  $('skipSw').classList.toggle('on', settings.skip !== false);
  document.querySelectorAll('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.t === (settings.theme || 'system')));
  $('preview').textContent = previewName();
  applyTheme(settings.theme);
}

async function save(patch, msg) {
  settings = { ...settings, ...patch };
  await api.runtime.sendMessage({ type: 'setSettings', settings: patch });
  if (msg) toast('ok', msg);
}

function toast(kind, text) {
  const icons = { ok: '✓', err: '✕', info: '⬇' };
  const n = document.createElement('div'); n.className = 'toast ' + kind;
  n.innerHTML = `<span class="i">${icons[kind] || 'ⓘ'}</span><span>${esc(text)}</span>`;
  toastHost.appendChild(n);
  setTimeout(() => { n.style.transition = 'opacity .3s'; n.style.opacity = '0'; setTimeout(() => n.remove(), 300); }, 2400);
}

function wire() {
  $('qseg').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (!b) return; save({ quality: b.dataset.q }, 'Сохранено'); renderStatic(); });
  $('themeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (!b) return; save({ theme: b.dataset.t }, 'Тема обновлена'); renderStatic(); });
  $('template').addEventListener('input', () => { settings.template = $('template').value; $('preview').textContent = previewName(); });
  $('template').addEventListener('change', () => save({ template: $('template').value || DEFAULTS.template }, 'Шаблон сохранён'));
  $('subfolder').addEventListener('input', () => { settings.subfolder = $('subfolder').value; $('preview').textContent = previewName(); });
  $('subfolder').addEventListener('change', () => save({ subfolder: $('subfolder').value }, 'Сохранено'));
  $('cMinus').onclick = () => { const v = Math.max(1, (settings.concurrency || 3) - 1); save({ concurrency: v }); $('cVal').textContent = v; };
  $('cPlus').onclick = () => { const v = Math.min(5, (settings.concurrency || 3) + 1); save({ concurrency: v }); $('cVal').textContent = v; };
  $('skipSw').onclick = () => { const v = !(settings.skip !== false); save({ skip: v }); $('skipSw').classList.toggle('on', v); };
}

(async () => {
  try { const st = await api.runtime.sendMessage({ type: 'getSettings' }); if (st) settings = { ...DEFAULTS, ...st }; } catch (e) { /* */ }
  renderStatic();
  wire();
})();
