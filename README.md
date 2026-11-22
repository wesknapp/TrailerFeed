# TrailerFeed

A swipeable, Reels-style feed of fresh movie trailers. No accounts and no server. Your TMDB key, saved list, watch history and taste profile are all stored in your browser's localStorage.

## Put it on GitHub Pages
1. Create a new **public** repo (e.g. `trailerfeed`). Pages is free for public repos.
2. Upload every file in this folder (including `icons/`) to the repo root.
3. Repo **Settings → Pages → Source: Deploy from a branch → `main` / root → Save**.
4. After about a minute it's live at `https://<username>.github.io/trailerfeed/`.

## Install on your phone
- **iPhone:** open the link in Safari → Share → **Add to Home Screen**.
- **Android:** open the link in Chrome → ⋮ → **Install app** / **Add to Home screen**.

On first launch, paste your TMDB **API Read Access Token** (themoviedb.org → Settings → API). The token stays on the phone and is never committed to the repo.

## How it works
- Pulls popular new and upcoming movies from TMDB `discover`, then finds each movie's latest YouTube trailer through `/movie/{id}/videos`.
- **Trailer released** filter uses the trailer's `published_at` date (past week, past month, past 3 months, or any time).
- **Category** filter uses TMDB genres. Selecting several genres shows movies in any of them.
- **Recommendations:** watching a trailer for 15s+ or tapping ♥ raises the weight of its genres. Skipping a trailer in under 2.5s or tapping 👎 lowers it. Each batch is re-ranked by those weights.
- Trailers autoplay muted, since browsers block autoplay with sound. Tap 🔇 to turn sound on.

## Updating
Edit the files and push. The service worker uses network-first loading, so phones pick up changes on the next launch.

This product uses the TMDB API but is not endorsed or certified by TMDB.
