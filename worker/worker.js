/*
 * TrailerFeed API — a tiny Cloudflare Worker that sits between the app and TMDB.
 *
 *  - Keeps the TMDB key secret (it's stored in Cloudflare as the secret TMDB_TOKEN, never in this code or the repo).
 *  - Only forwards the few TMDB requests the app actually uses.
 *  - Caches answers so many users share them and TMDB is asked far less often.
 *  - Light per-visitor rate limit so one person can't run up the request count.
 *
 * Settings (Cloudflare dashboard → this Worker → Settings → Variables and Secrets):
 *   TMDB_TOKEN       (Secret)  your TMDB "API Read Access Token" (the long one starting eyJ…)
 *   ALLOWED_ORIGINS  (Text)    comma-separated sites allowed to use this, e.g. https://wesknapp.github.io
 *
 * The app calls  https://<this-worker>/3/discover/movie?…  exactly like it would call api.themoviedb.org/3/…
 */

const TMDB = 'https://api.themoviedb.org';

// Paths the app uses, and how long (seconds) each answer can be reused.
const ROUTES = [
  { re: /^\/3\/genre\/movie\/list$/, ttl: 7 * 86400 },
  { re: /^\/3\/discover\/movie$/, ttl: 30 * 60 },
  { re: /^\/3\/movie\/\d{1,9}$/, ttl: 6 * 3600 },
];

// Query parameters the app sends; anything else is dropped (so the cache can't be flooded with junk variations).
const ALLOWED_PARAMS = new Set([
  'language', 'page', 'sort_by', 'include_adult', 'include_video', 'region', 'with_genres', 'with_original_language',
  'primary_release_date.gte', 'primary_release_date.lte', 'vote_count.gte', 'append_to_response',
]);
const ALLOWED_APPEND = new Set(['videos', 'release_dates', 'watch/providers']);

// Per-visitor limit. Counts live in memory per Cloudflare server, so it's a soft limit, which is enough to stop casual abuse.
const LIMIT_PER_MIN = 240;
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = Math.floor(now / 60000);
  const h = hits.get(ip);
  if (!h || h.win !== win) { hits.set(ip, { win, n: 1 }); if (hits.size > 5000) hits.clear(); return false; }
  return ++h.n > LIMIT_PER_MIN;
}

function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = origin && allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : (allowed[0] || '*'),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (status, body, headers) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json;charset=utf-8', ...headers } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const ch = cors(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });
    if (request.method !== 'GET') return json(405, { error: 'Only GET is allowed' }, ch);

    if (url.pathname === '/' || url.pathname === '/health') {
      return json(200, { ok: true, service: 'TrailerFeed API', tokenSet: !!env.TMDB_TOKEN }, ch);
    }

    // Only the sites you list may use it from a browser.
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed.length && origin && !allowed.includes(origin)) return json(403, { error: 'Origin not allowed' }, ch);

    const route = ROUTES.find((r) => r.re.test(url.pathname));
    if (!route) return json(404, { error: 'Not available through this server' }, ch);
    if (!env.TMDB_TOKEN) return json(500, { error: 'Server is missing its TMDB_TOKEN secret' }, ch);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (limited(ip)) return json(429, { error: 'Too many requests, slow down a little' }, { ...ch, 'Retry-After': '30' });

    // Rebuild the TMDB URL from allowed params only, in a fixed order (better cache hits).
    const upstream = new URL(TMDB + url.pathname);
    [...url.searchParams.keys()].filter((k) => ALLOWED_PARAMS.has(k)).sort().forEach((k) => {
      let v = url.searchParams.get(k).slice(0, 200);
      if (k === 'append_to_response') v = v.split(',').filter((x) => ALLOWED_APPEND.has(x)).join(',');
      if (v) upstream.searchParams.set(k, v);
    });

    // Shared cache (works when the Worker is on your own domain; on workers.dev the browser cache below still helps).
    const cache = caches.default;
    const cacheKey = new Request(upstream.toString(), { method: 'GET' });
    let res = await cache.match(cacheKey);
    if (!res) {
      const r = await fetch(upstream.toString(), {
        headers: { accept: 'application/json', Authorization: 'Bearer ' + env.TMDB_TOKEN },
        cf: { cacheTtl: route.ttl, cacheEverything: true },
      });
      if (!r.ok) {
        // Don't leak TMDB's error details; just pass the status on.
        return json(r.status === 401 ? 502 : r.status, { error: 'TMDB returned ' + r.status }, ch);
      }
      res = new Response(r.body, { status: 200, headers: { 'content-type': 'application/json;charset=utf-8', 'Cache-Control': `public, max-age=${route.ttl}` } });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }

    const out = new Response(res.body, res);
    Object.entries(ch).forEach(([k, v]) => out.headers.set(k, v));
    // Let phones reuse answers too (shorter than the server cache so fixes show up reasonably soon).
    out.headers.set('Cache-Control', `public, max-age=${Math.min(route.ttl, 3600)}`);
    return out;
  },
};
