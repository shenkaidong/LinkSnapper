# linksnapper-mcp

让 AI Agent（Claude、Cursor、Windsurf、Claude Code）**真正看见网页**的 MCP server。

它把 [LinkSnapper](https://github.com/shenkaidong/LinkSnapper) 的截图能力暴露成 MCP 工具：
截整页、截某个元素、截指定区域、分段截超长页、输出 PDF。

## 为什么不用别家

Agent 场景下的截图有一个被普遍忽略的风险：**URL 往往来自模型输出或网页内容**。
页面里一段植入的文本就能诱导 agent 去截 `169.254.169.254/latest/meta-data/`
（云主机元数据）或 `10.0.0.5/admin`，把内网结构原封不动送回对话。

LinkSnapper 对此做了两层防护，市面上基本没有第二家做全：

1. **URL 字面量校验** —— 协议白名单、拒绝私有/保留/回环地址，IPv6 按数值展开判断
   （`[::ffff:127.0.0.1]` 这类字符串前缀匹配会漏的形式也拦得住）；
2. **浏览器请求拦截** —— 逐个校验浏览器要发出的每个请求 + DNS 解析校验。
   只校验用户传入的 URL 挡不住 302 重定向、子资源探测和 DNS 重绑定。

被拒绝时，server 会把**拒绝原因原样带回给模型**（`出于安全考虑，禁止截图内网或本机地址`），
而不是一句含糊的"失败了"——否则模型会反复重试同一个地址。

另外它是 **Apache-2.0 许可、可完全自托管**的。同类自托管方案里 star 最多的 browserless 用的是 SSPL，
商业使用需要授权。

## 前置条件：先跑一个 LinkSnapper

```bash
docker run -d --name linksnapper -p 3000:3000 \
  ghcr.io/shenkaidong/linksnapper:latest
```

或者从源码起：

```bash
git clone https://github.com/shenkaidong/LinkSnapper.git
cd LinkSnapper && npm ci && npm run install-chrome && npm run build && npm start
```

确认它活着：

```bash
curl http://127.0.0.1:3000/api/health
```

## 安装

不需要安装，直接用 `npx`：

```json
{
  "mcpServers": {
    "linksnapper": {
      "command": "npx",
      "args": ["-y", "linksnapper-mcp"],
      "env": {
        "LINKSNAPPER_BASE_URL": "http://127.0.0.1:3000"
      }
    }
  }
}
```

配置文件位置：

| 客户端 | 路径 |
| --- | --- |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

改完重启客户端。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LINKSNAPPER_BASE_URL` | `http://127.0.0.1:3000` | LinkSnapper 服务地址 |
| `LINKSNAPPER_TOKEN` | 空 | 访问令牌；服务端设了 `SCREENSHOT_API_TOKEN` 时才需要 |
| `LINKSNAPPER_TIMEOUT_MS` | `120000` | 单次请求超时 |

## 工具

| 工具 | 用途 |
| --- | --- |
| `take_screenshot` | 通用截图：视口 / 整页 / 元素 / 裁剪区域 / 分段 |
| `capture_element` | 按 CSS 选择器截单个元素（超出视口也能截全） |
| `capture_region` | 按页面坐标截矩形区域 |
| `capture_full_page` | 整页截图（含懒加载内容） |
| `capture_segmented` | 超长页分段截，带 `nextOffset` 游标翻页 |
| `get_service_health` | 查服务状态：Chromium 是否就绪、版本、限流模式、队列深度 |

截图类工具共用的可选参数：

`format`（png / jpeg / webp / pdf）、`quality`、`device`（mobile / tablet / desktop）、
`width` / `height` / `deviceScaleFactor`、`darkMode`、`blockAds`、`blockCookieBanners`、
`hideSelectors`、`css`、`js`、`waitForSelector`、`waitForTimeout`。

## 提示词的写法

模型不一定知道该在什么时候调哪个工具。在 system prompt 里加一句会明显改善效果：

> 需要看网页内容时用 `take_screenshot`。页面内容异步加载时用 `waitForSelector`
> 等目标元素出现，而不是靠猜时间。截图是给你自己看的，用 `blockAds` 和
> `hideSelectors` 去掉广告与浮窗，避免干扰你的判断。

## 排错

| 现象 | 原因 |
| --- | --- |
| `连不上服务 http://127.0.0.1:3000` | LinkSnapper 没起，或 `LINKSNAPPER_BASE_URL` 指错了 |
| `请求超时（120000ms）` | 目标站点慢；调大 `LINKSNAPPER_TIMEOUT_MS` |
| `出于安全考虑，禁止截图内网或本机地址` | 防护生效了。若确实需要，服务端用 `ALLOWED_INTERNAL_HOSTS` 精确放行单个主机，**不要用** `ALLOW_PRIVATE_NETWORK=true` |
| 截图一片空白 | 页面是 SPA；加 `waitForSelector` 等具体内容出现 |

## 视觉变更监控

`save_snapshot_baseline` 存一份基准图，`compare_snapshot` 跟它比：

```json
{ "name": "compare_snapshot", "arguments": { "url": "example.com", "key": "home-v2" } }
```

返回一句结论（`变化像素 …（45.00%）` + `差异区域 x=… y=… w×h`）外加一张差异标红的图。
基准不存在时明确报错，不会悄悄建一个新的 —— 否则「从没报警」只是「根本没比对过」。

## 许可

Apache-2.0（[LICENSE](https://github.com/shenkaidong/LinkSnapper/blob/main/LICENSE) +
[NOTICE](https://github.com/shenkaidong/LinkSnapper/blob/main/NOTICE)）。
商业支持、SLA 与托管版本见 [COMMERCIAL-LICENSE.md](https://github.com/shenkaidong/LinkSnapper/blob/main/COMMERCIAL-LICENSE.md)。
