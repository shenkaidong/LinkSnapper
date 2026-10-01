# LinkSnapper

LinkSnapper is a web screenshot tool that applies tailored loading strategies to dynamic sites, single-page applications (SPAs), and static pages. It supports paged capture with continue-from-where-you-left-off, plus vertical stitching into one long image.

## Features

- 🌐 **Multi-site adaptation**: detects `dynamic` / `spa` / `static` and waits accordingly
- 📸 **Three capture modes**
  - Normal: captures the current viewport
  - Paged: captures one viewport at a time, paging down until the bottom of the page
  - Full page: captures the entire page in a single shot
- 🔗 **Long-image stitching**: server-side vertical composition of captured segments with sharp
- 🔒 **Built-in URL guard**: blocks private, loopback, and link-local addresses by default to prevent SSRF
- 🧩 **Stateless API**: the paging cursor is owned by the client and passed in each request, so the server holds no session state and can scale horizontally
- 🌙 Dark mode and responsive layout

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 14 (App Router) + TypeScript + Tailwind CSS + next-themes |
| Capture engine | puppeteer-core driving a **locally installed** Chrome / Chromium |
| Image processing | sharp |
| Deployment | Docker / Docker Compose |

> Because this project uses `puppeteer-core`, it does not download a bundled Chromium. A local Chrome or Chromium installation is required at runtime.

## Requirements

- Node.js 18 or later
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

## Environment variables

See [`.env.example`](.env.example). The two that matter:

| Variable | Default | Description |
|---|---|---|
| `CHROME_PATH` | auto-detected | Path to the Chrome / Chromium binary |
| `ALLOW_PRIVATE_NETWORK` | `false` | Allow capturing private / loopback addresses. **Leave this off unless you really need it.** |

## API

### `POST /api/screenshot`

Request body:

```jsonc
{
  "url": "example.com",   // required; protocol optional, https:// is assumed
  "singleShot": false,    // true = capture the current viewport only
  "fullPage": false,      // true = full-page capture
  "offset": 0             // vertical start position for paged capture
}
```

Response:

```jsonc
{
  "success": true,
  "screenshot": "<base64, no data URI prefix>",
  "isEnd": false,         // true when there is nothing left to capture
  "nextOffset": 1080      // pass this back verbatim on the next page request
}
```

Paged capture: send `offset: 0` first, then echo back `nextOffset` from each response until
`isEnd` is `true`. The server stores no state between requests.

### `POST /api/merge`

Body `{ "screenshots": ["<base64>", "<base64>"] }`, returns `{ success, mergedImage }`.
Images with differing widths are resized to match the first one before compositing.

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

## Security notes

A screenshot service can make the server fetch arbitrary URLs, so:

- `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
  `169.254.0.0/16` (cloud metadata), IPv6 loopback and unique-local addresses are rejected by default
- Only `http` / `https` are allowed, and credentials embedded in the URL are refused
- `--disable-web-security` was removed so the same-origin policy stays enforced

If you expose this publicly, add authentication and rate limiting in front of it.

## Known limitations

- Paged capture relaunches the browser and reloads the page for every request, so many segments
  are slow. Prefer full-page capture when you need the whole page at once.
- Infinite-scroll pages are cut off by a 15-second time budget rather than loading forever.
- Pages behind a login cannot be captured.

## License

MIT — see [LICENSE](LICENSE).

[中文文档](README-CN.md)
