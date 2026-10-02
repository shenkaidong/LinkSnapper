#!/usr/bin/env node
/**
 * LinkSnapper MCP server —— 让 AI Agent（Claude / Cursor / Windsurf）能"看见"网页。
 *
 * MCP（Model Context Protocol）是 AI 客户端调用外部工具的标准协议：
 * server 声明自己有哪些工具（名字 + JSON Schema），客户端启动时自动发现，
 * 模型自己决定何时调用，结果回到对话里。
 *
 * 为什么这个项目尤其需要它？
 * --------------------------------
 * Agent 场景下的截图有个被普遍忽略的风险：**URL 来自模型输出或网页内容**。
 * 一段植入在页面里的文本就能诱导 agent 去截 `169.254.169.254/latest/meta-data/`
 * （云主机元数据）或 `10.0.0.5/admin`，把内网结构原封不动送回对话。
 * 这时 SSRF 防护不是加分项，而是刚需 —— 而这恰好是 LinkSnapper 区别于
 * 同类服务的唯一硬能力（两层防护：URL 字面量校验 + 浏览器逐个请求拦截）。
 *
 * 本 server 是**薄转发层**：所有实际工作（含安全校验）都由 LinkSnapper 的
 * HTTP 接口完成，MCP 层不做任何 URL 判断，避免出现第二套绕过防护的入口。
 *
 * 用法：
 *   LINKSNAPPER_BASE_URL=http://127.0.0.1:3000 npx linksnapper-mcp
 *
 * Claude Desktop / Cursor 配置：
 *   { "mcpServers": { "linksnapper": {
 *       "command": "npx",
 *       "args": ["-y", "linksnapper-mcp"],
 *       "env": { "LINKSNAPPER_BASE_URL": "http://127.0.0.1:3000" }
 *   } } }
 *
 * 环境变量：
 *   LINKSNAPPER_BASE_URL     服务地址，默认 http://127.0.0.1:3000
 *   LINKSNAPPER_TOKEN        访问令牌（服务端设了 SCREENSHOT_API_TOKEN 时才需要）
 *   LINKSNAPPER_TIMEOUT_MS   单次请求超时，默认 120000
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const BASE_URL = (process.env.LINKSNAPPER_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const TOKEN = (process.env.LINKSNAPPER_TOKEN || '').trim()
const TIMEOUT_MS = Number(process.env.LINKSNAPPER_TIMEOUT_MS) || 120_000

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/** 所有截图类工具共用的参数，避免每个工具重复声明一遍 */
const COMMON_SCREENSHOT_PROPS = {
  url: {
    type: 'string',
    description: '要截取的页面地址。必须是公网 http/https 地址 —— 内网、回环、链路本地地址会被服务端拒绝（SSRF 防护）。',
  },
  format: {
    type: 'string',
    enum: ['png', 'jpeg', 'webp'],
    description: '输出格式，默认 png。分段模式下恒为 png。',
  },
  quality: {
    type: 'number',
    description: 'jpeg / webp 的质量，1-100，默认 80。png 为无损格式，忽略此参数。',
  },
  selector: {
    type: 'string',
    description: 'CSS 选择器：只截取匹配到的第一个元素（可超出视口）。',
  },
  clip: {
    type: 'object',
    description: '手动裁剪矩形区域，页面坐标系、CSS 像素。',
    properties: {
      x: { type: 'number' },
      y: { type: 'number' },
      width: { type: 'number' },
      height: { type: 'number' },
    },
    required: ['x', 'y', 'width', 'height'],
  },
}

const TOOLS = [
  {
    name: 'take_screenshot',
    description:
      '截取网页。默认返回当前视口；fullPage=true 截整页；selector 只截某个元素；clip 截指定矩形区域。返回图片本身，可直接查看。',
    inputSchema: {
      type: 'object',
      properties: {
        ...COMMON_SCREENSHOT_PROPS,
        fullPage: { type: 'boolean', description: '截整页（有高度上限，超长页面用分段）。' },
        offset: { type: 'number', description: '分段截图时的起始纵坐标，由上一次响应回传。' },
        maxSegments: { type: 'number', description: '分段模式单次最多返回几段，1-12，默认 6。' },
      },
      required: ['url'],
    },
  },
  {
    name: 'capture_element',
    description: '按 CSS 选择器只截取页面中的某一个元素（如 .price、#chart、article）。元素超出视口也能完整截下。',
    inputSchema: {
      type: 'object',
      properties: {
        url: COMMON_SCREENSHOT_PROPS.url,
        selector: {
          type: 'string',
          description: 'CSS 选择器，未匹配到任何元素时返回错误。',
        },
        format: COMMON_SCREENSHOT_PROPS.format,
        quality: COMMON_SCREENSHOT_PROPS.quality,
      },
      required: ['url', 'selector'],
    },
  },
  {
    name: 'capture_region',
    description: '按页面坐标截取一个矩形区域（CSS 像素）。适合截取页面局部、对比两次渲染的同一区域。',
    inputSchema: {
      type: 'object',
      properties: {
        url: COMMON_SCREENSHOT_PROPS.url,
        x: { type: 'number', description: '左上角 x 坐标' },
        y: { type: 'number', description: '左上角 y 坐标' },
        width: { type: 'number', description: '宽度，必须为正数' },
        height: { type: 'number', description: '高度，必须为正数' },
        format: COMMON_SCREENSHOT_PROPS.format,
        quality: COMMON_SCREENSHOT_PROPS.quality,
      },
      required: ['url', 'x', 'y', 'width', 'height'],
    },
  },
  {
    name: 'capture_full_page',
    description: '截取完整页面（含懒加载内容）。页面过高时会被服务端拒绝并返回上限提示，此时应改用分段。',
    inputSchema: {
      type: 'object',
      properties: {
        url: COMMON_SCREENSHOT_PROPS.url,
        format: COMMON_SCREENSHOT_PROPS.format,
        quality: COMMON_SCREENSHOT_PROPS.quality,
      },
      required: ['url'],
    },
  },
  {
    name: 'capture_segmented',
    description:
      '分段截取超长页面。先调用一次拿到 segments 与 nextOffset，再带上 offset 继续取后续段落，直到 isEnd=true。适合几千到几万像素高的页面。',
    inputSchema: {
      type: 'object',
      properties: {
        url: COMMON_SCREENSHOT_PROPS.url,
        offset: { type: 'number', description: '本次起始纵坐标，首次调用传 0 或省略。' },
        maxSegments: { type: 'number', description: '本次最多返回几段，1-12，默认 6。' },
      },
      required: ['url'],
    },
  },
  {
    name: 'get_service_health',
    description: '查看截图服务的运行状态：Chromium 是否就绪、版本、限流模式、当前队列深度。排查"截图失败"时先调这个。',
    inputSchema: { type: 'object', properties: {} },
  },
]

// ---------------------------------------------------------------------------
// 调用 HTTP 接口
// ---------------------------------------------------------------------------

async function callApi(pathname, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const headers = { 'content-type': 'application/json', ...(init.headers || {}) }
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`

    const response = await fetch(`${BASE_URL}${pathname}`, { ...init, headers, signal: controller.signal })
    const text = await response.text()

    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`服务返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`)
    }

    return { status: response.status, payload }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`请求超时（${TIMEOUT_MS}ms）。服务地址 ${BASE_URL} —— 确认服务已启动、或调大 LINKSNAPPER_TIMEOUT_MS。`)
    }
    if (error?.cause?.code === 'ECONNREFUSED') {
      throw new Error(`连不上服务 ${BASE_URL}。请先启动 LinkSnapper，或用 LINKSNAPPER_BASE_URL 指定正确地址。`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function capture(body) {
  const { status, payload } = await callApi('/api/screenshot', {
    method: 'POST',
    body: JSON.stringify(body),
  })

  if (!payload?.success) {
    const reason = payload?.error || `HTTP ${status}`
    // 把 400 的拒绝原因原样带回给模型 —— 这正是 SSRF 防护在起作用，
    // 模型需要知道"这个地址不允许截"，而不是含糊地"失败了"。
    throw new Error(reason)
  }

  return payload
}

const MIME_BY_FORMAT = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }

/** 把接口返回的 segments 转成 MCP 的 content（图片 + 文字说明） */
function segmentsToContent(payload) {
  const segments = payload.segments || []
  if (segments.length === 0) {
    return [{ type: 'text', text: '服务未返回任何图片分段。' }]
  }

  const mimeType = MIME_BY_FORMAT[payload.format] || 'image/png'
  const content = []

  segments.forEach((segment, index) => {
    content.push({
      type: 'image',
      data: segment.image,
      mimeType,
    })
    content.push({
      type: 'text',
      text: `第 ${index + 1}/${segments.length} 段：offset=${segment.offset} height=${segment.height}（${mimeType}）`,
    })
  })

  const summary = [
    `共 ${segments.length} 段`,
    `页面总高 ${payload.pageHeight ?? '未知'}px`,
    payload.isEnd ? '已到页面底部' : `下一批从 offset=${payload.nextOffset} 继续`,
  ].join(' · ')

  content.push({ type: 'text', text: summary })
  return content
}

// ---------------------------------------------------------------------------
// 工具分发
// ---------------------------------------------------------------------------

async function handleTool(name, args = {}) {
  switch (name) {
    case 'take_screenshot': {
      const payload = await capture({
        url: args.url,
        fullPage: Boolean(args.fullPage),
        selector: args.selector,
        clip: args.clip,
        format: args.format,
        quality: args.quality,
        offset: args.offset,
        maxSegments: args.maxSegments,
      })
      return segmentsToContent(payload)
    }

    case 'capture_element': {
      const payload = await capture({
        url: args.url,
        selector: args.selector,
        format: args.format,
        quality: args.quality,
      })
      return segmentsToContent(payload)
    }

    case 'capture_region': {
      const payload = await capture({
        url: args.url,
        clip: { x: args.x, y: args.y, width: args.width, height: args.height },
        format: args.format,
        quality: args.quality,
      })
      return segmentsToContent(payload)
    }

    case 'capture_full_page': {
      const payload = await capture({
        url: args.url,
        fullPage: true,
        format: args.format,
        quality: args.quality,
      })
      return segmentsToContent(payload)
    }

    case 'capture_segmented': {
      const payload = await capture({
        url: args.url,
        offset: args.offset,
        maxSegments: args.maxSegments,
      })
      return segmentsToContent(payload)
    }

    case 'get_service_health': {
      const { payload } = await callApi('/api/health')
      return [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
    }

    default:
      throw new Error(`未知工具：${name}`)
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'linksnapper', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params

  try {
    return { content: await handleTool(name, args) }
  } catch (error) {
    // isError=true 让客户端把这次调用标记为失败；
    // 错误信息照样写进 content，模型才能据此调整（例如换个选择器）。
    return {
      content: [{ type: 'text', text: `调用失败：${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    }
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // 必须写 stderr：stdout 是 MCP 的协议通道，往里打日志会破坏帧解析。
  console.error(`[linksnapper-mcp] 已启动，目标服务 ${BASE_URL}`)
}

main().catch(error => {
  console.error('[linksnapper-mcp] 启动失败：', error)
  process.exit(1)
})
