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

- Node.js 18 or later (unit tests need 22.6+ for native TypeScript support)
- A local Chrome / Chromium installation (or point `CHROME_PATH` at the binary)
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

## API

### `POST /api/screenshot`

Request body:

```jsonc
{
  "url": "example.com",   // required; protocol optional, https:// is assumed
  "singleShot": false,    // true = capture the current viewport only
  "fullPage": false,      // true = full-page capture
  "offset": 0,            // vertical start position for paged capture
  "maxSegments": 6        // paged mode: how many segments to return per request (1–12), default 6
}
```

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

### `POST /api/merge`

Body `{ "screenshots": ["<base64>", "<base64>"] }`, returns `{ success, mergedImage }`.
Images with differing widths are resized to match the first one before compositing.
At most 60 segments and 30000px of total height.

### `GET /api/health`

Reports process and browser state plus the security switches currently in effect. Suitable as a
container health check.

## Docker

```bash
docker compose up -d --build
# or
docker build -t linksnapper .
docker run -d -p 3000:3000 --shm-size=1g linksnapper
```

The image is alpine-based and ships Chromium, CJK fonts, and the system libraries sharp needs.
tini runs as PID 1 to reap zombie Chromium processes. Keep `--shm-size=1g` — Chromium crashes
easily with the default 64MB `/dev/shm`.

> ⚠️ **Version coupling — read before bumping the base image**
> This project drives the **system** Chromium with `puppeteer-core`, so the two versions need to
> roughly match. Alpine's chromium package moves with the base image, and a mismatch shows up as
> "the service starts but captures time out" rather than an obvious crash. The build logs the
> actual Chromium version (`chromium-browser --version`), and the CI docker job starts the
> container and runs the full capture smoke suite to catch exactly this.
> If that job fails: either roll the base image back, or bump `puppeteer-core` too
> (note that puppeteer 22+ removed `headless: 'new'` — set `HEADLESS_MODE=true` in that case).

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

MIT — see [LICENSE](LICENSE).

[中文文档](README-CN.md)
