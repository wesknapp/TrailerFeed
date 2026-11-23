/* TrailerFeed — swipeable feed of fresh movie trailers (TMDB + YouTube).
   Everything (key, taste, history) is stored in this browser's localStorage. */
'use strict';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const DAY = 864e5;

// ---------- storage ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem('tf_' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tf_' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('tf_' + k); } catch {} },
};

let apiKey = LS.get('key', '');
let filters = Object.assign({ windowDays: 30, release: 'new', lang: 'en', genres: [], hideWatched: true }, LS.get('filters', {}));
if (filters.release === 'all') filters.release = 'new'; // old 'Any' setting let classic films in; reset to the default
let taste = LS.get('taste', {});        // genreId -> weight
let history = LS.get('history', {});    // movieId -> summary (watched trailers)
// trailerKey -> times seen (on screen 2s+, counted once per app session). Hidden after SHOW_MAX.
let views = LS.get('views', null);
if (!views) { views = {}; Object.values(history).forEach((h) => { if (h.key) views[h.key] = 1; }); LS.set('views', views); }
const SHOW_MAX = 2;
const countedThisSession = new Set();
let liked = LS.get('liked', {});        // movieId -> summary
let disliked = LS.get('disliked', {});  // movieId -> 1
let genres = LS.get('genres', []);      // [{id,name}]
let muted = true;
// Country for release dates, age ratings and streaming services. Most users are in the UK, so that's the fallback.
const REGIONS = { GB: 'United Kingdom', IE: 'Ireland', US: 'United States', CA: 'Canada', AU: 'Australia', NZ: 'New Zealand',
  DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy', NL: 'Netherlands', SE: 'Sweden', NO: 'Norway', DK: 'Denmark', IN: 'India', ZA: 'South Africa' };
function detectRegion() {
  for (const l of navigator.languages || [navigator.language || '']) { const r = (l.split('-')[1] || '').toUpperCase(); if (REGIONS[r]) return r; }
  return 'GB';
}
let region = LS.get('region', '') || detectRegion();
const flag = (cc) => cc.replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
let view = LS.get('view2', 'fit'); // 'fit' = whole 16:9 frame, 'fill' = zoom to cover the screen (crops the sides)

const $ = (s) => document.querySelector(s);
const feed = $('#feed');
const items = new Map();                // movieId -> movie object
let page = 0, exhausted = false, loading = false;
const seen = new Set();
let active = null, activeSince = 0;

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ymd = (d) => d.toISOString().slice(0, 10);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const genreName = (id) => (genres.find((g) => g.id === id) || {}).name;
const status = (t) => { $('#status').textContent = t || ''; };

function relTime(iso) {
  const d = Math.floor((Date.now() - new Date(iso)) / DAY);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return d + 'd ago';
  if (d < 60) return Math.round(d / 7) + 'w ago';
  if (d < 730) return Math.round(d / 30) + 'mo ago';
  return Math.round(d / 365) + 'y ago';
}
function fmtDate(r) {
  if (!r) return '';
  const d = new Date(r + 'T00:00:00');
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

async function tmdb(path, params = {}, key = apiKey) {
  const url = new URL(API + path);
  const headers = { accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key; // v4 read token
  else url.searchParams.set('api_key', key);                            // v3 key
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url, { headers });
  if (!res.ok) { const e = new Error('TMDB ' + res.status); e.status = res.status; throw e; }
  return res.json();
}

// ---------- setup ----------
function showSetup(err) {
  $('#setup').classList.remove('hidden');
  $('#keyError').textContent = err || '';
  $('#keyInput').value = '';
}
$('#keySave').onclick = async () => {
  const k = $('#keyInput').value.trim();
  if (!k) return;
  $('#keySave').textContent = 'Checking…';
  try {
    const g = await tmdb('/genre/movie/list', { language: 'en-US' }, k);
    apiKey = k; LS.set('key', k);
    genres = g.genres; LS.set('genres', genres);
    $('#setup').classList.add('hidden');
    resetFeed();
  } catch (e) {
    $('#keyError').textContent = e.status === 401 ? "That key didn't work — check you copied the whole thing." : "Couldn't reach TMDB: " + e.message;
  }
  $('#keySave').textContent = 'Start watching';
};

// ---------- feed loading ----------
function discoverParams() {
  const now = Date.now();
  const p = { sort_by: 'popularity.desc', include_adult: 'false', include_video: 'false', language: 'en-US', page };
  // Movie release date: 'new' = out in the last 3 months or coming soon, 'year' = last 12 months or coming soon,
  // 'upcoming' = not out yet, 'any' = every year (old films whose trailers were re-uploaded can show up)
  const back = { new: 90, year: 365 }[filters.release];
  if (back) {
    p['primary_release_date.gte'] = ymd(new Date(now - back * DAY));
    p['primary_release_date.lte'] = ymd(new Date(now + 540 * DAY));
  } else if (filters.release === 'upcoming') {
    p['primary_release_date.gte'] = ymd(new Date(now + DAY));
    p['primary_release_date.lte'] = ymd(new Date(now + 540 * DAY));
  }
  if (filters.lang) p.with_original_language = filters.lang;
  if (filters.genres.length) p.with_genres = filters.genres.join('|'); // OR
  return p;
}

function pickTrailer(vids) {
  const yt = (vids || []).filter((v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
  if (!yt.length) return null;
  yt.sort((a, b) =>
    (b.type === 'Trailer') - (a.type === 'Trailer') ||
    new Date(b.published_at) - new Date(a.published_at) ||
    (b.official === true) - (a.official === true));
  return yt[0];
}

// Double-check the movie's own release date: TMDB's date filter can let old films through on a re-release
// (e.g. an anniversary re-release), so they'd show with their original date from years ago.
function inRelease(m) {
  const back = { new: 90, year: 365 }[filters.release];
  const d = m.release_date;
  if (filters.release === 'upcoming') return !!d && d > ymd(new Date());
  if (back) return !!d && d >= ymd(new Date(Date.now() - back * DAY));
  return true;
}
const inWindow = (m) => !filters.windowDays || Date.now() - new Date(m.trailer.published_at) <= filters.windowDays * DAY;

function tasteScore(m) {
  const ids = m.genre_ids || [];
  if (!ids.length) return 0;
  return ids.reduce((s, g) => s + (taste[g] || 0), 0) / Math.sqrt(ids.length);
}

function rank(batch) {
  // keep TMDB popularity order as the baseline, nudge by learned taste
  return batch
    .map((m, i) => ({ m, s: tasteScore(m) - i * 0.15 }))
    .sort((a, b) => b.s - a.s)
    .map(({ m }) => {
      const top = (m.genre_ids || []).filter((g) => (taste[g] || 0) >= 2).sort((a, b) => taste[b] - taste[a])[0];
      if (top && genreName(top)) m.why = 'Because you like ' + genreName(top);
      return m;
    });
}

async function loadMore() {
  if (loading || exhausted || !apiKey) return;
  loading = true;
  status('Finding trailers…');
  const hadCards = feed.querySelectorAll('.card').length;
  const maxPages = hadCards ? 6 : 15; // dig deeper when the feed is empty (e.g. "past week")
  let added = 0, tried = 0;
  try {
    while (added < 5 && tried < maxPages && !exhausted) {
      page++; tried++;
      const data = await tmdb('/discover/movie', discoverParams());
      if (page >= Math.min(data.total_pages || 0, 500)) exhausted = true;
      const cands = data.results.filter((m) => !seen.has(m.id) && !disliked[m.id] && inRelease(m));
      cands.forEach((m) => seen.add(m.id));
      const withVids = await Promise.all(cands.map(async (m) => {
        try {
          // one call: trailers + per-country release dates + streaming services (JustWatch data via TMDB)
          const v = await tmdb(`/movie/${m.id}`, { language: 'en-US', append_to_response: 'videos,release_dates,watch/providers' });
          const t = pickTrailer(v.videos?.results);
          return t ? Object.assign(m, { trailer: t, local: localRelease(v), providers: v['watch/providers']?.results?.[region] || null }) : null;
        } catch { return null; }
      }));
      const batch = rank(withVids.filter(Boolean).filter(inWindow).filter((m) => !(filters.hideWatched && (views[m.trailer.key] || 0) >= SHOW_MAX)));
      batch.forEach((m) => { renderCard(m); added++; });
    }
  } catch (e) {
    if (e.status === 401) { showSetup('Your TMDB key stopped working — paste it again.'); }
    else status("Couldn't load: " + e.message);
    loading = false;
    return;
  }
  loading = false;
  status('');
  if (!feed.querySelector('.card') && exhausted) {
    feed.innerHTML = '<div class="empty"><div>No trailers match these filters.<br><br>Try a wider date range or fewer categories.</div></div>';
  } else if (!added && !exhausted && !hadCards) {
    // nothing yet but more pages exist — keep digging
    loadMore();
  }
}

function resetFeed() {
  if (active) deactivate(active);
  feed.innerHTML = '';
  feed.scrollTop = 0;
  page = 0; exhausted = false; seen.clear(); items.clear();
  updateFilterLabel();
  loadMore();
}

// ---------- local release info ----------
// TMDB release types: 1 premiere, 2 limited cinema, 3 cinema, 4 digital, 5 physical, 6 TV
function localRelease(v) {
  const rd = (v.release_dates?.results || []).find((r) => r.iso_3166_1 === region)?.release_dates || [];
  const first = (t) => rd.filter((x) => x.type === t).map((x) => x.release_date.slice(0, 10)).sort()[0];
  const wide = first(3), limited = first(2);
  return { cc: region, cinema: wide || limited || null, limited: !wide && !!limited, digital: first(4) || first(6) || null,
    cert: (rd.find((x) => x.certification && x.type === 3) || rd.find((x) => x.certification))?.certification || '' };
}
const daysFrom = (d) => Math.round((new Date(d + 'T00:00:00') - new Date(ymd(new Date()) + 'T00:00:00')) / DAY);

// Works out the headline release line for a card and what buttons make sense.
function releaseInfo(m) {
  const L = m.local || { cc: region }, P = m.providers, today = ymd(new Date());
  const f = flag(L.cc), name = L.cc === 'GB' ? 'UK' : L.cc;
  const streaming = (P?.flatrate || []).map((p) => p.provider_name).slice(0, 3);
  const r = { streaming, canRent: !!(P?.rent || P?.buy), watchLink: P?.link || '' };
  if (L.cinema && L.cinema > today) Object.assign(r, { text: `${f} ${L.limited ? 'Limited cinemas' : 'In cinemas'} ${fmtDate(L.cinema)}`, soon: true, calDate: L.cinema, calKind: 'in cinemas' });
  else if (L.cinema && daysFrom(L.cinema) > -75 && !streaming.length) Object.assign(r, { text: `${f} In cinemas now`, now: true });
  else if (L.digital && L.digital > today) Object.assign(r, { text: `${f} Digital release ${fmtDate(L.digital)}`, soon: true, calDate: L.digital, calKind: 'digital release' });
  else if (!L.cinema && !L.digital && m.release_date > today) Object.assign(r, { text: `Out ${fmtDate(m.release_date)} · ${name} date TBC`, soon: true, calDate: m.release_date, calKind: 'expected release' });
  else { const d = L.cinema || L.digital || m.release_date; if (d) r.text = `Released ${fmtDate(d)}`; }
  // showtimes make sense from ~4 weeks before (pre-booking) until it's left cinemas
  r.showtimes = !!(L.cinema && daysFrom(L.cinema) <= 28 && daysFrom(L.cinema) > -75 && !streaming.length);
  r.cert = L.cert;
  return r;
}

// ---------- calendar ----------
function icsEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => '\\' + c).replace(/\n/g, '\\n'); }
function calEvent(x) { // x: { id, title, calDate, calKind, key }
  const start = x.calDate.replace(/-/g, '');
  const endD = new Date(x.calDate + 'T00:00:00Z'); endD.setUTCDate(endD.getUTCDate() + 1);
  const end = endD.toISOString().slice(0, 10).replace(/-/g, '');
  const title = `🎬 ${x.title} – ${x.calKind}`;
  const details = `Trailer: https://www.youtube.com/watch?v=${x.key}\nShowtimes: ${showtimesUrl(x.title)}\nRelease dates can move – check nearer the time.`;
  return { start, end, title, details };
}
function downloadIcs(x) {
  const e = calEvent(x);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TrailerFeed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:trailerfeed-${x.id}-${e.start}@trailerfeed`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${e.start}`, `DTEND;VALUE=DATE:${e.end}`,
    `SUMMARY:${icsEscape(e.title)}`, `DESCRIPTION:${icsEscape(e.details)}`, 'TRANSP:TRANSPARENT',
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(e.title)} tomorrow`, 'TRIGGER:-PT15H', 'END:VALARM', // 9am the day before
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const file = x.title.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') + '.ics';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  a.download = file; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
function googleCalUrl(x) {
  const e = calEvent(x);
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(e.title) +
    '&dates=' + e.start + '/' + e.end + '&details=' + encodeURIComponent(e.details);
}
let calTarget = null;
function openCal(x) {
  calTarget = x;
  $('#calTitle').textContent = `${x.title} – ${x.calKind} ${fmtDate(x.calDate)}`;
  $('#calSheet').classList.remove('hidden');
}
$('#calIcs').onclick = () => { if (calTarget) downloadIcs(calTarget); $('#calSheet').classList.add('hidden'); };
$('#calGoogle').onclick = () => { if (calTarget) window.open(googleCalUrl(calTarget), '_blank'); $('#calSheet').classList.add('hidden'); };
const showtimesUrl = (title) => 'https://www.google.com/search?q=' + encodeURIComponent(title + (region === 'GB' || region === 'IE' ? ' cinema times near me' : ' showtimes near me'));

// ---------- cards ----------
function renderCard(m) {
  items.set(m.id, m);
  const el = document.createElement('section');
  el.className = 'card';
  el.dataset.id = m.id;
  const back = m.backdrop_path ? IMG + 'w780' + m.backdrop_path : m.poster_path ? IMG + 'w500' + m.poster_path : '';
  const ri = m.rel = releaseInfo(m);
  const g = (m.genre_ids || []).map(genreName).filter(Boolean).slice(0, 3).join(' · ');
  el.innerHTML = `
    <div class="bg" style="background-image:url('${back}')"></div>
    <div class="stage" style="background-image:url('${back}')"><div class="play-hint">▶</div><div class="tap"><span class="paused-ico">▶</span></div></div>
    <div class="info">
      <h2>${esc(m.title)}</h2>
      <div class="meta">
        ${ri.text ? `<span class="badge ${ri.soon ? 'soon' : ri.now ? 'now' : ''}">${esc(ri.text)}</span>` : ''}
        ${ri.cert ? `<span class="cert">${esc(ri.cert)}</span>` : ''}
        <span>🎞 ${esc(m.trailer.type)} ${relTime(m.trailer.published_at)}</span>
        ${g ? `<span>${esc(g)}</span>` : ''}
        ${m.vote_count > 20 ? `<span>★ ${m.vote_average.toFixed(1)}</span>` : ''}
      </div>
      ${ri.streaming.length ? `<div class="stream">📺 On ${esc(ri.streaming.join(', '))}</div>` : ri.canRent && !ri.soon ? `<div class="stream">📺 Rent or buy digitally</div>` : ''}
      <p class="overview">${esc(m.overview)}</p>
      ${ri.calDate || ri.showtimes ? `<div class="chips-row">
        ${ri.calDate ? `<button data-act="cal">📅 Add to calendar</button>` : ''}
        ${ri.showtimes ? `<button data-act="times">🎟 Find showtimes</button>` : ''}
      </div>` : ''}
      ${views[m.trailer.key] ? `<div class="seen">👁 Seen before${filters.hideWatched ? ' · last time it shows' : ''}</div>` : ''}
      ${m.why ? `<div class="why">✨ ${esc(m.why)}</div>` : ''}
    </div>
    <div class="actions">
      <button data-act="like" class="${liked[m.id] ? 'liked' : ''}"><span class="ico">♥</span>Save</button>
      <button data-act="nope"><span class="ico">👎</span>Not for me</button>
      <button data-act="yt"><span class="ico">↗</span>YouTube</button>
    </div>`;
  el.querySelector('.overview').onclick = (e) => e.currentTarget.classList.toggle('open');
  el.querySelector('.stage').onclick = () => { if (active !== el) el.scrollIntoView({ behavior: 'smooth' }); };
  // Fill mode: a transparent layer over the video keeps swipes working and makes a tap pause/play.
  el.querySelector('.tap').onclick = (e) => {
    e.stopPropagation();
    if (active !== el) return el.scrollIntoView({ behavior: 'smooth' });
    if (el.classList.contains('calm')) return wake(el);
    togglePause(el);
  };
  el.querySelector('.chips-row')?.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'cal') openCal({ id: m.id, title: m.title, key: m.trailer.key, calDate: ri.calDate, calKind: ri.calKind });
    else if (b.dataset.act === 'times') window.open(showtimesUrl(m.title), '_blank');
  });
  el.querySelector('.actions').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'like') toggleLike(m, b);
    else if (act === 'nope') nope(m, el);
    else if (act === 'yt') window.open('https://www.youtube.com/watch?v=' + m.trailer.key, '_blank');
  };
  feed.appendChild(el);
  io.observe(el);
}

const summary = (m) => ({ id: m.id, title: m.title, poster: m.poster_path, date: m.release_date, key: m.trailer.key, t: Date.now(),
  calDate: m.rel?.calDate || null, calKind: m.rel?.calKind || '', relText: m.rel?.text || '' });

function adjust(m, delta) {
  (m.genre_ids || []).forEach((g) => { taste[g] = clamp((taste[g] || 0) + delta, -6, 12); });
  LS.set('taste', taste);
}
function toggleLike(m, btn) {
  if (liked[m.id]) { delete liked[m.id]; adjust(m, -2); btn.classList.remove('liked'); }
  else { liked[m.id] = summary(m); adjust(m, 2); btn.classList.add('liked'); }
  LS.set('liked', liked);
}
function nope(m, el) {
  disliked[m.id] = 1; LS.set('disliked', disliked);
  adjust(m, -1.5);
  const next = el.nextElementSibling;
  if (next) next.scrollIntoView({ behavior: 'smooth' });
  setTimeout(() => { if (active === el) deactivate(el); io.unobserve(el); el.remove(); if (!next) loadMore(); }, 450);
}

// ---------- playback ----------
function ytCmd(iframe, func) {
  try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*'); } catch {}
}
function mountPlayer(el) {
  const m = items.get(+el.dataset.id); if (!m) return;
  const stage = el.querySelector('.stage');
  if (stage.querySelector('iframe')) return;
  const k = m.trailer.key;
  const origin = location.origin && location.origin !== 'null' ? '&origin=' + encodeURIComponent(location.origin) : '';
  const f = document.createElement('iframe');
  f.src = `https://www.youtube-nocookie.com/embed/${k}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1&enablejsapi=1&controls=0&disablekb=1&fs=0&iv_load_policy=3&loop=1&playlist=${k}${origin}`;
  f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  f.allowFullscreen = true;
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  f.onload = () => {
    // ask the player to report play/pause so our state stays in sync
    try { f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: k }), '*'); } catch {}
    if (!muted) [300, 1000, 2000].forEach((t) => setTimeout(() => ytCmd(f, 'unMute'), t)); };
  stage.appendChild(f);
}
function unmountPlayer(el) { el.querySelector('.stage iframe')?.remove(); el.classList.remove('paused'); }

// Fade the overlay text/buttons a few seconds into a trailer so the video is visible.
let calmTimer = 0;
function wake(el) {
  el.classList.remove('calm');
  clearTimeout(calmTimer);
  calmTimer = setTimeout(() => { if (active === el && !el.classList.contains('paused')) el.classList.add('calm'); }, 3000);
}
// Player reports its state: 1 = playing, 2 = paused. Keeps our pause icon right when YouTube itself is tapped.
window.addEventListener('message', (e) => {
  if (!/youtube(-nocookie)?\.com$/.test(new URL(e.origin).hostname)) return;
  let d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
  const el = active, f = el?.querySelector('iframe');
  if (!d?.info || !f || e.source !== f.contentWindow) return;
  // currentTime is the trailer's own position: it stays at 0 while a YouTube ad plays, so ads don't count as watching
  if (typeof d.info.currentTime === 'number') { played.got = true; played.t = Math.max(played.t, d.info.currentTime); }
  const st = d.info.playerState;
  if (st === 2 && !el.classList.contains('paused')) { el.classList.add('paused'); clearTimeout(calmTimer); }
  else if (st === 1 && el.classList.contains('paused')) { el.classList.remove('paused'); wake(el); if (!muted) ytCmd(f, 'unMute'); }
});
let played = { got: false, t: 0 }; // how far into the trailer itself the active card got (seconds)
function togglePause(el) {
  const f = el.querySelector('iframe'); if (!f) return;
  const paused = el.classList.toggle('paused');
  if (paused) clearTimeout(calmTimer); else wake(el);
  ytCmd(f, paused ? 'pauseVideo' : 'playVideo');
  if (!paused && !muted) ytCmd(f, 'unMute');
}
function activate(el) {
  if (active === el) return;
  if (active) deactivate(active);
  active = el; activeSince = Date.now(); played = { got: false, t: 0 };
  mountPlayer(el);
  wake(el);
  const cards = [...feed.querySelectorAll('.card')];
  if (cards.indexOf(el) >= cards.length - 3) loadMore();
}
function deactivate(el) {
  if (active !== el) return;
  unmountPlayer(el);
  el.classList.remove('calm');
  learn(items.get(+el.dataset.id), Date.now() - activeSince, played);
  active = null;
}

function learn(m, ms, pl) {
  if (!m) return;
  const wall = ms / 1000;
  // Use real trailer playback when the player reports it (excludes ads/buffering); otherwise fall back to time on screen
  const s = pl?.got ? pl.t : wall;
  if (s >= 2 && !countedThisSession.has(m.trailer.key)) {
    countedThisSession.add(m.trailer.key);
    views[m.trailer.key] = (views[m.trailer.key] || 0) + 1;
    LS.set('views', views);
  }
  if (s >= 15) {
    history[m.id] = summary(m); LS.set('history', history);
    adjust(m, s >= 45 ? 1 : 0.5);
  } else if (wall < 2.5) { // flicked straight past
    adjust(m, -0.2);
  }
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting && e.intersectionRatio >= 0.6) activate(e.target);
    else if (e.target === active && e.intersectionRatio < 0.6) deactivate(e.target);
  }
}, { root: feed, threshold: [0, 0.6] });

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (active) { const el = active; deactivate(el); el.dataset.resume = '1'; } }
  else {
    const el = feed.querySelector('.card[data-resume]');
    if (el) { delete el.dataset.resume; activate(el); }
  }
});

function toggleSound() {
  muted = !muted;
  $('#btnSound').textContent = muted ? '🔇' : '🔊';
  const f = active?.querySelector('iframe');
  if (f) { ytCmd(f, muted ? 'mute' : 'unMute'); if (!muted) ytCmd(f, 'playVideo'); }
}
$('#btnSound').onclick = toggleSound;

// Full screen (PC and Android; iPhone Safari doesn't allow it for web pages, so the button hides there)
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
function toggleFullscreen() {
  const d = document.documentElement;
  if (fsEl()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (d.requestFullscreen || d.webkitRequestFullscreen)?.call(d)?.catch?.(() => {});
}
if (!(document.fullscreenEnabled || document.webkitFullscreenEnabled)) $('#btnFull').classList.add('hidden');
$('#btnFull').onclick = toggleFullscreen;
const onFs = () => document.body.classList.toggle('fs', !!fsEl());
document.addEventListener('fullscreenchange', onFs);
document.addEventListener('webkitfullscreenchange', onFs);

// Keyboard (PC): ↑/↓ or J/K = previous/next, Space = pause, M = sound, F = full screen, V = fit/fill
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if (document.querySelector('.sheet:not(.hidden), #setup:not(.hidden)')) return;
  const k = e.key.toLowerCase();
  const go = (dir) => {
    const cur = active || feed.querySelector('.card');
    const next = cur && (dir > 0 ? cur.nextElementSibling : cur.previousElementSibling);
    if (next?.classList.contains('card')) next.scrollIntoView({ behavior: 'smooth' });
  };
  if (k === 'arrowdown' || k === 'j' || k === 'pagedown') go(1);
  else if (k === 'arrowup' || k === 'k' || k === 'pageup') go(-1);
  else if (k === ' ' && active) togglePause(active);
  else if (k === 'm') toggleSound();
  else if (k === 'f') toggleFullscreen();
  else if (k === 'v') $('#btnView').click();
  else return;
  e.preventDefault();
});

function applyView() {
  document.body.classList.toggle('fill', view === 'fill');
  $('#btnView').textContent = view === 'fill' ? '⤡' : '⤢';
}
$('#btnView').onclick = () => {
  setView(view === 'fill' ? 'fit' : 'fill');
};
function setView(v) {
  view = v;
  LS.set('view2', view);
  applyView();
};
applyView();

// ---------- filters sheet ----------
const REL_LABEL = { new: 'New', year: 'Past year', upcoming: 'Coming soon', any: 'All years' };
let draft = null;

function updateFilterLabel() {
  let t = REL_LABEL[filters.release] || 'New';
  if (filters.genres.length === 1) t += ' · ' + (genreName(filters.genres[0]) || '');
  else if (filters.genres.length > 1) t += ' · ' + filters.genres.length + ' genres';
  $('#filterLabel').textContent = t;
}
function paintSheet() {
  document.querySelectorAll('#windowSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.w === draft.windowDays));
  document.querySelectorAll('#releaseSeg button').forEach((b) => b.classList.toggle('on', b.dataset.r === draft.release));
  document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
  document.querySelectorAll('#langSeg button').forEach((b) => b.classList.toggle('on', b.dataset.lang === (draft.lang || '')));
  $('#genreChips').innerHTML = genres.map((g) => `<button data-g="${g.id}" class="${draft.genres.includes(g.id) ? 'on' : ''}">${esc(g.name)}</button>`).join('');
  $('#hideWatched').checked = draft.hideWatched;
}
$('#btnFilters').onclick = () => { draft = JSON.parse(JSON.stringify(filters)); paintSheet(); $('#filterSheet').classList.remove('hidden'); };
$('#windowSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) { draft.windowDays = +b.dataset.w; paintSheet(); } };
$('#releaseSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) { draft.release = b.dataset.r; paintSheet(); } };
$('#viewSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) { setView(b.dataset.v); paintSheet(); } };
$('#langSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) { draft.lang = b.dataset.lang; paintSheet(); } };
$('#genreChips').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const id = +b.dataset.g;
  draft.genres = draft.genres.includes(id) ? draft.genres.filter((x) => x !== id) : [...draft.genres, id];
  paintSheet();
};
$('#hideWatched').onchange = (e) => { draft.hideWatched = e.target.checked; };
$('#applyFilters').onclick = () => {
  filters = draft; LS.set('filters', filters);
  $('#filterSheet').classList.add('hidden');
  resetFeed();
};
$('#resetTaste').onclick = () => { if (confirm('Forget what you like and start fresh?')) { taste = {}; disliked = {}; LS.del('taste'); LS.del('disliked'); resetFeed(); $('#filterSheet').classList.add('hidden'); } };
$('#clearHistory').onclick = () => { if (confirm('Clear your watched list?')) { history = {}; views = {}; countedThisSession.clear(); LS.del('history'); LS.set('views', views); resetFeed(); $('#filterSheet').classList.add('hidden'); } };
$('#regionSel').innerHTML = Object.entries(REGIONS).map(([c, n]) => `<option value="${c}">${flag(c)} ${n}</option>`).join('');
$('#regionSel').value = region;
$('#regionSel').onchange = (e) => { region = e.target.value; LS.set('region', region); $('#filterSheet').classList.add('hidden'); resetFeed(); };
$('#changeKey').onclick = () => { $('#filterSheet').classList.add('hidden'); showSetup(); };

// ---------- saved / watched sheet ----------
let listMode = 'liked';
function paintList() {
  document.querySelectorAll('#listSeg button').forEach((b) => b.classList.toggle('on', b.dataset.l === listMode));
  const today = ymd(new Date());
  const when = (x) => x.calDate || (x.date > today ? x.date : null);
  let src;
  if (listMode === 'soon') src = Object.values(liked).filter((x) => when(x) && when(x) > today).sort((a, b) => when(a).localeCompare(when(b)));
  else src = Object.values(listMode === 'liked' ? liked : history).sort((a, b) => b.t - a.t);
  const empty = { liked: 'Tap ♥ on a trailer to save it here.', soon: 'Saved movies that aren\'t out yet show here, soonest first.', watched: 'Trailers you watch for 15s+ show up here.' }[listMode];
  $('#listBody').innerHTML = src.length ? src.map((x) => `
    <div class="row" data-id="${x.id}">
      ${x.poster ? `<img src="${IMG + 'w92' + x.poster}" alt="" loading="lazy">` : '<div class="noimg"></div>'}
      <div><div class="t">${esc(x.title)}</div><div class="s">${esc(x.relText || (x.date ? fmtDate(x.date) : ''))}${listMode === 'soon' ? ' · in ' + daysFrom(when(x)) + ' days' : ''}</div></div>
      <div class="row-btns">
        ${when(x) && when(x) > today ? `<button data-cal="${x.id}" aria-label="Add to calendar">📅</button>` : ''}
        <a href="https://www.youtube.com/watch?v=${esc(x.key)}" target="_blank" rel="noopener">▶ Trailer</a>
      </div>
    </div>`).join('') : `<div class="none">${empty}</div>`;
}
$('#listBody').onclick = (e) => {
  const b = e.target.closest('[data-cal]'); if (!b) return;
  const x = liked[b.dataset.cal] || history[b.dataset.cal]; if (!x) return;
  openCal({ id: x.id, title: x.title, key: x.key, calDate: x.calDate || x.date, calKind: x.calKind || 'release' });
};
$('#btnSaved').onclick = () => { paintList(); $('#savedSheet').classList.remove('hidden'); };
$('#listSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) { listMode = b.dataset.l; paintList(); } };

// close buttons + tap outside
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => $('#' + b.dataset.close).classList.add('hidden')));
document.querySelectorAll('.sheet').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s) s.classList.add('hidden'); }));

// ---------- boot ----------
(async function boot() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  updateFilterLabel();
  if (!apiKey) return showSetup();
  if (!genres.length) {
    try { genres = (await tmdb('/genre/movie/list', { language: 'en-US' })).genres; LS.set('genres', genres); }
    catch (e) { if (e.status === 401) return showSetup('Your TMDB key stopped working — paste it again.'); }
  }
  resetFeed();
})();
