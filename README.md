# LinkSnapper

LinkSnapper is a web screenshot tool that applies tailored loading strategies to dynamic sites, single-page applications (SPAs), and static pages. It supports paged capture with continue-from-where-you-left-off, plus vertical stitching into one long image.

## Features

- 🌐 **Multi-site adaptation**: detects `dynamic` / `spa` / `static` and waits accordingly
- 📸 **Three capture modes**
  - Normal: captures the current viewport
  - Paged: captures one viewport at a time; a single request can return several segments, or you can capture all the way to the bottom in one action
  - Full page: captures the entire page in a single shot
- ⚡ **Reused browser instance**: a Chromium process stays warm and is recycled when idle, removing the 0.5–1.5s cold start from every request
- 🔗 **Long-image stitching**: server-side vertical composition of captured segments with sharp
- 🛡️ **Two-layer SSRF defence**: the URL is validated literally *and* every request the browser actually issues is checked, so redirects and subresource probes are covered
- 🧩 **Stateless API**: the paging cursor is owned by the client and passed in each request, so the server holds no session state and can scale horizontally
- 🚦 **Rate limiting and concurrency control**: per-IP token bucket, concurrency cap, bounded queue, optional API token
- 🌙 Dark mode and responsive layout
- 🔍 **Visual change monitoring**: freeze a baseline screenshot, then diff against it and get a
  changed-pixel ratio, the bounding box of what moved, and an annotated image

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 14 (App Router) + TypeScript + Tailwind CSS + next-themes |
| Capture engine | puppeteer-core driving a **locally installed** Chrome / Chromium |
| Image processing | sharp |
| Testing | Node's built-in test runner (unit) + end-to-end smoke against a bundled fixture page |
| Deployment | Docker / Docker Compose, CI in `.github/workflows/ci.yml` |

> Because this project uses `puppeteer-core`, it does not download a bundled Chromium. A local Chrome or Chromium installation is required at runtime.

## Requirements

- Node.js 18.17+ (20 recommended; pinned in `.nvmrc` / `.node-version`). CI gates on Node 18 / 20 / 22.
- A local Chrome / Chromium installation, or point `CHROME_PATH` at the binary.
  The repo also ships a script that installs the exact Chrome for Testing build pinned to `puppeteer-core`:

  ```bash
  node scripts/install-chrome.mjs
  ```

- Docker (optional, for containerized deployment only)

## Getting started

```bash
# 1. Clone
git clone <your-repo-url> LinkSnapper
cd LinkSnapper

# 2. Install dependencies
npm install

# 3. Environment variables (optional — sensible defaults apply)
cp .env.example .env

# 4. Start the dev server
npm run dev
```

Open http://localhost:3000. `/snapshot` is a minimal single-shot page.

Production build:

```bash
npm run build
npm run start
```

## Testing

```bash
npm run typecheck     # types only
npm run test:unit     # pure logic, seconds to run, no browser needed
npm run build         # production build

bash scripts/run-smoke.sh          # starts the server, runs everything, tears down
BUILD=1 bash scripts/run-smoke.sh  # rebuild first
SMOKE_EXTERNAL=1 bash scripts/run-smoke.sh   # also exercise real external sites

npm run bench         # paged-capture performance comparison (server must be running)
```

The smoke suite does not depend on external sites. It uses a bundled fixture page
(`/test-fixture.html`: 3000px tall, 50 solid colour bands of 60px) and **reads the pixel colour
of the first and last row of each segment** to recover the exact `y` range it covers. That is what
makes "no overlap, no gap" a real assertion rather than an arithmetic coincidence.

The fixture is served from `127.0.0.1`, so the runner sets `ALLOWED_INTERNAL_HOSTS=127.0.0.1` to
whitelist **exactly that one host**. Every other private address stays blocked, which is what keeps
the security cases meaningful.

## Performance

Two ways of collecting the same three segments (Apple Silicon, bundled fixture page):

| Approach | Time | Requests |
|---|---|---|
| One request per segment (`maxSegments=1`, i.e. the pre-refactor behaviour) | ~1838ms | 3 |
| Three segments in one request (`maxSegments=3`) | ~692ms | 1 |

**Roughly 2.7× faster.** `npm run bench` also verifies both approaches return identical segments,
so the speed-up is not simply doing less work. The gain comes from two places: reusing the Chromium
instance removes the cold start, and batching means the page loads once and the lazy-load
pre-scroll runs once.

## Environment variables

See [`.env.example`](.env.example). The ones you are most likely to touch:

| Variable | Default | Description |
|---|---|---|
| `CHROME_PATH` | auto-detected | Path to the Chrome / Chromium binary |
| `ALLOW_PRIVATE_NETWORK` | `false` | Allow capturing private / loopback addresses. **Leave this off unless you really need it.** |
| `ALLOWED_INTERNAL_HOSTS` | empty | Comma-separated hosts to whitelist individually — safer than the blanket switch above |
| `SCREENSHOT_API_TOKEN` | empty | When set, every request must send `Authorization: Bearer <token>` or `x-api-token` |
| `RATE_LIMIT_CAPACITY` | `6` | Burst allowance per IP |
| `RATE_LIMIT_REFILL_PER_SEC` | `0.2` | Token refill rate (≈12 requests/minute) |
| `MAX_CONCURRENT_CAPTURES` | `3` | Simultaneous capture jobs (each holds one Chromium) |
| `BROWSER_IDLE_SHUTDOWN_MS` | `60000` | How long an idle browser instance is kept alive |
| `SNAPSHOT_DIR` | `./.snapshots` | Where visual baselines are stored (mount a volume in Docker) |
| `MAX_SNAPSHOTS` | `200` | Baselines kept before the oldest are evicted |
| `SNAPSHOT_DIFF_MAX_SIDE` | `1600` | Comparison canvas size; full-page images are scaled to fit |
| `SNAPSHOT_DIFF_THRESHOLD` | `16` | Per-channel colour delta that counts as “changed” |

## API

### `POST /api/screenshot`

Request body:

```jsonc
{
  "url": "example.com",   // required; protocol optional, https:// is assumed
  "singleShot": false,    // true = capture the current viewport only
  "fullPage": false,      // true = full-page capture
  "offset": 0,            // vertical start position for paged capture
  "maxSegments": 6,       // paged mode: how many segments to return per request (1–12), default 6
  "selector": null,       // CSS selector: capture only the first matching element (full element, may exceed viewport); highest priority
  "clip": null,           // manual crop {x,y,width,height} in page coordinates (CSS px); overrides fullPage/singleShot
  // —— page decoration and waiting (all optional) ——
  "device": null,          // mobile / tablet / desktop preset
  "width": null,           // custom viewport width (overrides the device preset)
  "height": null,          // custom viewport height
  "deviceScaleFactor": 1,  // pixel density 1–3; 2/3 gives retina clarity at 2–4x the file size
  "darkMode": false,       // render with prefers-color-scheme: dark
  "blockAds": false,       // abort ad / analytics / tracking requests
  "blockCookieBanners": false,
  "hideSelectors": [],     // CSS selectors of elements to hide, max 20
  "css": null,             // custom CSS injected before capture
  "js": null,              // custom JS executed before capture
  "waitForSelector": null, // wait for this selector before capturing; 504 on timeout
  "waitForTimeout": 0,     // extra wait in ms after the page settles, max 30000
  "format": "png",         // output format: png / jpeg / webp / pdf, default png
  "quality": 80            // jpeg / webp quality 1–100, default 80 (ignored for png)
}
```

Parameter precedence: `pdf` > `selector` > `clip` > `fullPage` > `singleShot` > paged.
`selector` / `clip` return a single image (no paging/merge) and are still covered by the two-layer SSRF guard.
`format` applies to viewport / full-page / element / region captures; paged mode always returns PNG to stay
compatible with `/api/merge`. The response also includes `format` and `contentType` for correct decoding.

`prefers-color-scheme` is emulated **explicitly for both `darkMode: true` and `false`**. Otherwise
the unset case falls back to the host OS theme, so the same URL with the same parameters produces
different images on a dark-mode macOS laptop and in a Linux container.

Response:

```jsonc
{
  "success": true,
  "segments": [
    { "offset": 0,    "height": 1080, "image": "<base64 PNG>" },
    { "offset": 1080, "height": 1080, "image": "<base64 PNG>" }
  ],
  "screenshot": "<alias for the first segment, kept for single-segment clients>",
  "isEnd": false,         // true when there is nothing left to capture
  "nextOffset": 2160,     // pass this back verbatim on the next page request
  "pageHeight": 4126,
  "queue": { "active": 1, "waiting": 0 }
}
```

Paged capture: send `offset: 0` first, then echo back `nextOffset` from each response until
`isEnd` is `true`. The server stores no state between requests.
Returning several segments per request removes the "reload the page for every segment" cost —
the page loads once and the lazy-load pre-scroll runs once.

Failures use meaningful status codes: `400` bad request, `401` missing token, `403` blocked by the
URL guard, `413` body or page height over the limit, `429` rate limited, `503` queue overloaded,
`502/504` target site problems.

### `POST /api/screenshot/bulk`

Up to **20** URLs in one call. Each result succeeds or fails independently — one bad URL out of
twenty does not fail the batch, because that would just push retry logic back onto the caller.
Concurrency is deliberately low (2 by default, since every capture holds a Chromium) and rate
limits are charged per image, otherwise the batch endpoint would be a free bypass of the limiter.

### `POST /api/merge`

Body `{ "screenshots": ["<base64>", "<base64>"] }`, returns `{ success, mergedImage }`.
Images with differing widths are resized to match the first one before compositing.
At most 60 segments and 30000px of total height.

### `POST /api/snapshot` — freeze a visual baseline

Visual-change monitoring, step one. Screenshot the page **as it should look** and store it as a
baseline. Response echoes back the `key`, `bytes` and the image itself.

```jsonc
// request
{ "url": "example.com", "key": "home-v2", "singleShot": true, "width": 1280 }
// response
{ "success": true, "action": "baseline", "key": "home-v2", "savedAt": "...", "bytes": 48211,
  "image": "<base64 PNG>" }
```

`key` is optional: the server derives one from `sha1(url + params)` so the same URL with the same
viewport always maps to the same baseline, while a different viewport or `darkMode` automatically
becomes a separate baseline. Keys allow `A-Za-z0-9_-` only, length 1–64 — the key is part of a
file path, so anything else is rejected before it can touch the filesystem.

### `POST /api/snapshot/compare` — did it change?

```jsonc
// request
{ "url": "example.com", "key": "home-v2", "threshold": 16 }
// response
{ "success": true, "changed": true, "changedPixels": 184320, "changedRatio": 0.45,
  "boundingBox": { "x": 0, "y": 120, "width": 1280, "height": 320 },
  "width": 1280, "height": 720, "threshold": 16, "scaled": false,
  "diffImage": "<base64 PNG, differences in red>" }
```

`diffImage` marks every changed pixel red and keeps the baseline underneath untouched, so you
can look at one image and see what moved. The bounding box is reported in **original pixel
coordinates**, not thumbnail coordinates — the comparison is done on images scaled down to
`maxSide` (1600 by default) because a 1920×30000 full-page scan would block the event loop.

A missing baseline is a `404`, deliberately: silently creating one would turn “never alerted”
into “never compared”, which is the failure mode nobody notices.

Baselines live on disk under `SNAPSHOT_DIR` (default `./.snapshots`) with an LRU cap
(`MAX_SNAPSHOTS`, default 200) and a `MAX_SNAPSHOTS`-driven cleaner, so a long-running
monitoring job cannot fill the disk.

### `GET /api/health`

Reports process and browser state plus the security switches currently in effect. Suitable as a
container health check.

## Docker

```bash
# Use the prebuilt image (recommended — no local build needed)
docker run -d --name linksnapper -p 3000:3000 --shm-size=1g \
  ghcr.io/shenkaidong/linksnapper:latest

# Or via compose (pulls the image; comment out `image:` and enable `build:` for source builds)
docker compose up -d

# Or build locally
docker build -t linksnapper .
docker run -d -p 3000:3000 --shm-size=1g linksnapper
```

Images are published for `linux/amd64` and `linux/arm64`.

To see it working without installing Node or Chrome:

```bash
bash scripts/demo.sh
```

The image is based on **Debian (glibc)** `node:20-bookworm-slim`. The build runs
`scripts/install-chrome.mjs` to download the exact Chrome for Testing build pinned to
`puppeteer-core` (121.0.6167.85) and symlinks it to `/usr/bin/chrome-for-testing`, plus the
system libraries Chrome needs, CJK fonts, and `tini` (PID 1 to reap zombie Chromium processes).
Keep `--shm-size=1g` — Chromium crashes easily with the default 64MB `/dev/shm`.

> ✅ **Version coupling — solved at build time**
> The old Alpine image shipped the distro `chromium` (musl) while Google's Chrome is glibc-only,
> and the distro version drifted with the base image. Now every environment (local / CI / Docker /
> k8s) downloads the *same* Chrome build that `puppeteer-core` expects. When you bump
> `puppeteer-core`, just update `CHROME_VERSION` in `scripts/install-chrome.mjs` to match
> `PUPPETEER_REVISIONS.chrome` and rebuild. `HEADLESS_MODE` also auto-adapts to the puppeteer major
> (22+ falls back to `true`), so no code edit is needed on upgrade.

## Security notes

A screenshot service can make the server fetch arbitrary URLs, so the defence has two layers.

**Layer 1 — literal URL validation** (`src/utils/url-guard.ts`)

- Only `http` / `https`; `file:` `javascript:` `data:` `ftp:` and friends are rejected *before* the
  "assume https://" step, so they cannot be rewritten into something that merely fails later
- Credentials embedded in the URL are refused
- `localhost`, `*.local`, `*.internal` and similar internal suffixes are refused
- Private and reserved ranges are refused: `0.0.0.0/8`, `10/8`, `127/8`, `169.254/16` (including the
  cloud metadata endpoint `169.254.169.254`), `172.16/12`, `192.168/16`, `100.64/10`, `198.18/15`,
  multicast and reserved blocks
- IPv6 is expanded numerically, covering `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8` and the
  IPv4-embedding forms `::ffff:0:0/96`, `::/96`, `64:ff9b::/96`, `2002::/16`
- Malformed IPv4 spellings (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`) are normalised by the
  URL parser and then rejected like any other private address

**Layer 2 — in-browser request interception** (`installRequestGuard` in `src/app/api/screenshot/route.ts`)

Validating only the URL the user submitted is not enough: the page can 302 into a private address,
its `img` / `script` / `fetch` calls can reach the internal network, and a perfectly legal hostname
can resolve to `127.0.0.1` (DNS rebinding). Layer 2 therefore checks every request the browser is
about to make, with DNS results cached for 60 seconds:

- literal private hostname → abort
- hostname that resolves to a private address → abort
- non-`http(s)` protocol for anything that is not an internal resource → abort

**Also**

- `--disable-web-security` was removed so the same-origin policy stays enforced
- All responses carry `Cache-Control: no-store` so target page content is never cached in between
- Request bodies are read with a size cap, so a huge payload cannot exhaust memory
- Per-IP rate limiting is on by default; set `SCREENSHOT_API_TOKEN` before exposing this publicly

## Known limitations

- **Rate limiting and concurrency state live in the process.** With multiple instances each one
  enforces its own quota, so the effective limit multiplies by the instance count. Swap the token
  bucket for a shared store such as Redis if you need a global quota.
- Infinite-scroll pages are cut off by a time budget (12s of pre-scrolling) rather than loading forever.
- When several segments are captured in one request, the page height is fixed at the moment the
  pre-scroll finishes; content that keeps growing afterwards will not appear in later segments.
- Request interception disables the browser's own HTTP cache, so first loads are slightly slower
  than they would be without it — that is the cost of catching redirect-based SSRF.
- Pages behind a login cannot be captured.

## License

The code is **Apache-2.0** — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Free for any use,
including commercial and closed-source embedding; self-hosting is explicitly encouraged and
costs nothing.

Compared with MIT, Apache-2.0 adds two things enterprises care about: an express **patent
grant** from every contributor (which terminates automatically if you assert patent claims
against this project), and a **NOTICE attribution duty** when you redistribute. Self-hosting
and closed-source embedding work exactly as they do under MIT.

The name "LinkSnapper" and the logo are **not** covered by Apache-2.0. Managed hosting, SLA and
support response times, enterprise features (multi-tenancy, quota billing, SSO, audit export,
compliance documentation) and trademark use fall under a commercial license — see
[COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md). That license is **additive** on top of
Apache-2.0 and never reduces any right the open-source license already gives you.

[中文文档](README-CN.md)
