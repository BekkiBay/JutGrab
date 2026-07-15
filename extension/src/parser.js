'use strict';
/* Shared jut.su parsing — pure functions, no dependencies.
   Loaded into both the content script and the background worker (globals). */

const JD_QUALITIES = [1080, 720, 480, 360];

function jdDecode1251(buf) {
  return new TextDecoder('windows-1251').decode(buf);
}

// fetch a jut.su page with the user's session cookies (same-site)
async function jdFetchPage(url) {
  const res = await fetch(url, { credentials: 'include', headers: { Accept: 'text/html' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return jdDecode1251(await res.arrayBuffer());
}

// { res(number): url } — real mp4 only, placeholder pixel.png dropped
function jdExtractPlayers(html) {
  const out = {};
  const re = /data-player-(\d+)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const r = +m[1], u = m[2];
    if (u.includes('.mp4') && !u.includes('pixel.png')) out[r] = u;
  }
  return out;
}

function jdExtractTitle(html) {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').trim()
    .replace(/^Смотреть\s+/i, '').replace(/\s+на\s+Jut\.su.*$/i, '').trim();
}

function jdAnimeTitle(pageTitle) {
  if (!pageTitle) return null;
  let t = String(pageTitle).replace(/^Смотреть\s+/i, '').replace(/\s+на\s+Jut\.su.*$/i, '').trim();
  t = t.replace(/\s+\d+\s+сезон\s+\d+\s+серия.*$/i, '').replace(/\s+\d+\s+серия.*$/i, '')
    .replace(/\s+все\s+серии\s+и\s+сезоны.*$/i, '').replace(/\s+смотреть\s+онлайн.*$/i, '');
  return t.trim() || String(pageTitle);
}

function jdExtractLatin(html) {
  const d = /<meta name="description" content="([^"]*)"/i.exec(html);
  if (d) { const m = /\(([A-Za-z][A-Za-z0-9 :!'’,.\-]*)\)/.exec(d[1]); if (m) return m[1].trim(); }
  return null;
}

function jdExtractBanner(html) {
  const m = /chakranature\/background\/anime\/[a-z0-9_-]+\.dark\.jpg/i.exec(html)
    || /chakranature\/background\/anime\/[a-z0-9_-]+\.jpg/i.exec(html);
  return m ? 'https://gen.jut.su/' + m[0] : null;
}

function jdListEpisodes(html) {
  const seen = [];
  const re = /href="(\/[^"]*?\/episode-\d+\.html)"/g;
  let m;
  while ((m = re.exec(html))) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

function jdSeasonEp(url) {
  const p = new URL(url, 'https://jut.su').pathname;
  let m = /\/season-(\d+)\/episode-(\d+)\.html/.exec(p);
  if (m) return { season: +m[1], episode: +m[2] };
  m = /\/episode-(\d+)\.html/.exec(p);
  return { season: 1, episode: m ? +m[1] : 0 };
}

function jdSlug(url) {
  return new URL(url, 'https://jut.su').pathname.split('/').filter(Boolean)[0] || 'anime';
}
function jdIsEpisode(url) {
  return /\/episode-\d+\.html/.test(new URL(url, 'https://jut.su').pathname);
}
function jdIsAnimeRoot(url) {
  return new URL(url, 'https://jut.su').pathname.split('/').filter(Boolean).length === 1;
}

function jdPick(players, quality) {
  const keys = Object.keys(players).map(Number);
  if (!keys.length) return null;
  if (quality === 'max' || !quality) { const r = Math.max(...keys); return { res: r, url: players[r] }; }
  if (quality === 'min') { const r = Math.min(...keys); return { res: r, url: players[r] }; }
  const want = +quality;
  if (players[want]) return { res: want, url: players[want] };
  const lower = keys.filter((k) => k <= want);
  const r = lower.length ? Math.max(...lower) : Math.min(...keys);
  return { res: r, url: players[r] };
}

function jdSanitizeSeg(s) {
  return String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// build a chrome.downloads filename (relative path, sub-folders allowed)
function jdBuildFilename(template, subfolder, info) {
  const s2 = String(info.season).padStart(2, '0');
  const e2 = String(info.episode).padStart(2, '0');
  let pathStr = (template || '{anime}/Season {s}/{anime} S{s}E{e}.mp4')
    .replaceAll('{anime}', jdSanitizeSeg(info.anime))
    .replaceAll('{s}', s2).replaceAll('{e}', e2)
    .replaceAll('{season}', String(info.season)).replaceAll('{episode}', String(info.episode));
  if (!/\.mp4$/i.test(pathStr)) pathStr += '.mp4';
  let segs = pathStr.split('/').map(jdSanitizeSeg).filter((x) => x && x !== '.' && x !== '..');
  const sub = subfolder != null ? String(subfolder) : 'Jutsu';
  const subSegs = sub.split('/').map(jdSanitizeSeg).filter(Boolean);
  return [...subSegs, ...segs].join('/');
}

function jdKey(slug, season, episode) { return `${slug}/s${season}e${episode}`; }
