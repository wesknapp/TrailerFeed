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
let filters = Object.assign({ windowDays: 30, release: 'new', genres: [], hideWatched: true }, LS.get('filters', {}));
let taste = LS.get('taste', {});        // genreId -> weight
let history = LS.get('history', {});    // movieId -> summary (watched trailers)
let liked = LS.get('liked', {});        // movieId -> summary
let disliked = LS.get('disliked', {});  // movieId -> 1
let genres = LS.get('genres', []);      // [{id,name}]
let muted = true;

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
  if (filters.release === 'new') {
    p['primary_release_date.gte'] = ymd(new Date(now - 120 * DAY));
    p['primary_release_date.lte'] = ymd(new Date(now + 365 * DAY));
  } else if (filters.release === 'upcoming') {
    p['primary_release_date.gte'] = ymd(new Date(now + DAY));
    p['primary_release_date.lte'] = ymd(new Date(now + 540 * DAY));
  }
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
      const cands = data.results.filter((m) => !seen.has(m.id) && !disliked[m.id]);
      cands.forEach((m) => seen.add(m.id));
      const withVids = await Promise.all(cands.map(async (m) => {
        try {
          const v = await tmdb(`/movie/${m.id}/videos`, { language: 'en-US' });
          const t = pickTrailer(v.results);
          return t ? Object.assign(m, { trailer: t }) : null;
        } catch { return null; }
      }));
      const batch = rank(withVids.filter(Boolean).filter(inWindow).filter((m) => !(filters.hideWatched && history[m.id])));
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

// ---------- cards ----------
function renderCard(m) {
  items.set(m.id, m);
  const el = document.createElement('section');
  el.className = 'card';
  el.dataset.id = m.id;
  const back = m.backdrop_path ? IMG + 'w780' + m.backdrop_path : m.poster_path ? IMG + 'w500' + m.poster_path : '';
  const today = ymd(new Date());
  const upcoming = m.release_date && m.release_date > today;
  const g = (m.genre_ids || []).map(genreName).filter(Boolean).slice(0, 3).join(' · ');
  el.innerHTML = `
    <div class="bg" style="background-image:url('${back}')"></div>
    <div class="stage" style="background-image:url('${back}')"><div class="play-hint">▶</div></div>
    <div class="info">
      <h2>${esc(m.title)}</h2>
      <div class="meta">
        ${m.release_date ? `<span class="badge ${upcoming ? 'soon' : ''}">${upcoming ? 'Out ' + fmtDate(m.release_date) : 'Released ' + fmtDate(m.release_date)}</span>` : ''}
        <span>🎞 ${esc(m.trailer.type)} ${relTime(m.trailer.published_at)}</span>
        ${g ? `<span>${esc(g)}</span>` : ''}
        ${m.vote_count > 20 ? `<span>★ ${m.vote_average.toFixed(1)}</span>` : ''}
      </div>
      <p class="overview">${esc(m.overview)}</p>
      ${m.why ? `<div class="why">✨ ${esc(m.why)}</div>` : ''}
    </div>
    <div class="actions">
      <button data-act="like" class="${liked[m.id] ? 'liked' : ''}"><span class="ico">♥</span>Save</button>
      <button data-act="nope"><span class="ico">👎</span>Not for me</button>
      <button data-act="yt"><span class="ico">↗</span>YouTube</button>
    </div>`;
  el.querySelector('.overview').onclick = (e) => e.currentTarget.classList.toggle('open');
  el.querySelector('.stage').onclick = () => { if (active !== el) el.scrollIntoView({ behavior: 'smooth' }); };
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

const summary = (m) => ({ id: m.id, title: m.title, poster: m.poster_path, date: m.release_date, key: m.trailer.key, t: Date.now() });

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
  f.src = `https://www.youtube-nocookie.com/embed/${k}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1&enablejsapi=1&loop=1&playlist=${k}${origin}`;
  f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  f.allowFullscreen = true;
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  f.onload = () => { if (!muted) [300, 1000, 2000].forEach((t) => setTimeout(() => ytCmd(f, 'unMute'), t)); };
  stage.appendChild(f);
}
function unmountPlayer(el) { el.querySelector('.stage iframe')?.remove(); }

function activate(el) {
  if (active === el) return;
  if (active) deactivate(active);
  active = el; activeSince = Date.now();
  mountPlayer(el);
  const cards = [...feed.querySelectorAll('.card')];
  if (cards.indexOf(el) >= cards.length - 3) loadMore();
}
function deactivate(el) {
  if (active !== el) return;
  unmountPlayer(el);
  learn(items.get(+el.dataset.id), Date.now() - activeSince);
  active = null;
}

function learn(m, ms) {
  if (!m) return;
  const s = ms / 1000;
  if (s >= 15) {
    history[m.id] = summary(m); LS.set('history', history);
    adjust(m, s >= 45 ? 1 : 0.5);
  } else if (s < 2.5) {
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

$('#btnSound').onclick = () => {
  muted = !muted;
  $('#btnSound').textContent = muted ? '🔇' : '🔊';
  const f = active?.querySelector('iframe');
  if (f) { ytCmd(f, muted ? 'mute' : 'unMute'); if (!muted) ytCmd(f, 'playVideo'); }
};

// ---------- filters sheet ----------
const WIN_LABEL = { 7: 'Past week', 30: 'Past month', 90: 'Past 3 months', 0: 'Any time' };
let draft = null;

function updateFilterLabel() {
  let t = WIN_LABEL[filters.windowDays] || 'Any time';
  if (filters.genres.length === 1) t += ' · ' + (genreName(filters.genres[0]) || '');
  else if (filters.genres.length > 1) t += ' · ' + filters.genres.length + ' genres';
  $('#filterLabel').textContent = t;
}
function paintSheet() {
  document.querySelectorAll('#windowSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.w === draft.windowDays));
  document.querySelectorAll('#releaseSeg button').forEach((b) => b.classList.toggle('on', b.dataset.r === draft.release));
  $('#genreChips').innerHTML = genres.map((g) => `<button data-g="${g.id}" class="${draft.genres.includes(g.id) ? 'on' : ''}">${esc(g.name)}</button>`).join('');
  $('#hideWatched').checked = draft.hideWatched;
}
$('#btnFilters').onclick = () => { draft = JSON.parse(JSON.stringify(filters)); paintSheet(); $('#filterSheet').classList.remove('hidden'); };
$('#windowSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) { draft.windowDays = +b.dataset.w; paintSheet(); } };
$('#releaseSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) { draft.release = b.dataset.r; paintSheet(); } };
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
$('#clearHistory').onclick = () => { if (confirm('Clear your watched list?')) { history = {}; LS.del('history'); resetFeed(); $('#filterSheet').classList.add('hidden'); } };
$('#changeKey').onclick = () => { $('#filterSheet').classList.add('hidden'); showSetup(); };

// ---------- saved / watched sheet ----------
let listMode = 'liked';
function paintList() {
  document.querySelectorAll('#listSeg button').forEach((b) => b.classList.toggle('on', b.dataset.l === listMode));
  const src = Object.values(listMode === 'liked' ? liked : history).sort((a, b) => b.t - a.t);
  $('#listBody').innerHTML = src.length ? src.map((x) => `
    <div class="row">
      <img src="${x.poster ? IMG + 'w92' + x.poster : ''}" alt="" loading="lazy">
      <div><div class="t">${esc(x.title)}</div><div class="s">${x.date ? fmtDate(x.date) : ''}</div></div>
      <a href="https://www.youtube.com/watch?v=${esc(x.key)}" target="_blank" rel="noopener">▶ Trailer</a>
    </div>`).join('') : `<div class="none">${listMode === 'liked' ? 'Tap ♥ on a trailer to save it here.' : 'Trailers you watch for 15s+ show up here.'}</div>`;
}
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
