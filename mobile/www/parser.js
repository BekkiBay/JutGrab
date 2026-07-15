'use strict';
// JS port of app/downloader.js parsing helpers (the validated jut.su
// mechanism): logged-in pages carry real mp4 URLs in data-player-* attrs.
// Pages are fetched by the native side (windows-1251 decoded, session cookies).

const JParse = (() => {
  const BASE = 'https://jut.su';

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

  function extractPlayers(html) {
    const players = {};
    DATA_PLAYER_RE.lastIndex = 0;
    let m;
    while ((m = DATA_PLAYER_RE.exec(html))) {
      const url = m[2];
      if (url.includes('.mp4') && !url.includes('pixel.png')) players[Number(m[1])] = url;
    }
    return players;
  }

  function extractTitle(html) {
    const m = TITLE_RE.exec(html);
    if (!m) return null;
    const t = m[1].replace(/\s+/g, ' ').trim();
    return t.replace(/^Смотреть\s+/i, '').replace(/\s+на\s+Jut\.su\s*$/i, '').trim();
  }

  function animeTitleFrom(pageTitle) {
    if (!pageTitle) return null;
    let t = String(pageTitle).replace(/^Смотреть\s+/i, '').replace(/\s+на\s+Jut\.su.*$/i, '').trim();
    t = t.replace(/\s+\d+\s+сезон\s+\d+\s+серия.*$/i, '').replace(/\s+\d+\s+серия.*$/i, '');
    t = t.replace(/\s+все\s+серии\s+и\s+сезоны.*$/i, '');
    t = t.replace(/\s+смотреть\s+онлайн.*$/i, '');
    return t.trim() || String(pageTitle);
  }

  function extractPoster(html) {
    const m = /https?:\/\/[^"')\s]*\/uploads\/animethumbs\/[^"')\s]+\.(?:jpe?g|png|webp)/i.exec(html);
    if (m) return m[0];
    const og = /property="og:image"\s+content="([^"]+)"/i.exec(html)
      || /content="([^"]+)"\s+property="og:image"/i.exec(html);
    return og ? og[1] : null;
  }

  function extractBanner(html) {
    const m = /chakranature\/background\/anime\/[a-z0-9_-]+\.dark\.jpg/i.exec(html)
      || /chakranature\/background\/anime\/[a-z0-9_-]+\.jpg/i.exec(html);
    return m ? 'https://gen.jut.su/' + m[0] : null;
  }

  function extractLatinTitle(html) {
    const desc = /name="description"\s+content="([^"]*)"/i.exec(html);
    if (!desc) return null;
    const m = /\(([A-Za-z][A-Za-z0-9 :!'’,.\-]*)\)/.exec(desc[1]);
    return m ? m[1].trim() : null;
  }

  async function fetchAnilistCover(search) {
    try {
      const q = 'query($s:String){Media(search:$s,type:ANIME){coverImage{extraLarge large medium}}}';
      const r = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query: q, variables: { s: search } }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      const c = j.data && j.data.Media && j.data.Media.coverImage;
      return c ? (c.extraLarge || c.large || c.medium) : null;
    } catch { return null; }
  }

  function slugFromUrl(url) {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      return parts[0] || 'anime';
    } catch { return 'anime'; }
  }

  function seasonEpFrom(url) {
    const m = SEASON_EP_RE.exec(url);
    if (m) return { season: Number(m[1]), episode: Number(m[2]) };
    const p = PLAIN_EP_RE.exec(url);
    return p ? { season: 1, episode: Number(p[1]) } : { season: 1, episode: 0 };
  }

  function isEpisodeUrl(url) {
    try { return PLAIN_EP_RE.test(new URL(url).pathname); } catch { return false; }
  }

  function listEpisodes(html) {
    const seen = [];
    EPISODE_HREF_RE.lastIndex = 0;
    let m;
    while ((m = EPISODE_HREF_RE.exec(html))) {
      if (!seen.includes(m[1])) seen.push(m[1]);
    }
    return seen;
  }

  return {
    BASE, isJutsu, extractPlayers, extractTitle, animeTitleFrom,
    extractPoster, extractBanner, extractLatinTitle, fetchAnilistCover,
    slugFromUrl, seasonEpFrom, isEpisodeUrl, listEpisodes,
  };
})();
