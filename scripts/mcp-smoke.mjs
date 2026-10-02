#!/usr/bin/env node
/**
 * MCP server 端到端冒烟。
 *
 * 用真实的 MCP 客户端（stdio 传输）连上 mcp/index.mjs，列出工具并逐个调用，
 * 断言返回的是符合协议的结构、图片是有效 PNG、SSRF 防护确实在生效。
 *
 * 为什么要单独做这套？
 * 只测 HTTP 接口无法证明"MCP 这层转发"是对的 —— 协议帧格式、工具 schema、
 * content 结构、错误回传方式都可能在转发层出问题，而这些恰恰是客户端能否
 * 正常发现并调用工具的关键。
 *
 * 用法：
 *   BASE_URL=http://127.0.0.1:3000 node scripts/mcp-smoke.mjs
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = resolve(HERE, '..', 'mcp', 'index.mjs')
const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let passed = 0
let failed = 0

function ok(message) {
  passed += 1
  console.log(`  ✓ ${message}`)
}

function fail(message) {
  failed += 1
  console.log(`  ✗ ${message}`)
}

function check(condition, message) {
  if (condition) ok(message)
  else fail(message)
}

function section(title) {
  console.log(`\n${title}`)
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      ...process.env,
      LINKSNAPPER_BASE_URL: BASE_URL,
    },
  })

  const client = new Client({ name: 'mcp-smoke', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)

  try {
    // ---------------------------------------------------------------- 工具发现
    section('工具发现')
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    check(tools.length > 0, `列出 ${tools.length} 个工具：${names.join(', ')}`)

    for (const name of ['take_screenshot', 'capture_element', 'capture_region', 'capture_full_page', 'capture_segmented', 'get_service_health']) {
      check(names.includes(name), `工具 ${name} 已注册`)
    }

    const screenshotTool = tools.find(t => t.name === 'take_screenshot')
    check(
      screenshotTool?.inputSchema?.required?.includes('url'),
      'take_screenshot 的 url 是必填参数'
    )
    check(Boolean(screenshotTool?.description), 'take_screenshot 有描述（模型靠它决定何时调用）')

    // ---------------------------------------------------------------- 健康探针
    section('get_service_health')
    const health = await client.callTool({ name: 'get_service_health', arguments: {} })
    const healthText = health.content?.[0]?.text || ''
    check(!health.isError, '调用成功')
    let healthJson = null
    try {
      healthJson = JSON.parse(healthText)
    } catch {
      fail('健康检查返回的内容不是合法 JSON')
    }
    if (healthJson) {
      check(healthJson.chrome?.ready === true, `Chromium 就绪（${healthJson.chrome?.actualVersion}）`)
    }

    // ---------------------------------------------------------------- 真实截图
    section('take_screenshot（基准页）')
    const shot = await client.callTool({
      name: 'take_screenshot',
      arguments: { url: `${BASE_URL}/test-fixture.html`, fullPage: true },
    })
    check(!shot.isError, `调用成功${shot.isError ? '：' + JSON.stringify(shot.content?.[0]?.text) : ''}`)

    const imageBlocks = (shot.content || []).filter(c => c.type === 'image')
    check(imageBlocks.length >= 1, `返回了 ${imageBlocks.length} 个图片块（模型可直接查看）`)
    if (imageBlocks.length > 0) {
      const buf = Buffer.from(imageBlocks[0].data, 'base64')
      check(buf.subarray(0, 8).equals(PNG_MAGIC), '图片块是有效 PNG（魔数正确）')
      const width = buf.readUInt32BE(16)
      const height = buf.readUInt32BE(20)
      check(width === 1920 && height === 3000, `整页尺寸 ${width}x${height}（期望 1920x3000）`)
    }

    const textBlocks = (shot.content || []).filter(c => c.type === 'text').map(c => c.text)
    check(
      textBlocks.some(t => t.includes('页面总高')),
      '附带了文字摘要（页面总高 / 是否到底）'
    )

    // ---------------------------------------------------------------- 元素截图
    section('capture_element（selector）')
    const el = await client.callTool({
      name: 'capture_element',
      arguments: { url: `${BASE_URL}/test-fixture.html`, selector: '.band[data-index="3"]' },
    })
    check(!el.isError, `调用成功${el.isError ? '：' + (el.content?.[0]?.text || '') : ''}`)
    const elImage = (el.content || []).find(c => c.type === 'image')
    if (elImage) {
      const buf = Buffer.from(elImage.data, 'base64')
      check(buf.readUInt32BE(20) === 60, `元素高度 ${buf.readUInt32BE(20)}px（期望 60）`)
    } else {
      fail('未返回图片块')
    }

    // ---------------------------------------------------------------- 区域截图
    section('capture_region（clip）')
    const region = await client.callTool({
      name: 'capture_region',
      arguments: { url: `${BASE_URL}/test-fixture.html`, x: 0, y: 120, width: 400, height: 200 },
    })
    check(!region.isError, `调用成功${region.isError ? '：' + (region.content?.[0]?.text || '') : ''}`)
    const regionImage = (region.content || []).find(c => c.type === 'image')
    if (regionImage) {
      const buf = Buffer.from(regionImage.data, 'base64')
      check(
        buf.readUInt32BE(16) === 400 && buf.readUInt32BE(20) === 200,
        `区域尺寸 ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}（期望 400x200）`
      )
    } else {
      fail('未返回图片块')
    }

    // ---------------------------------------------------------------- 安全：SSRF
    section('安全：SSRF 防护必须透过 MCP 层生效')
    const attack = await client.callTool({
      name: 'take_screenshot',
      arguments: { url: 'http://169.254.169.254/latest/meta-data/' },
    })
    check(attack.isError === true, '内网地址被拒绝（isError=true）')
    const attackText = (attack.content?.[0]?.text || '') + ''
    check(
      attackText.includes('内网') || attackText.includes('禁止'),
      `拒绝原因透传给了模型：「${attackText.slice(0, 60)}」`
    )

    const loopback = await client.callTool({
      name: 'capture_full_page',
      arguments: { url: 'http://127.0.0.1:22/' },
    })
    check(loopback.isError === true, '回环地址被拒绝')

    // ---------------------------------------------------------------- 错误回传
    section('错误处理')
    const missing = await client.callTool({
      name: 'capture_element',
      arguments: { url: `${BASE_URL}/test-fixture.html`, selector: '.does-not-exist' },
    })
    check(missing.isError === true, '选择器未命中时返回错误而非空图')
    check(
      ((missing.content?.[0]?.text) + '').includes('未匹配到'),
      '错误信息说明了未匹配到元素（模型可据此换选择器）'
    )
  } finally {
    await client.close()
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(error => {
  console.error('冒烟脚本异常：', error)
  process.exit(1)
})
