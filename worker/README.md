# TrailerFeed server (Cloudflare Worker)

A tiny free server that sits between the app and TMDB so everyone can use TrailerFeed without their own TMDB key.
It keeps your TMDB key secret, only forwards the requests the app needs, caches answers, and rate-limits each visitor.

## Set it up in the Cloudflare dashboard (about 10 minutes, no tools needed)

### 1. Create the Worker
1. Log in at **dash.cloudflare.com** → left menu **Workers & Pages** (under *Compute*).
2. **Create** → **Create Worker** (or *Start with Hello World*).
3. Name it `trailerfeed` → **Deploy**.
4. Click **Edit code**. Delete everything in the editor, paste the whole of [`worker.js`](worker.js), then click **Deploy**.

### 2. Add your TMDB key as a secret
1. Open the Worker → **Settings** → **Variables and Secrets** → **Add**.
2. Type: **Secret**, Name: `TMDB_TOKEN`, Value: your TMDB **API Read Access Token**
   (themoviedb.org → Settings → API, the long one starting `eyJ…`). → **Deploy**.

   A secret can't be read back, even by you, and it never goes in the GitHub repo.

### 3. Say which website may use it
Still in **Variables and Secrets** → **Add**:
- Type: **Text**, Name: `ALLOWED_ORIGINS`, Value: `https://wesknapp.github.io` → **Deploy**.

This is the site's address *without* the `/TrailerFeed` part. If you later use your own domain, add it with a comma:
`https://wesknapp.github.io,https://trailerfeed.example.com`

### 4. Check it works
Copy the Worker's address from its overview page (something like `https://trailerfeed.YOURNAME.workers.dev`)
and open it with `/health` on the end. You should see:

```
{"ok":true,"service":"TrailerFeed API","tokenSet":true}
```

`tokenSet: false` means the secret from step 2 isn't saved yet.

### 5. Point the app at it
In the GitHub repo, open **`config.js`** → pencil icon (Edit) → put your Worker address in `apiBase`:

```js
window.TRAILERFEED_CONFIG = {
  apiBase: 'https://trailerfeed.YOURNAME.workers.dev',
};
```

→ **Commit changes**. GitHub Pages updates in a minute or two. Users then go straight to the feed with no key screen.

## Costs and limits
- Cloudflare's free plan allows **100,000 requests a day**. Opening the feed uses roughly 20–60 requests, and answers are
  cached (on the server when it's on your own domain, and on each phone for up to an hour), so that's plenty for a good number of users.
- If you outgrow it, the paid plan is about $5/month, or you can ask TMDB whether your usage is fine.
- Watch usage under the Worker's **Metrics** tab.

## What it allows
Only these TMDB requests (anything else gets "Not available through this server"):
`/3/genre/movie/list`, `/3/discover/movie`, `/3/movie/{id}` (with videos, release dates and streaming info).
Other websites are blocked, and each visitor is limited to 240 requests a minute.

## Deploying from the command line instead (optional)
```
cd worker
npx wrangler login
npx wrangler secret put TMDB_TOKEN
npx wrangler deploy
```
