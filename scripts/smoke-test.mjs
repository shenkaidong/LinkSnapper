#!/usr/bin/env node
/**
 * LinkSnapper 冒烟测试。
 *
 * 用法：
 *   1. 先启动服务（npm run dev，或 npm run build && npm start）
 *   2. node scripts/smoke-test.mjs
 *      或 BASE_URL=http://localhost:3000 node scripts/smoke-test.mjs
 *
 * 需要环境中有可用的 Chrome / Chromium。退出码非 0 表示存在断言失败。
 */

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function post(path, payload, timeoutMs = 180000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function testSecurity() {
  console.log('\n安全拦截（SSRF 防护）')
  const blocked = [
    'http://127.0.0.1:8080/admin',
    'http://localhost/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://[::1]/',
    'file:///etc/passwd',
    'http://user:pass@example.com/',
  ]

  for (const target of blocked) {
    const data = await post('/api/screenshot', { url: target, singleShot: true })
    check(`${target} 应被拒绝`, data.success === false, data.error || '竟然放行了')
  }
}

async function testValidation() {
  console.log('\n参数校验')
  for (const payload of [{}, { url: '' }, { url: 123 }]) {
    const data = await post('/api/screenshot', payload)
    check(`${JSON.stringify(payload)} 应报错`, data.success === false, data.error || '未报错')
  }
}

/** 回归用例：早期版本用 /^f[cd]/ 判断 IPv6 私有地址，会误杀 fda.gov 这类正常域名 */
async function testNoFalsePositive() {
  console.log('\n误杀检测')
  for (const target of ['https://fda.gov/', 'https://fcanet.example/']) {
    const data = await post('/api/screenshot', { url: target, singleShot: true })
    const wronglyBlocked = typeof data.error === 'string' && data.error.includes('禁止截图内网')
    check(`${target} 不应被判定为内网地址`, !wronglyBlocked, data.error || '正常放行')
  }
}

async function testSingleShot() {
  console.log('\n普通截图')
  const data = await post('/api/screenshot', { url: 'example.com', singleShot: true })
  check('请求成功', data.success === true, data.error || '')
  if (!data.success) return

  const raw = Buffer.from(data.screenshot, 'base64')
  check('返回有效 PNG', raw.subarray(0, 8).equals(PNG_MAGIC), `${raw.length} 字节`)
}

async function testSegmented() {
  console.log('\n分段截图（无状态 offset）')
  const url = 'https://en.wikipedia.org/wiki/Screenshot'
  let offset = 0
  const segments = []

  for (let i = 0; i < 4; i++) {
    const data = await post('/api/screenshot', { url, offset })
    if (!data.success) {
      check(`第 ${i + 1} 段请求成功`, false, data.error)
      return
    }

    const raw = data.screenshot ? Buffer.from(data.screenshot, 'base64') : Buffer.alloc(0)
    segments.push({ offset, nextOffset: data.nextOffset, size: raw.length, isEnd: data.isEnd })
    check(
      `第 ${i + 1} 段 offset=${offset} → nextOffset=${data.nextOffset}`,
      raw.length > 0 && raw.subarray(0, 8).equals(PNG_MAGIC),
      `${raw.length} 字节, isEnd=${data.isEnd}`
    )

    if (data.isEnd) break
    offset = data.nextOffset
  }

  // 段与段之间必须首尾相接，既不能重叠也不能跳空
  const continuous = segments.every(
    (seg, i) => i === 0 || segments[i - 1].nextOffset === seg.offset
  )
  check('分段首尾相接，无重叠/跳空', continuous)
}

async function testFullPage() {
  console.log('\n整页截图')
  const data = await post('/api/screenshot', { url: 'example.com', fullPage: true })
  check('请求成功', data.success === true, data.error || '')
  if (!data.success) return

  const raw = Buffer.from(data.screenshot, 'base64')
  check('返回有效 PNG', raw.subarray(0, 8).equals(PNG_MAGIC), `${raw.length} 字节`)
}

async function testMerge() {
  console.log('\n长图拼接')
  const first = await post('/api/screenshot', { url: 'example.com', singleShot: true })
  const second = await post('/api/screenshot', { url: 'example.com', fullPage: true })
  if (!first.success || !second.success) {
    check('拼接前置截图成功', false, '截图阶段失败')
    return
  }

  const data = await post('/api/merge', { screenshots: [first.screenshot, second.screenshot] })
  check('拼接成功', data.success === true, data.error || '')
  if (!data.success) return

  const raw = Buffer.from(data.mergedImage, 'base64')
  check('返回有效 PNG', raw.subarray(0, 8).equals(PNG_MAGIC), `${raw.length} 字节`)

  const empty = await post('/api/merge', { screenshots: [] })
  check('空数组应被拒绝', empty.success === false, empty.error || '未报错')
}

async function main() {
  console.log(`LinkSnapper 冒烟测试 → ${BASE_URL}`)
  try {
    await testSecurity()
    await testValidation()
    await testNoFalsePositive()
    await testSingleShot()
    await testSegmented()
    await testFullPage()
    await testMerge()
  } catch (error) {
    console.error('\n测试执行中断：', error.message)
    failed++
  }

  console.log(`\n结果：\x1b[32m${passed} 通过\x1b[0m，\x1b[31m${failed} 失败\x1b[0m`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
