# LinkSnapper

LinkSnapper 是一个网页截图工具，针对动态加载站点、单页应用（SPA）和静态站点做了差异化处理，支持分段续截与长图拼接。

## 功能特点

- 🌐 **多类型网站适配**：自动识别 `dynamic` / `spa` / `static` 三类站点并采用不同的加载等待策略
- 📸 **三种截图模式**
  - 普通截图：截取当前视口
  - 分段截图：按视口高度逐段截取，单次请求可连续截多段，也能一键截到底
  - 整页截图：一次性截取完整页面
- ⚡ **浏览器实例复用**：Chromium 进程常驻并空闲回收，省掉每次请求 0.5～1.5 秒的冷启动
- 🔗 **长图拼接**：把已截取的多段画面纵向合并为一张长图（服务端用 sharp 处理）
- 🛡️ **两层 SSRF 防护**：既校验 URL 字面量，也在浏览器发出请求的那一刻逐个校验，能挡住重定向与子资源探测
- 🧩 **无状态接口**：分段续截的游标由前端持有并通过请求传递，服务端不保存会话状态，可安全多实例部署
- 🚦 **限流与并发闸门**：按 IP 令牌桶限流、并发上限、有界排队队列，可选 API Token 鉴权
- 🌙 深色模式、响应式布局

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Next.js 14（App Router）+ TypeScript + Tailwind CSS + next-themes |
| 截图引擎 | puppeteer-core 驱动**本地已安装的** Chrome / Chromium |
| 图像处理 | sharp |
| 测试 | Node 内置测试运行器（单元）+ 自带基准页的端到端冒烟 |
| 部署 | Docker / Docker Compose，CI 见 `.github/workflows/ci.yml` |

> 注意：因为使用 `puppeteer-core`，程序不会下载内置 Chromium，运行时需要环境里已安装 Chrome 或 Chromium。

## 环境要求

- Node.js 18 或更高版本（单元测试需要 22.6+ 的 TypeScript 支持）
- 本机已安装 Chrome / Chromium（或通过 `CHROME_PATH` 指定可执行文件路径）
- Docker（可选，仅容器化部署需要）

## 快速开始

```bash
# 1. 克隆仓库
git clone <你的仓库地址> LinkSnapper
cd LinkSnapper

# 2. 安装依赖
npm install

# 3. 准备环境变量（可选，不设置也有合理默认值）
cp .env.example .env

# 4. 启动开发服务器
npm run dev
```

访问 http://localhost:3000 。`/snapshot` 是只做单次截图的简易页面。

生产构建：

```bash
npm run build
npm run start
```

## 测试

```bash
npm run typecheck     # 类型检查
npm run test:unit     # 单元测试（纯逻辑，秒级，不需要浏览器）
npm run build         # 生产构建

bash scripts/run-smoke.sh          # 端到端冒烟：自动起服务、跑用例、收尾
BUILD=1 bash scripts/run-smoke.sh  # 先重新构建再跑
SMOKE_EXTERNAL=1 bash scripts/run-smoke.sh   # 额外跑一组真实外网站点用例

npm run bench         # 分段截图性能对照（需服务已在跑）
```

冒烟测试不依赖外部网站：它使用仓库自带的基准页 `/test-fixture.html`
（3000px 高、50 条 60px 纯色横条），并**逐段读取首行 / 末行的像素颜色**反推真实 y 区间，
因此能真正验证「分段首尾相接、既无重叠也无跳空」，而不是只看段高之和。

基准页跑在本机 `127.0.0.1` 上，所以 runner 会设置 `ALLOWED_INTERNAL_HOSTS=127.0.0.1`
**只精确放行这一个主机**；其余内网地址仍然被拦，安全用例才有意义。

## 性能

分段截图的两种取法实测对比（本机 Apple Silicon，目标为自带基准页，取满 3 段）：

| 取法 | 耗时 | 请求数 |
|---|---|---|
| 每段一次请求（`maxSegments=1`，即重构前的行为） | ~1838ms | 3 |
| 一次请求取 3 段（`maxSegments=3`） | ~692ms | 1 |

**约 2.7 倍提速**，且 `npm run bench` 会同时校验两种取法拿到的分段完全一致，
确保「更快」不是因为少干活。收益主要来自两处：Chromium 实例复用省掉冷启动，
批量分段让页面只加载一次、懒加载预滚动只跑一次。

## 环境变量

参见 [`.env.example`](.env.example)。常用的几项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHROME_PATH` | 自动探测 | Chrome / Chromium 可执行文件路径 |
| `ALLOW_PRIVATE_NETWORK` | `false` | 是否允许截图内网 / 本机地址。**除非确实需要，否则不要打开** |
| `ALLOWED_INTERNAL_HOSTS` | 空 | 精确放行的内网主机（逗号分隔），比上一项的一刀切更安全 |
| `SCREENSHOT_API_TOKEN` | 空 | 设置后所有请求都要带 `Authorization: Bearer <token>` 或 `x-api-token` |
| `RATE_LIMIT_CAPACITY` | `6` | 每 IP 允许的突发次数 |
| `RATE_LIMIT_REFILL_PER_SEC` | `0.2` | 每秒补充的令牌数（约 12 次/分钟） |
| `MAX_CONCURRENT_CAPTURES` | `3` | 同时进行的截图任务数（每个都会占一个 Chromium） |
| `BROWSER_IDLE_SHUTDOWN_MS` | `60000` | 浏览器实例空闲多久后回收 |

## API

### `POST /api/screenshot`

请求体：

```jsonc
{
  "url": "example.com",   // 必填，可省略协议头，默认补 https://
  "singleShot": false,    // true = 只截当前视口
  "fullPage": false,      // true = 整页截图
  "offset": 0,            // 分段截图时本段的纵坐标起点
  "maxSegments": 6        // 分段模式下单次最多返回几段（1～12），默认 6
}
```

响应：

```jsonc
{
  "success": true,
  "segments": [
    { "offset": 0,    "height": 1080, "image": "<base64 PNG>" },
    { "offset": 1080, "height": 1080, "image": "<base64 PNG>" }
  ],
  "screenshot": "<第一段的别名，兼容单段调用方>",
  "isEnd": false,         // true 表示没有更多可截内容
  "nextOffset": 2160,     // 下次续截时原样回传即可
  "pageHeight": 4126,
  "queue": { "active": 1, "waiting": 0 }
}
```

分段截图的用法：首次请求 `offset: 0`，之后每次把上一次响应里的 `nextOffset` 原样传回，
直到 `isEnd` 为 `true`。服务端不保存任何状态。
单次请求返回多段是为了省掉「每段都要重新加载一次页面」的开销 —— 页面只加载一次、
懒加载预滚动也只跑一次。

失败时返回相应的状态码：`400` 参数错误、`401` 缺少令牌、`403` 被安全护栏拦截、
`413` 请求体或页面高度超限、`429` 触发限流、`503` 排队过载、`502/504` 目标站点问题。

### `POST /api/merge`

请求体 `{ "screenshots": ["<base64>", "<base64>"] }`，返回 `{ success, mergedImage }`。
不同宽度的图片会以第一张为基准等比缩放对齐后再拼接，段数上限 60，拼后高度上限 30000px。

### `GET /api/health`

返回进程与浏览器状态、当前生效的安全开关，可直接用作容器健康检查。

## Docker 部署

```bash
docker compose up -d --build
# 或
docker build -t linksnapper .
docker run -d -p 3000:3000 --shm-size=1g linksnapper
```

镜像基于 alpine，已装好 Chromium、中文字体与 sharp 所需的系统库，
并用 tini 作为 PID 1 以回收 Chromium 产生的僵尸进程。
`--shm-size=1g` 建议保留 —— Chromium 在默认 64MB 的 `/dev/shm` 下容易崩溃。

> ⚠️ **升级基础镜像前请注意版本耦合**
> 本项目用 `puppeteer-core` 驱动镜像里**系统自带的** Chromium，两者版本需要大致对应。
> Alpine 的 chromium 包会随基础镜像版本变化，错位时可能出现「服务能起但截图超时」
> 这类不易察觉的故障。构建时会把实际的 Chromium 版本打进日志（`chromium-browser --version`）；
> CI 的 docker job 会真的起容器跑一遍截图冒烟来卡住这一点。
> 如果它失败：回退基础镜像版本，或同步升级 `puppeteer-core`
>（后者注意 puppeteer 22+ 已移除 `headless: 'new'`，需同时设置 `HEADLESS_MODE=true`）。

## 安全说明

截图接口本质上提供了「让服务器访问任意地址」的能力，因此防护分两层：

**第一层：URL 字面量校验**（`src/utils/url-guard.ts`）

- 仅允许 `http` / `https`，拒绝 `file:` `javascript:` `data:` `ftp:` 等；危险协议在「自动补 https://」之前就拦掉
- 拒绝 URL 内携带账号密码
- 拒绝 `localhost`、`*.local`、`*.internal` 等内部域名
- 拒绝私网与保留地址：`0.0.0.0/8`、`10/8`、`127/8`、`169.254/16`（含云元数据 `169.254.169.254`）、
  `172.16/12`、`192.168/16`、`100.64/10`、`198.18/15`、组播与保留段
- IPv6 按数值展开后判断，覆盖 `::`、`::1`、`fc00::/7`、`fe80::/10`、`ff00::/8`，
  以及内嵌 IPv4 的 `::ffff:0:0/96`、`::/96`、`64:ff9b::/96`、`2002::/16`
- 畸形 IPv4 写法（`2130706433`、`0x7f000001`、`0177.0.0.1`、`127.1`）由 URL 解析器规范化后同样会被拦下

**第二层：浏览器请求拦截**（`src/app/api/screenshot/route.ts` 里的 `installRequestGuard`）

只校验用户填进来的那一个 URL 是拦不住 SSRF 的：页面可以 302 跳到内网地址，
页面里的 `img` / `script` / `fetch` 也能直接把请求打到内网，域名本身合法但 A 记录指向
`127.0.0.1`（DNS 重绑定）同样绕得过语法层校验。所以第二层在浏览器真正发出请求的那一刻
逐个校验，并按 60 秒缓存 DNS 解析结果：

- 命中内网字面量 → 直接 `abort`
- 解析后指向内网 → 直接 `abort`
- 非 `http(s)` 协议的非内部资源 → 直接 `abort`

**其他**

- 移除了 `--disable-web-security` 启动参数，避免关闭同源策略放大风险
- 响应统一带 `Cache-Control: no-store`，避免目标页面内容被中间层缓存
- 请求体读取有大小上限，不会因为超大 body 把内存打满
- 默认按 IP 限流（令牌桶）；公网部署请再设置 `SCREENSHOT_API_TOKEN`

## 已知限制

- **限流与并发状态是进程内的**，多实例部署时每个实例各限各的，实际额度会被放大 N 倍；
  需要全局额度时应把令牌桶换成 Redis 之类的共享存储。
- 无限滚动页面依赖时间上限截断（预加载滚动 12 秒），不会无限加载。
- 同一请求批量截取多段时，页面高度以「预加载完成后的那一刻」为准；
  若页面在截取过程中仍在持续变高，后续段可能取不到新增长的内容。
- 开启请求拦截后浏览器不再使用自身 HTTP 缓存，首次加载会略慢于不拦截的情况（换来的是能挡住重定向型 SSRF）。
- 需要登录才能查看的页面无法截图。

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE)。

[English Documentation](README.md)
