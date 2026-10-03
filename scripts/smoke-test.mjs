#!/usr/bin/env node
/**
 * LinkSnapper 冒烟测试。
 *
 * 用法：
 *   npm run smoke                      # 需要服务已在 BASE_URL 上跑着
 *   BASE_URL=http://127.0.0.1:3100 npm run smoke
 *   SMOKE_EXTERNAL=1 npm run smoke     # 额外跑一组真实外网站点用例（需要联网）
 *
 * 设计要点：
 *
 * 1. **自带基准页**。分段截图的核心断言是「每段恰好落在页面的哪个位置」，
 *    只有在一个高度、内容都可预测的页面上才验得准。所以用仓库自带的
 *    /test-fixture.html —— 3000px 高、50 条 60px 纯色横条。
 *    服务端需要设 ALLOWED_INTERNAL_HOSTS=127.0.0.1 才能访问它。
 *
 * 2. **像素级验证**。不满足于「段高加起来等于总高」，而是直接读出每段
 *    首行 / 末行的颜色，反推它真实的 y 区间，从根上排除重叠与跳空。
 *
 * 3. **默认不依赖外网**。外网用例放在 SMOKE_EXTERNAL 后面，CI 里可以不开，
 *    避免第三方站点抖动导致误报。
 *
 * 退出码非 0 表示存在断言失败。
 */

import sharp from 'sharp'

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const RUN_EXTERNAL = process.env.SMOKE_EXTERNAL === '1'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// 与 public/test-fixture.html 保持一致
const BAND_HEIGHT = 60
const BAND_COUNT = 50
const FIXTURE_HEIGHT = BAND_HEIGHT * BAND_COUNT // 3000
const BANDS = [
  [0xdc, 0x26, 0x26],
  [0xea, 0x58, 0x0c],
  [0xca, 0x8a, 0x04],
  [0x16, 0xa3, 0x4a],
  [0x08, 0x91, 0xb2],
  [0x25, 0x63, 0xeb],
  [0x7c, 0x3a, 0xed],
  [0xdb, 0x27, 0x77],
  [0x78, 0x35, 0x0f],
  [0x33, 0x41, 0x55],
]
const COLOR_TOLERANCE = 16

const FIXTURE_URL = `${BASE_URL}/test-fixture.html`

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

function section(title) {
  console.log(`\n${title}`)
}

async function post(path, payload, timeoutMs = 180000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      signal: controller.signal,
    })
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    return { status: response.status, headers: response.headers, data }
  } catch (error) {
    return { status: 0, headers: new Headers(), data: null, networkError: error.message }
  } finally {
    clearTimeout(timer)
  }
}

/** 把 base64 PNG 解码成原始像素，方便按下标直接取色 */
async function loadRaw(base64) {
  const buffer = Buffer.from(base64, 'base64')
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { buffer, data, width: info.width, height: info.height, channels: info.channels }
}

function pixelAt(raw, x, y) {
  const index = (y * raw.width + x) * raw.channels
  return [raw.data[index], raw.data[index + 1], raw.data[index + 2]]
}

function colorsClose(a, b, tolerance = COLOR_TOLERANCE) {
  return a.every((value, index) => Math.abs(value - b[index]) <= tolerance)
}

function formatColor(color, expected) {
  return `实际 rgb(${color.join(',')}) 期望 rgb(${expected.join(',')})`
}

function bandColorAt(y) {
  return BANDS[Math.floor(y / BAND_HEIGHT) % BANDS.length]
}

/** 用首行 / 末行颜色反推分段真实覆盖的 y 区间，据此判断是否与预期一致 */
async function verifySegmentPixels(raw, segment, label) {
  const topColor = pixelAt(raw, 10, 0)
  const expectedTop = bandColorAt(segment.offset)
  check(`${label} 首行颜色对应 y=${segment.offset}`, colorsClose(topColor, expectedTop), formatColor(topColor, expectedTop))

  const bottomY = segment.height - 1
  const bottomColor = pixelAt(raw, 10, bottomY)
  const expectedBottom = bandColorAt(segment.offset + bottomY)
  check(
    `${label} 末行颜色对应 y=${segment.offset + bottomY}`,
    colorsClose(bottomColor, expectedBottom),
    formatColor(bottomColor, expectedBottom)
  )
}

// ---------------------------------------------------------------------------

async function testHealth() {
  section('健康检查')
  const response = await fetch(`${BASE_URL}/api/health`).catch(error => ({ ok: false, error }))
  if (!response.ok) {
    check('GET /api/health 返回 200', false, String(response.error || response.status))
    return
  }
  const data = await response.json()
  check('status 为 ok', data.status === 'ok', JSON.stringify(data.guards || {}))
  check(
    '已开启内网拦截',
    data.guards?.privateNetworkBlocked === true,
    `allowedInternalHosts=${JSON.stringify(data.guards?.allowedInternalHosts)}`
  )
}

/**
 * 安全拦截用例。
 *
 * 关键点：断言必须校验「被拒绝的原因」，不能只看状态码。
 * 否则一条用例可能因为完全无关的理由通过（比如网络不通导致的 502），
 * 看起来是绿的，实际护栏根本没生效 —— 这比没有测试更危险。
 */
async function testSecurity() {
  section('安全拦截（SSRF 防护）')

  // 注意：这些地址都不能出现在 ALLOWED_INTERNAL_HOSTS 里，否则会被合法放行。
  // 基准页用的是 127.0.0.1，所以这里刻意改用 127.0.0.2 等其它内网地址，
  // 以及 10.x 的十进制 / 十六进制写法 —— 它们规范化后是 10.0.0.1，同样不在白名单里。
  const blocked = [
    { url: 'http://127.0.0.2:8080/admin', reason: '禁止截图内网' },
    { url: 'http://localhost/x', reason: '禁止截图内网' },
    { url: 'http://localhost.localdomain/', reason: '禁止截图内网' },
    { url: 'http://169.254.169.254/latest/meta-data/', reason: '禁止截图内网' },
    { url: 'http://10.0.0.5/', reason: '禁止截图内网' },
    { url: 'http://172.16.0.1/', reason: '禁止截图内网' },
    { url: 'http://192.168.1.1/', reason: '禁止截图内网' },
    { url: 'http://100.64.0.1/', reason: '禁止截图内网' },
    { url: 'http://[::1]/', reason: '禁止截图内网' },
    { url: 'http://[::ffff:127.0.0.1]/', reason: '禁止截图内网' },
    { url: 'http://[::ffff:7f00:1]/', reason: '禁止截图内网' },
    { url: 'http://[64:ff9b::127.0.0.1]/', reason: '禁止截图内网' },
    { url: 'http://167772161/', reason: '禁止截图内网' }, // 十进制写法 = 10.0.0.1
    { url: 'http://0x0a000001/', reason: '禁止截图内网' }, // 十六进制写法 = 10.0.0.1
    { url: 'http://router.local/', reason: '禁止截图内网' },
    { url: 'http://db.internal/', reason: '禁止截图内网' },
    { url: 'file:///etc/passwd', reason: '仅支持 http 与 https' },
    { url: 'javascript:alert(1)', reason: '仅支持 http 与 https' },
    { url: 'data:text/html,<h1>x</h1>', reason: '仅支持 http 与 https' },
    { url: 'ftp://example.com/', reason: '仅支持 http 与 https' },
    { url: 'http://user:pass@example.com/', reason: '不允许携带用户名或密码' },
  ]

  for (const item of blocked) {
    const { status, data } = await post('/api/screenshot', { url: item.url, singleShot: true })
    const error = data?.error || ''
    check(
      `${item.url} 应因「${item.reason}」被拒`,
      status === 400 && data?.success === false && error.includes(item.reason),
      `HTTP ${status} ${error}`
    )
  }
}

/**
 * 重定向型 SSRF。
 *
 * 这是只做 URL 字面量校验时必然漏掉的一类：用户填的地址完全合法（就在白名单里），
 * 但服务端一访问，对方回一个 302 把它指向云元数据接口。
 * 护栏必须在浏览器发出「跳转后的那个请求」时把它拦下，而不是只看用户填的那一个 URL。
 */
async function testRedirectSsrf() {
  section('重定向型 SSRF')

  const cases = ['http://169.254.169.254/', 'http://10.0.0.5/', 'http://127.0.0.2/']

  for (const target of cases) {
    const url = `${BASE_URL}/api/test-redirect?to=${encodeURIComponent(target)}`
    const { status, data } = await post('/api/screenshot', { url, singleShot: true })
    const error = data?.error || ''

    check(
      `302 跳转到 ${target} 应被拦截`,
      status === 403 && error.includes('内网'),
      `HTTP ${status} ${error}`
    )
  }

  // 反向验证：同一个接口跳到一个正常地址时必须能通过，
  // 否则上面几条「通过」可能只是因为跳转本身失效了。
  const okUrl = `${BASE_URL}/api/test-redirect?to=${encodeURIComponent('/test-fixture.html')}`
  const ok = await post('/api/screenshot', { url: okUrl, singleShot: true })
  check(
    '同一跳转接口指向正常地址时应能正常截图',
    ok.data?.success === true,
    `HTTP ${ok.status} ${ok.data?.error || ''}`
  )
}

async function testNoFalsePositive() {
  section('误杀检测：正常域名不应被当成内网')

  const candidates = ['https://fda.gov/', 'https://fcanet.example/', 'https://fcbarcelona.com/']

  for (const target of candidates) {
    const { data } = await post('/api/screenshot', { url: target, singleShot: true })
    const wronglyBlocked = typeof data?.error === 'string' && data.error.includes('禁止截图内网')
    check(`${target} 不应被判定为内网地址`, !wronglyBlocked, data?.error || '已放行（后续失败与外网可达性有关）')
  }
}

async function testValidation() {
  section('参数校验与请求体限制')

  const cases = [
    {},
    { url: '' },
    { url: '   ' },
    { url: 123 },
    { url: null },
    { url: [] },
  ]

  for (const payload of cases) {
    const { status, data } = await post('/api/screenshot', payload)
    check(`${JSON.stringify(payload)} 应返回 400`, status === 400 && data?.success === false, `HTTP ${status} ${data?.error || ''}`)
  }

  const malformed = await post('/api/screenshot', '{not json')
  check('非法 JSON 应返回 400', malformed.status === 400, `HTTP ${malformed.status} ${malformed.data?.error || ''}`)

  const oversized = await post('/api/screenshot', JSON.stringify({ url: 'example.com', pad: 'x'.repeat(64 * 1024) }))
  check('超大请求体应返回 413', oversized.status === 413, `HTTP ${oversized.status} ${oversized.data?.error || ''}`)
}

async function testFixtureBasics() {
  section('基准页：分段截图（无状态 offset）')

  const first = await post('/api/screenshot', { url: FIXTURE_URL, offset: 0, maxSegments: 1 })
  if (!first.data?.success) {
    check('基准页可访问', false, `${first.data?.error || first.networkError}（服务端是否设置了 ALLOWED_INTERNAL_HOSTS=127.0.0.1？）`)
    return false
  }

  check('基准页可访问', true)
  check(`页面高度为 ${FIXTURE_HEIGHT}px`, first.data.pageHeight === FIXTURE_HEIGHT, `实际 ${first.data.pageHeight}`)
  check('第一段 offset=0, nextOffset=1080', first.data.nextOffset === 1080, `实际 nextOffset=${first.data.nextOffset}`)
  check('第一段 isEnd=false', first.data.isEnd === false)

  const raw = await loadRaw(first.data.segments[0].image)
  check('分段图片宽度为视口宽度 1920', raw.width === 1920, `实际 ${raw.width}`)
  check('分段图片高度为视口高度 1080', raw.height === 1080, `实际 ${raw.height}`)
  await verifySegmentPixels(raw, { offset: 0, height: 1080 }, '第 1 段')

  return true
}

async function testFixtureBatch() {
  section('基准页：单请求批量分段（一次加载截多段）')

  const { data } = await post('/api/screenshot', { url: FIXTURE_URL, offset: 0, maxSegments: 5 })
  if (!data?.success) {
    check('批量请求成功', false, data?.error || '')
    return
  }

  const segments = data.segments || []
  check('一次请求返回 3 段（3000px / 1080px 向上取整）', segments.length === 3, `实际 ${segments.length} 段`)
  check('isEnd=true 且 nextOffset=3000', data.isEnd === true && data.nextOffset === 3000, `isEnd=${data.isEnd} nextOffset=${data.nextOffset}`)

  const expected = [
    { offset: 0, height: 1080 },
    { offset: 1080, height: 1080 },
    { offset: 2160, height: 840 }, // 末段按剩余高度裁剪
  ]

  for (let i = 0; i < Math.min(segments.length, expected.length); i++) {
    const segment = segments[i]
    const want = expected[i]
    check(
      `第 ${i + 1} 段 offset=${want.offset} height=${want.height}`,
      segment.offset === want.offset && segment.height === want.height,
      `实际 offset=${segment.offset} height=${segment.height}`
    )
  }

  // 逐段做像素校验，这是判断「有没有重叠 / 跳空」最硬的证据
  let rawImages = []
  for (let i = 0; i < segments.length; i++) {
    rawImages.push(await loadRaw(segments[i].image))
  }
  for (let i = 0; i < segments.length; i++) {
    await verifySegmentPixels(rawImages[i], segments[i], `第 ${i + 1} 段`)
  }

  const contiguous = segments.every((segment, index) => index === 0 || segments[index - 1].offset + segments[index - 1].height === segment.offset)
  check('分段首尾相接，无重叠/跳空', contiguous)

  const totalHeight = segments.reduce((sum, segment) => sum + segment.height, 0)
  check('分段高度之和等于页面总高', totalHeight === FIXTURE_HEIGHT, `${totalHeight} vs ${FIXTURE_HEIGHT}`)

  return segments
}

async function testFixtureFullPage() {
  section('基准页：整页截图')

  const { data } = await post('/api/screenshot', { url: FIXTURE_URL, fullPage: true })
  if (!data?.success) {
    check('整页截图成功', false, data?.error || '')
    return null
  }

  const raw = await loadRaw(data.screenshot)
  check(`整页图片高度等于页面总高 ${FIXTURE_HEIGHT}`, raw.height === FIXTURE_HEIGHT, `实际 ${raw.height}`)
  check('整页图片宽度为 1920', raw.width === 1920, `实际 ${raw.width}`)

  // 交叉验证：整页截图与分段截图是两条独立路径，结果必须一致
  const midColor = pixelAt(raw, 10, 1019)
  check('整页在 y=1019 处的颜色与分段第 1 段末行一致', colorsClose(midColor, bandColorAt(1019)), formatColor(midColor, bandColorAt(1019)))

  return data.screenshot
}

async function testMerge(segments) {
  section('长图拼接')

  if (!segments || segments.length === 0) {
    check('拼接前置截图成功', false, '没有可用的分段')
    return
  }

  const { data } = await post('/api/merge', { screenshots: segments.map(segment => segment.image) })
  check('拼接成功', data?.success === true, data?.error || '')
  if (!data?.success) return

  const raw = await loadRaw(data.mergedImage)
  check(`拼接结果高度等于页面总高 ${FIXTURE_HEIGHT}`, raw.height === FIXTURE_HEIGHT, `实际 ${raw.height}`)
  check('拼接结果宽度为 1920', raw.width === 1920, `实际 ${raw.width}`)

  // 拼接后仍应保持分段原貌：抽查两个分段边界处的颜色
  const boundaryChecks = [
    { y: 0, label: '顶部 y=0' },
    { y: 1079, label: '第 1 段末行 y=1079' },
    { y: 1080, label: '第 2 段首行 y=1080' },
    { y: 2999, label: '最后一行 y=2999' },
  ]
  for (const { y, label } of boundaryChecks) {
    const color = pixelAt(raw, 10, y)
    check(`${label} 颜色正确`, colorsClose(color, bandColorAt(y)), formatColor(color, bandColorAt(y)))
  }

  const empty = await post('/api/merge', { screenshots: [] })
  check('空数组应被拒绝', empty.status === 400, `HTTP ${empty.status}`)

  const tooMany = await post('/api/merge', { screenshots: new Array(61).fill(segments[0].image) })
  check('超过 60 段应被拒绝', tooMany.status === 400, `HTTP ${tooMany.status} ${tooMany.data?.error || ''}`)
}

async function testSingleShot() {
  section('基准页：普通截图（当前视口）')

  const { data } = await post('/api/screenshot', { url: FIXTURE_URL, singleShot: true })
  if (!data?.success) {
    check('普通截图成功', false, data?.error || '')
    return
  }

  const raw = await loadRaw(data.screenshot)
  check('尺寸为 1920x1080', raw.width === 1920 && raw.height === 1080, `实际 ${raw.width}x${raw.height}`)
  check('顶部颜色对应 y=0', colorsClose(pixelAt(raw, 10, 0), bandColorAt(0)), formatColor(pixelAt(raw, 10, 0), bandColorAt(0)))
}

async function testPreciseShot() {
  section('精细化截图：selector / clip / format')

  // ---- selector：只截单个元素 ----
  const sel = await post('/api/screenshot', { url: FIXTURE_URL, selector: '[data-index="3"]' })
  if (!sel.data?.success) {
    check('selector 截图成功', false, sel.data?.error || '')
  } else {
    check('selector 截图成功', true)
    const raw = await loadRaw(sel.data.screenshot)
    check('selector 元素高度为 60px', raw.height === 60, `实际 ${raw.height}`)
    const top = pixelAt(raw, 10, 0)
    check('selector 顶部颜色对应 band #3', colorsClose(top, bandColorAt(180)), formatColor(top, bandColorAt(180)))
  }

  const selMiss = await post('/api/screenshot', { url: FIXTURE_URL, selector: '.does-not-exist' })
  check(
    'selector 未命中返回 400',
    selMiss.status === 400 && selMiss.data?.error?.includes('未匹配'),
    `HTTP ${selMiss.status} ${selMiss.data?.error || ''}`
  )

  // ---- clip：手动裁剪区域 ----
  const clip = await post('/api/screenshot', {
    url: FIXTURE_URL,
    clip: { x: 0, y: 120, width: 1920, height: 240 },
  })
  if (!clip.data?.success) {
    check('clip 截图成功', false, clip.data?.error || '')
  } else {
    check('clip 截图成功', true)
    const raw = await loadRaw(clip.data.screenshot)
    check('clip 图片尺寸为 1920x240', raw.width === 1920 && raw.height === 240, `实际 ${raw.width}x${raw.height}`)
    const top = pixelAt(raw, 10, 0)
    check('clip 顶部(y=120)对应 band #2', colorsClose(top, bandColorAt(120)), formatColor(top, bandColorAt(120)))
    const bottom = pixelAt(raw, 10, 239)
    check('clip 底部(y=359)对应 band #5', colorsClose(bottom, bandColorAt(359)), formatColor(bottom, bandColorAt(359)))
  }

  const clipBad = await post('/api/screenshot', { url: FIXTURE_URL, clip: { x: 0, y: 0, width: 0, height: 10 } })
  check('clip 宽高为 0 返回 400', clipBad.status === 400, `HTTP ${clipBad.status} ${clipBad.data?.error || ''}`)

  // ---- format：输出格式 ----
  const jpeg = await post('/api/screenshot', { url: FIXTURE_URL, singleShot: true, format: 'jpeg', quality: 50 })
  if (!jpeg.data?.success) {
    check('format=jpeg 截图成功', false, jpeg.data?.error || '')
  } else {
    check('format=jpeg 截图成功', true)
    check('响应 format=jpeg', jpeg.data.format === 'jpeg', `实际 ${jpeg.data.format}`)
    check('响应 contentType=image/jpeg', jpeg.data.contentType === 'image/jpeg', `实际 ${jpeg.data.contentType}`)
    const buf = Buffer.from(jpeg.data.screenshot, 'base64')
    check('JPEG 魔术字节 FF D8 FF', buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff, `首字节 ${buf[0]},${buf[1]},${buf[2]}`)
  }

  const webp = await post('/api/screenshot', { url: FIXTURE_URL, singleShot: true, format: 'webp' })
  if (!webp.data?.success) {
    check('format=webp 截图成功', false, webp.data?.error || '')
  } else {
    check('format=webp 截图成功', true)
    check('响应 format=webp', webp.data.format === 'webp', `实际 ${webp.data.format}`)
    const buf = Buffer.from(webp.data.screenshot, 'base64')
    const head = buf.subarray(0, 4).toString('ascii')
    check('WEBP 魔术字节 RIFF', head === 'RIFF', `首 4 字节 ${head}`)
  }

  const badFmt = await post('/api/screenshot', { url: FIXTURE_URL, singleShot: true, format: 'gif' })
  check('非法 format 返回 400', badFmt.status === 400, `HTTP ${badFmt.status} ${badFmt.data?.error || ''}`)
}

// ---------------------------------------------------------------------------
// 竞品标配能力：视口 / 设备模拟 / 暗色 / 注入 / 隐藏 / 去 Cookie / PDF / 批量
// ---------------------------------------------------------------------------

const BAND0 = BANDS[0] // rgb(220,38,38)
const BAND1 = BANDS[1] // rgb(234,88,12)

/** 截一个固定小区域并取色，用来验证"页面修饰是否真的生效" */
async function clipPixel(body) {
  const { data, status } = await post('/api/screenshot', {
    url: FIXTURE_URL,
    clip: { x: 0, y: 0, width: 60, height: 60 },
    ...body,
  })
  if (!data?.success) return { error: data?.error || `HTTP ${status}` }
  const raw = await loadRaw(data.screenshot)
  return { color: pixelAt(raw, 10, 10) }
}

async function testPageOptions() {
  section('竞品标配：视口 / 设备模拟')

  const custom = await post('/api/screenshot', { url: FIXTURE_URL, singleShot: true, width: 800, height: 600 })
  if (custom.data?.success) {
    const buf = Buffer.from(custom.data.screenshot, 'base64')
    const w = buf.readUInt32BE(16)
    const h = buf.readUInt32BE(20)
    check('自定义视口生效', w === 800 && h === 600, `实际 ${w}x${h}`)
  } else {
    check('自定义视口生效', false, custom.data?.error || '')
  }

  const mobile = await post('/api/screenshot', { url: FIXTURE_URL, singleShot: true, device: 'mobile' })
  if (mobile.data?.success) {
    const buf = Buffer.from(mobile.data.screenshot, 'base64')
    const w = buf.readUInt32BE(16)
    const h = buf.readUInt32BE(20)
    // mobile 预设 390x844 @3x —— 必须连 deviceScaleFactor 一起生效，
    // 只改分辨率不改 isMobile/dsf 的话响应式断点不会触发
    check('device=mobile 生效（含 3x 缩放）', w === 1170 && h === 2532, `实际 ${w}x${h}`)
  } else {
    check('device=mobile 生效（含 3x 缩放）', false, mobile.data?.error || '')
  }

  const badDevice = await post('/api/screenshot', { url: FIXTURE_URL, singleShot: true, device: 'watch' })
  check('非法 device 返回 400', badDevice.status === 400, `HTTP ${badDevice.status}`)

  const zeroWidth = await post('/api/screenshot', { url: FIXTURE_URL, singleShot: true, width: 0 })
  check('width=0 返回 400', zeroWidth.status === 400, `HTTP ${zeroWidth.status}`)

  section('竞品标配：CSS / JS 注入')

  const injectedCss = await clipPixel({
    css: '.band[data-index="0"] { background: rgb(1,2,3) !important; }',
  })
  check(
    '注入 CSS 生效',
    injectedCss.color && colorsClose(injectedCss.color, [1, 2, 3]),
    injectedCss.color ? formatColor(injectedCss.color, [1, 2, 3]) : injectedCss.error
  )

  const injectedJs = await clipPixel({
    js: "document.querySelector('.band[data-index=\"0\"]').style.background = 'rgb(4,5,6)'",
  })
  check(
    '注入 JS 生效',
    injectedJs.color && colorsClose(injectedJs.color, [4, 5, 6]),
    injectedJs.color ? formatColor(injectedJs.color, [4, 5, 6]) : injectedJs.error
  )

  const hugeCss = await post('/api/screenshot', { url: FIXTURE_URL, singleShot: true, css: 'a'.repeat(20000) })
  check('超大 CSS 返回 413', hugeCss.status === 413, `HTTP ${hugeCss.status}`)

  section('竞品标配：隐藏元素 / 暗色模式')

  const hidden = await clipPixel({ hideSelectors: ['.band[data-index="0"]'] })
  check(
    'hideSelectors 生效（后续元素上移补位）',
    hidden.color && colorsClose(hidden.color, BAND1),
    hidden.color ? formatColor(hidden.color, BAND1) : hidden.error
  )

  const badHide = await post('/api/screenshot', {
    url: FIXTURE_URL,
    singleShot: true,
    hideSelectors: ['a { color: red }'],
  })
  check('hideSelectors 含 CSS 注入字符被拒', badHide.status === 400, `HTTP ${badHide.status}`)

  const DARK_CSS = [
    '.band[data-index="0"] { background: rgb(20,20,20) !important; }',
    '@media (prefers-color-scheme: dark) { .band[data-index="0"] { background: rgb(240,240,240) !important; } }',
  ].join('\n')

  const light = await clipPixel({ css: DARK_CSS, darkMode: false })
  check(
    '暗色模式关闭时走亮色分支',
    light.color && colorsClose(light.color, [20, 20, 20]),
    light.color ? formatColor(light.color, [20, 20, 20]) : light.error
  )

  const dark = await clipPixel({ css: DARK_CSS, darkMode: true })
  check(
    '暗色模式开启时走暗色分支',
    dark.color && colorsClose(dark.color, [240, 240, 240]),
    dark.color ? formatColor(dark.color, [240, 240, 240]) : dark.error
  )

  section('竞品标配：去 Cookie 弹窗')

  const MAKE_BANNER_JS =
    "const d=document.createElement('div');d.className='cookie-banner';" +
    "d.style.cssText='position:fixed;top:0;left:0;width:60px;height:60px;background:rgb(7,7,7);z-index:99999';" +
    'document.body.appendChild(d)'

  const withBanner = await clipPixel({ js: MAKE_BANNER_JS, blockCookieBanners: false })
  check(
    '不开启时弹窗可见（对照）',
    withBanner.color && colorsClose(withBanner.color, [7, 7, 7]),
    withBanner.color ? formatColor(withBanner.color, [7, 7, 7]) : withBanner.error
  )

  const withoutBanner = await clipPixel({ js: MAKE_BANNER_JS, blockCookieBanners: true })
  check(
    '开启后弹窗被隐藏，露出底层内容',
    withoutBanner.color && colorsClose(withoutBanner.color, BAND0),
    withoutBanner.color ? formatColor(withoutBanner.color, BAND0) : withoutBanner.error
  )

  section('竞品标配：PDF 输出')

  const pdf = await post('/api/screenshot', { url: FIXTURE_URL, format: 'pdf' })
  if (pdf.data?.success) {
    const buf = Buffer.from(pdf.data.screenshot, 'base64')
    check('返回 PDF（%PDF- 魔数）', buf.subarray(0, 5).toString('ascii') === '%PDF-', `${buf.length} 字节`)
    check('contentType 为 application/pdf', pdf.data.contentType === 'application/pdf', pdf.data.contentType)
  } else {
    check('返回 PDF（%PDF- 魔数）', false, pdf.data?.error || `HTTP ${pdf.status}`)
  }

  section('等待策略')

  const waited = await post('/api/screenshot', {
    url: FIXTURE_URL,
    singleShot: true,
    waitForSelector: '.band[data-index="49"]',
  })
  check('waitForSelector 命中即截图', waited.data?.success === true, waited.data?.error || '')

  const never = await post('/api/screenshot', {
    url: FIXTURE_URL,
    singleShot: true,
    waitForSelector: '.band[data-index="9999"]',
  })
  check('waitForSelector 超时返回 504', never.status === 504, `HTTP ${never.status}`)
}

async function testBulk() {
  section('竞品标配：批量截图')

  const two = await post('/api/screenshot/bulk', {
    urls: [FIXTURE_URL, `${BASE_URL}/test-fixture.html`],
    singleShot: true,
  })
  if (two.data?.success) {
    check('两张全部成功', two.data.succeeded === 2 && two.data.failed === 0, `成功 ${two.data.succeeded} 失败 ${two.data.failed}`)
    check('结果条数与请求一致', (two.data.results || []).length === 2, `实际 ${(two.data.results || []).length} 条`)
  } else {
    check('两张全部成功', false, two.data?.error || `HTTP ${two.status}`)
  }

  const partial = await post('/api/screenshot/bulk', {
    urls: [FIXTURE_URL, 'http://169.254.169.254/latest/meta-data/'],
    singleShot: true,
  })
  if (partial.data?.success) {
    check(
      '单个失败不影响整批（仍返回 200）',
      partial.status === 200 && partial.data.succeeded === 1 && partial.data.failed === 1,
      `成功 ${partial.data.succeeded} 失败 ${partial.data.failed}`
    )
    check(
      '失败项给出了拒绝原因',
      String((partial.data.results || []).find(r => !r.success)?.error || '').includes('内网'),
      (partial.data.results || []).find(r => !r.success)?.error || ''
    )
  } else {
    check('单个失败不影响整批（仍返回 200）', false, partial.data?.error || `HTTP ${partial.status}`)
  }

  const tooMany = await post('/api/screenshot/bulk', { urls: new Array(21).fill(FIXTURE_URL) })
  check('超过 20 个地址返回 400', tooMany.status === 400, `HTTP ${tooMany.status} ${tooMany.data?.error || ''}`)

  const empty = await post('/api/screenshot/bulk', { urls: [] })
  check('空数组返回 400', empty.status === 400, `HTTP ${empty.status}`)

  const notArray = await post('/api/screenshot/bulk', { urls: FIXTURE_URL })
  check('urls 非数组返回 400', notArray.status === 400, `HTTP ${notArray.status}`)
}

async function testRateLimit() {
  section('限流（放在最后，会消耗掉本机额度）')

  let got429 = false
  let attempts = 0

  // 用必然校验失败的入参：请求会走到限流器，但不会真的启动浏览器，所以很快
  for (let i = 0; i < 400; i++) {
    attempts++
    const { status, headers } = await post('/api/screenshot', { url: '' })
    if (status === 429) {
      got429 = true
      check('超量请求返回 429', true, `第 ${attempts} 次请求触发`)
      check('429 带 Retry-After 头', Boolean(headers.get('retry-after')), `Retry-After=${headers.get('retry-after')}`)
      break
    }
  }

  if (!got429) {
    check('超量请求返回 429', false, `连续 ${attempts} 次请求都没有被限流`)
  }
}

async function testExternal() {
  section('外网站点（SMOKE_EXTERNAL=1）')

  const { data } = await post('/api/screenshot', { url: 'example.com', singleShot: true })
  check('example.com 普通截图成功', data?.success === true, data?.error || '')
  if (data?.success) {
    const raw = Buffer.from(data.screenshot, 'base64')
    check('返回有效 PNG', raw.subarray(0, 8).equals(PNG_MAGIC), `${raw.length} 字节`)
  }

  const { data: wiki } = await post('/api/screenshot', { url: 'https://en.wikipedia.org/wiki/Screenshot', maxSegments: 2 })
  check('维基百科分段截图成功', wiki?.success === true, wiki?.error || '')
  if (wiki?.success) {
    check('返回 2 段', (wiki.segments || []).length === 2, `实际 ${(wiki.segments || []).length} 段`)
  }
}

async function main() {
  console.log(`LinkSnapper 冒烟测试 → ${BASE_URL}`)
  console.log(`基准页：${FIXTURE_URL}`)

  try {
    await testHealth()
    await testSecurity()
    await testRedirectSsrf()
    await testNoFalsePositive()
    await testValidation()

    const fixtureOk = await testFixtureBasics()
    if (fixtureOk) {
      await testSingleShot()
      await testPreciseShot()
      const segments = await testFixtureBatch()
      await testFixtureFullPage()
      await testMerge(segments)
      await testPageOptions()
      await testBulk()
    } else {
      console.log('\n\x1b[33m基准页不可用，跳过所有分段 / 拼接 / 页面修饰用例\x1b[0m')
    }

    if (RUN_EXTERNAL) {
      await testExternal()
    } else {
      section('外网站点')
      console.log('  已跳过（需要联网时加 SMOKE_EXTERNAL=1）')
    }

    await testRateLimit()
  } catch (error) {
    console.error('\n测试执行中断：', error)
    failed++
  }

  console.log(`\n结果：\x1b[32m${passed} 通过\x1b[0m，\x1b[31m${failed} 失败\x1b[0m`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
