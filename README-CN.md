# LinkSnapper

LinkSnapper 是一个网页截图工具，针对动态加载站点、单页应用（SPA）和静态站点做了差异化处理，支持分段续截与长图拼接。

## 功能特点

- 🌐 **多类型网站适配**：自动识别 `dynamic` / `spa` / `static` 三类站点并采用不同的加载等待策略
- 📸 **三种截图模式**
  - 普通截图：截取当前视口
  - 分段截图：按视口高度逐段截取，可连续续截直至页面底部
  - 整页截图：一次性截取完整页面
- 🔗 **长图拼接**：把已截取的多段画面纵向合并为一张长图（服务端用 sharp 处理）
- 🔒 **内置地址校验**：默认拦截内网与回环地址，避免被当作 SSRF 跳板
- 🧩 **无状态接口**：分段续截的游标由前端持有并通过请求传递，服务端不保存会话状态，可安全多实例部署
- 🌙 深色模式、响应式布局

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Next.js 14（App Router）+ TypeScript + Tailwind CSS + next-themes |
| 截图引擎 | puppeteer-core 驱动**本地已安装的** Chrome / Chromium |
| 图像处理 | sharp |
| 部署 | Docker / Docker Compose |

> 注意：因为使用 `puppeteer-core`，程序不会下载内置 Chromium，运行时需要环境里已安装 Chrome 或 Chromium。

## 环境要求

- Node.js 18 或更高版本
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

## 环境变量

参见 [`.env.example`](.env.example)，主要两项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHROME_PATH` | 自动探测 | Chrome / Chromium 可执行文件路径 |
| `ALLOW_PRIVATE_NETWORK` | `false` | 是否允许截图内网 / 本机地址。**除非确实需要，否则不要打开** |

## API

### `POST /api/screenshot`

请求体：

```jsonc
{
  "url": "example.com",   // 必填，可省略协议头，默认补 https://
  "singleShot": false,    // true = 只截当前视口
  "fullPage": false,      // true = 整页截图
  "offset": 0             // 分段截图时本段的纵坐标起点
}
```

响应：

```jsonc
{
  "success": true,
  "screenshot": "<base64，不含 data URI 前缀>",
  "isEnd": false,         // true 表示没有更多可截内容
  "nextOffset": 1080      // 下次续截时原样回传即可
}
```

分段截图的用法：首次请求 `offset: 0`，之后每次把上一次响应里的 `nextOffset` 原样传回，
直到 `isEnd` 为 `true`。服务端不保存任何状态。

### `POST /api/merge`

请求体 `{ "screenshots": ["<base64>", "<base64>"] }`，返回 `{ success, mergedImage }`。
不同宽度的图片会以第一张为基准等比缩放对齐后再拼接。

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

## 安全说明

截图接口本质上提供了「让服务器访问任意地址」的能力，因此：

- 默认拒绝 `localhost`、`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、
  `169.254.0.0/16`（含云元数据地址）、IPv6 回环与唯一本地地址
- 仅允许 `http` / `https` 协议，拒绝 URL 内携带账号密码
- 移除了 `--disable-web-security` 启动参数，避免关闭同源策略放大风险

如果部署在公网，建议再叠加一层鉴权与限流。

## 已知限制

- 分段截图每次请求都会重新启动浏览器、重新加载页面，段数多时较慢；
  如需一次成型，优先使用「整页截图」。
- 无限滚动页面依赖时间上限截断（15 秒），不会无限加载。
- 需要登录才能查看的页面无法截图。

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE)。

[English Documentation](README.md)
