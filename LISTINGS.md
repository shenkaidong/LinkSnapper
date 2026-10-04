# 目录登记清单

把 LinkSnapper 登记到各处需要提交的材料，以及每个目录的入口与坑。
**提交动作本身需要登录，无法自动化** —— 这份文档保证你打开页面后只需要复制粘贴。

## 发布前检查

- [ ] `linksnapper-mcp` 已发到 npm（`npm view linksnapper-mcp version` 能查到）
- [ ] 容器镜像已推到 GHCR（`docker pull ghcr.io/shenkaidong/linksnapper:latest` 能拉到）
- [ ] README 里有能跑的 demo（`bash scripts/demo.sh`）
- [ ] GitHub 仓库 topics 已设置（见文末）—— Glama / mcp.so 会自动从 GitHub 抓，
      topics 设对了即使不提交也可能被自动收录

## 优先级

| 顺序 | 目录 | 为什么先做 |
|---|---|---|
| 1 | **Official MCP Registry**（registry.modelcontextprotocol.io） | MCP 客户端是**程序化查询**这个注册表的。不在里面，对 Agent 而言等于不存在。免费。 |
| 2 | **Glama** | 体量最大（7 万+），且**从 GitHub 自动索引** —— 可能只要等 24-48 小时就自动出现。 |
| 3 | **mcp.so** | 量大（2 万+），**按真实调用量排名**而非 star 数，对新项目友好。无审核，提交即上线。 |
| 4 | **Smithery** | 有 CLI 一键安装，分发体验最好。 |
| 5 | **PulseMCP** | 人工审核，上了有信誉加成；还运营周报，新收录会被提到。 |

## 通用文案（复制用）

**一句话简介（英文，用于目录卡片）**

```
Give your AI agent eyes — screenshot any web page, with SSRF protection built in.
```

**长简介（英文）**

```
LinkSnapper is a self-hostable screenshot service with an MCP server, so Claude,
Cursor, Windsurf and Claude Code can see web pages directly.

Why it is different: in agent workflows the URL often comes from model output or
page content, so a single injected line can talk an agent into screenshotting
169.254.169.254 (cloud metadata) or 10.0.0.5/admin. LinkSnapper guards against
that on two layers — URL literal validation (including numerically-expanded IPv6)
plus per-request interception inside the browser, which is what actually stops
302 redirects, sub-resource probing and DNS rebinding. When a URL is refused, the
reason is passed back to the model verbatim so it stops retrying the same address.

Apache-2.0 licensed and fully self-hostable. The most-starred comparable self-hosted
option (browserless) is SSPL, which requires a paid license for commercial use.

Features: viewport / full-page / element / region / segmented capture, PDF output,
device emulation, dark mode, ad and cookie-banner removal, CSS/JS injection,
waitForSelector, and batch capture (20 URLs per call).
```

**中文简介**

```
让 AI Agent 看见网页的自托管截图服务。Agent 场景下截图 URL 常来自模型输出或网页内容，
一段植入文本就能诱导 Agent 去截 169.254.169.254（云主机元数据）或内网管理后台。
LinkSnapper 用两层防护挡住这类 SSRF：URL 字面量校验（IPv6 按数值展开判断）
+ 浏览器逐个请求拦截（真正能挡住 302 重定向、子资源探测与 DNS 重绑定），
且拒绝原因会原样回传给模型。Apache-2.0 许可，可完全自托管。
```

**分类**：Developer Tools / Browser Automation / Screenshots / AI Agents

**关键词**：screenshot, website screenshot, mcp, puppeteer, chrome, headless browser,
claude, cursor, ai agent, ssrf, self-hosted, pdf

**安装命令**

```
npx -y linksnapper-mcp
```

**仓库**：https://github.com/shenkaidong/LinkSnapper
**npm**：https://www.npmjs.com/package/linksnapper-mcp

## 逐个目录

### 1. Official MCP Registry

- 入口：https://registry.modelcontextprotocol.io （GitHub 登录）
- 需要先**认领命名空间**（反向 DNS 格式）：`io.github.shenkaidong`
- 提交内容：server 元数据（名称、描述、仓库、package、transport）
- 坑：命名空间必须用 GitHub 登录验证所有权，换了账号就换不了命名空间，一次想好。

### 2. Glama

- 入口：https://glama.ai/mcp/servers → 点 **Add Server**
- 需要：GitHub 仓库 URL、描述、分类、安装说明、用例
- **它会自动索引公开仓库**，所以提交前先搜一下 `linksnapper` 看是不是已经在了，
  避免重复条目。自动索引一般 24-48 小时。

### 3. mcp.so

- 入口：https://mcp.so/submit （已确认）
- 无需审核，提交即上线
- 按真实调用量排名 —— 提交后靠 demo 和实际使用把排名推上去，star 数在这没用

### 4. Smithery

- CLI 发布：`smithery mcp publish`（体验类似 npm publish）
- 也支持在网站上提交
- ⚠️ 安全提示：2025 年 10 月 Smithery 的托管功能披露过一个路径穿越漏洞，
  涉及 3000+ 托管 server 与 API key。用它**做目录登记**没问题，
  但不要把自己的生产密钥托管到它上面。

### 5. PulseMCP

- 入口：https://www.pulsemcp.com → 提交表单
- 人工审核，创始人对每个收录的 server 亲自写描述 —— 材料写清楚能加快过审
- 过审后有机会进周报，是新项目少数能拿到编辑推荐的地方

### 顺手做（免费，几分钟）

- GitHub 仓库 topics：`mcp` `model-context-protocol` `screenshot` `website-screenshot`
  `puppeteer` `headless-chrome` `chrome` `ai-agent` `claude` `cursor` `ssrf` `self-hosted`
- awesome 列表提 PR：`punkpeye/awesome-mcp-servers`、`wong2/awesome-mcp-servers`
- 官方 `modelcontextprotocol/servers`：门槛最高、要 maintainer 先同意，
  但收录价值也最高。先开 issue 讨论再提 PR。

## 关于「要不要收费」

这些目录全都是免费登记，不冲突、无排他性，**全部都提交**。
真正能收钱的是另外几条路（MCP Marketplace 85/15、Apify 80/20、MCPize 80-85%、
x402 微支付），但前提是先把量做起来 —— 目录曝光是第一步，不是终点。
