# Personal News (GitHub Pages)

Private-ish magazine-style brief for Steve C.

**Live:** https://scapp.github.io/personal-news-reader/

## Unlock
On load, the site asks for a PIN. Client-side Web Crypto hashes `salt + PIN` (SHA-256) and compares to `pinHash` in `auth.json`. No plaintext PIN is stored in the repo. Success sets `sessionStorage.pnr_unlocked=1` for the tab session.

## Read / remove
- **Mark read** / **Remove** persist in this browser only (`localStorage`: `pnr_read`, `pnr_removed`).
- Removed stories disappear from the feed; read stories are dimmed. Optional **Hide read** toggle.
- State is not synced across devices or browsers.

## Data
- `data.json` — **live home feed** (`updated` + `stories[]` with `id` = sha1 of URL). **Hard cap: ≤20 stories** after every publish. Prefer category variety; avoid near-duplicate politics in the same batch.
- `archive.json` — accumulating store of all known stories (append by id; never wipe). Used for Saved lookup, not the endless home pile.
- `images/` — local thumbnails referenced by `image_local`.
- Refresh cadence: **7am / 11am / 5pm ET** (not hourly).
- Format rules: `../profile/SITE-FORMAT.md`.

## Local preview
From this folder: `python3 -m http.server 8080` then open http://localhost:8080/

<!-- pages-build 2026-09-23T15:16:18Z -->
