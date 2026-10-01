import { ElementHandle, Page } from 'puppeteer-core'
import sharp from 'sharp'
import { withPage } from '@/services/browser'
import {
  CONTENT_TYPES,
  encodeImage,
  parseClip,
  parseFormat,
  parseQuality,
  parseSelector,
} from '@/utils/screenshot-params'
import {
  assertSafeUrl,
  isBlockedHostname,
  isHostnameResolvingToPrivate,
  isPrivateNetworkAllowed,
  SAFE_INTERNAL_PROTOCOLS,
} from '@/utils/url-guard'
import { BoundedSemaphore, TokenBucketLimiter, getClientKey, QueueFullError, QueueTimeoutError } from '@/utils/rate-limit'
import { endRequest, tryBeginRequest } from '@/utils/lifecycle'
import { createRateLimitBackend } from '@/utils/rate-limit-store'
import { HttpError, readJsonBody } from '@/utils/http-error'
import { isAuthorized } from '@/utils/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 2
const RETRY_DELAY_MS = 1200
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS) || 30_000
const PRELOAD_MAX_MS = 12_000
const SETTLE_MAX_MS = 6_000
const MAX_OFFSET = 500_000

// 整页截图与分段截图的高度上限。
// 一条 1920x30000 的 PNG base64 后约 30MB，再往上就有把进程内存打满的风险。
const MAX_FULLPAGE_HEIGHT = Number(process.env.MAX_FULLPAGE_HEIGHT) || 30_000

// 单次请求最多返回几段。批量化是为了省掉「每次都要重新加载页面」，
// 但一次返回太多段会让响应体膨胀、前端渲染卡顿，这里取一个折中值。
const DEFAULT_MAX_SEGMENTS = 6
const MAX_SEGMENTS_PER_REQUEST = 12

const MAX_CONCURRENT_CAPTURES = Number(process.env.MAX_CONCURRENT_CAPTURES) || 3
const MAX_QUEUE_LENGTH = Number(process.env.MAX_QUEUE_LENGTH) || 24
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS) || 45_000

// 每 IP 的令牌桶：容量 6 次突发，之后按 0.2 次/秒（即 12 次/分钟）补充。
// 单次截图动辄数秒，这个额度对正常使用者绰绰有余，对脚本刷接口则很快见底。
const RATE_LIMIT_CAPACITY = Number(process.env.RATE_LIMIT_CAPACITY) || 6
const RATE_LIMIT_REFILL_PER_SEC = Number(process.env.RATE_LIMIT_REFILL_PER_SEC) || 0.2

const captureSemaphore = new BoundedSemaphore(MAX_CONCURRENT_CAPTURES, MAX_QUEUE_LENGTH, QUEUE_TIMEOUT_MS)
// 限流后端：默认进程内；设置 REDIS_URL 后自动切换为跨副本共享的 Redis 后端
const ipLimiter = new TokenBucketLimiter(RATE_LIMIT_CAPACITY, RATE_LIMIT_REFILL_PER_SEC, createRateLimitBackend().backend)

type WebsiteType = 'dynamic' | 'static' | 'spa'

interface ScreenshotPayload {
  url: string
  fullPage?: boolean
  singleShot?: boolean
  offset?: number
  maxSegments?: number
  selector?: string | null
  clip?: { x: number; y: number; width: number; height: number } | null
  format: 'png' | 'jpeg' | 'webp'
  quality: number
}

interface CapturedSegment {
  offset: number
  height: number
  image: string
}

interface CaptureOutcome {
  segments: CapturedSegment[]
  isEnd: boolean
  nextOffset: number
  pageHeight: number
}

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' }

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * 已知的动态加载站点，走更长的等待策略。
 * 这里按主机名后缀匹配，不能用 includes —— 否则 notbilibili.com 也会命中。
 */
const KNOWN_DYNAMIC_SITES = ['bilibili.com', 'zhihu.com', 'weibo.com', 'douyin.com', 'xiaohongshu.com']

const LOADING_SELECTORS = [
  '.loading',
  '[data-loading]',
  '.infinite-loading',
  '.spinner',
  '.loader',
  '.bili-spinner',
  '.loading-state',
].join(',')

function normalizeOffset(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.min(Math.trunc(parsed), MAX_OFFSET)
}

function normalizeMaxSegments(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 1
  return Math.min(Math.trunc(parsed), MAX_SEGMENTS_PER_REQUEST)
}

/**
 * 判断一次失败是否值得重试。
 * 域名不存在、地址非法、被护栏拦下这类错误重试多少次结果都一样；
 * 而超时、连接被重置这类则往往是瞬时的，值得重试。
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status >= 500

  const message = error instanceof Error ? error.message : String(error)
  const permanentPatterns = [
    'ERR_NAME_NOT_RESOLVED',
    'ERR_INVALID_URL',
    'ERR_INVALID_ARGUMENT',
    'ERR_UNSAFE_PORT',
    'ERR_BLOCKED_BY_CLIENT',
    'ERR_ADDRESS_INVALID',
  ]
  return !permanentPatterns.some(pattern => message.includes(pattern))
}

/** 把浏览器抛出的底层错误翻译成对使用者有意义的状态码与文案 */
function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error

  const message = error instanceof Error ? error.message : String(error)

  if (error instanceof QueueFullError) return new HttpError(503, error.message)
  if (error instanceof QueueTimeoutError) return new HttpError(503, error.message)

  if (/Navigation timeout|Timeout|timeout/i.test(message)) {
    return new HttpError(504, '目标页面加载超时，请稍后重试或换一个地址')
  }
  if (message.includes('ERR_NAME_NOT_RESOLVED')) {
    return new HttpError(502, '无法解析该域名，请检查地址是否正确')
  }
  if (message.includes('ERR_CONNECTION_REFUSED')) {
    return new HttpError(502, '目标服务器拒绝连接')
  }
  if (message.includes('ERR_CONNECTION_RESET') || message.includes('ERR_CONNECTION_CLOSED')) {
    return new HttpError(502, '与目标服务器的连接被中断')
  }
  if (message.includes('ERR_ABORTED')) {
    return new HttpError(502, '页面加载被中断，可能是目标站点限制了访问')
  }
  if (message.includes('ERR_CERT') || message.includes('ERR_SSL')) {
    return new HttpError(502, '目标站点证书校验失败')
  }
  if (message.includes('未找到可用的 Chrome')) {
    // 这是部署/配置缺失，不是内部 bug —— 返回 503 比 500 更准确，
    // 并且把安装命令透传给调用方，避免运维对着日志猜。
    return new HttpError(503, `${message}\n运行 \`node scripts/install-chrome.mjs\` 安装匹配的 Chrome for Testing。`)
  }

  return new HttpError(500, '截图失败，请稍后重试')
}

// ---------------------------------------------------------------------------
// 请求拦截：SSRF 的第二道防线
// ---------------------------------------------------------------------------

interface GuardState {
  blockedUrl: string | null
}

/**
 * 只校验用户填进来的那个 URL 是拦不住 SSRF 的：
 *   - 页面可以 302 跳到内网地址，校验发生在跳转之前；
 *   - 页面里的 img / script / fetch 也能直接把请求打到内网；
 *   - 域名本身合法，但 DNS 记录指向 127.0.0.1（DNS 重绑定）。
 *
 * 所以必须在浏览器真正发出请求的那一刻逐个校验，这里就是那个关口。
 */
async function installRequestGuard(page: Page, state: GuardState): Promise<void> {
  await page.setRequestInterception(true)

  page.on('request', request => {
    void (async () => {
      try {
        let parsed: URL
        try {
          parsed = new URL(request.url())
        } catch {
          await request.abort('blockedbyclient')
          return
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          // data: / blob: / about: 是页面自身的内部资源，与网络访问无关
          if (SAFE_INTERNAL_PROTOCOLS.has(parsed.protocol)) await request.continue()
          else await request.abort('blockedbyclient')
          return
        }

        if (!isPrivateNetworkAllowed()) {
          // 1) 字面量拦截：直写内网 IP、localhost、*.internal 之类
          if (isBlockedHostname(parsed.hostname)) {
            state.blockedUrl = request.url()
            await request.abort('blockedbyclient')
            return
          }

          // 2) 解析后拦截：域名合法但指向内网
          if (await isHostnameResolvingToPrivate(parsed.hostname)) {
            state.blockedUrl = request.url()
            await request.abort('blockedbyclient')
            return
          }
        }

        await request.continue()
      } catch {
        // 无论如何都要让请求有个归宿，否则页面会一直卡住
        await request.continue().catch(() => {})
      }
    })()
  })
}

// ---------------------------------------------------------------------------
// 页面处理
// ---------------------------------------------------------------------------

async function detectWebsiteType(page: Page, target: URL): Promise<WebsiteType> {
  const host = target.hostname.toLowerCase()

  if (KNOWN_DYNAMIC_SITES.some(site => host === site || host.endsWith(`.${site}`))) {
    return 'dynamic'
  }

  const isSpa = await page
    .evaluate(() => {
      return (
        typeof window.history.pushState === 'function' &&
        !!document.querySelector('div[id="app"], div[id="root"], div[id="__next"]')
      )
    })
    .catch(() => false)

  return isSpa ? 'spa' : 'static'
}

/** 等待动态内容稳定：页面高度不再变化且没有加载指示器，最多等 maxMs */
async function waitForDynamicContent(page: Page, maxMs = SETTLE_MAX_MS): Promise<void> {
  await page
    .evaluate(
      async (limit: number, loadingSelector: string) => {
        const startedAt = Date.now()
        let previousHeight = document.documentElement.scrollHeight
        let stableRounds = 0

        while (Date.now() - startedAt < limit && stableRounds < 3) {
          await new Promise(resolve => setTimeout(resolve, 400))
          const currentHeight = document.documentElement.scrollHeight
          const loadingCount = document.querySelectorAll(loadingSelector).length

          if (currentHeight === previousHeight && loadingCount === 0) {
            stableRounds++
          } else {
            stableRounds = 0
            previousHeight = currentHeight
          }
        }
      },
      maxMs,
      LOADING_SELECTORS
    )
    .catch(() => {})
}

/**
 * 预加载懒加载内容：滚到底再回到顶部，让懒加载 / 无限滚动的区块都渲染出来。
 * 用 while(true) 遇到无限滚动站点会一直转下去，所以加了时间上限。
 */
async function preloadLazyContent(page: Page, maxMs = PRELOAD_MAX_MS): Promise<void> {
  await page
    .evaluate(
      async (limit: number) => {
        const startedAt = Date.now()
        const step = Math.max(200, Math.floor(window.innerHeight * 0.8))
        let lastY = -1

        while (Date.now() - startedAt < limit) {
          window.scrollBy(0, step)
          await new Promise(resolve => setTimeout(resolve, 150))

          const y = window.pageYOffset
          const atBottom = y + window.innerHeight >= document.documentElement.scrollHeight - 2

          if (y === lastY) break // 已经滚不动了
          lastY = y
          if (atBottom) await new Promise(resolve => setTimeout(resolve, 300))
        }

        window.scrollTo(0, 0)
        await new Promise(resolve => setTimeout(resolve, 200))
      },
      maxMs
    )
    .catch(() => {})
}

async function settlePage(page: Page, type: WebsiteType): Promise<void> {
  const timeout = type === 'static' ? 8000 : 15000

  // 注意：这里不能再用 page.waitForTimeout，该 API 在 puppeteer 22 中已被移除
  await page
    .waitForFunction(() => document.readyState === 'complete' || document.readyState === 'interactive', { timeout })
    .catch(() => {})

  if (type === 'static') {
    await sleep(500)
  } else {
    await waitForDynamicContent(page)
  }
}

async function measurePage(page: Page) {
  return page.evaluate(() => ({
    pageHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      document.documentElement.offsetHeight
    ),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  }))
}

async function takeClip(page: Page, offset: number, width: number, height: number): Promise<string> {
  const image = await page.screenshot({
    type: 'png',
    optimizeForSpeed: true,
    encoding: 'base64',
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: offset,
      width: Math.max(1, width),
      height: Math.max(1, height),
    },
  })

  return image as string
}

async function captureOnce(payload: ScreenshotPayload): Promise<CaptureOutcome> {
  const target = new URL(payload.url)
  const guard: GuardState = { blockedUrl: null }

  return withPage(async page => {
    await installRequestGuard(page, guard)

    try {
      await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    } catch (error) {
      if (guard.blockedUrl) {
        throw new HttpError(403, '目标地址（或其跳转、子资源）指向内网，已拦截')
      }
      throw error
    }

    const websiteType = await detectWebsiteType(page, target)
    await settlePage(page, websiteType)

    // ---- 元素级截图 ----
    // 优先级最高：只截匹配到的第一个元素（整元素，可超出视口）。
    if (payload.selector) {
      const element: ElementHandle<Element> | null = await page.$(payload.selector)
      if (!element) {
        throw new HttpError(400, `selector "${payload.selector}" 未匹配到任何元素`)
      }

      const png = (await element.screenshot({ type: 'png', captureBeyondViewport: true })) as Buffer
      const meta = await sharp(png).metadata()
      const image = (await encodeImage(png, payload.format, payload.quality)).toString('base64')

      return {
        segments: [{ offset: 0, height: meta.height ?? 0, image }],
        isEnd: true,
        nextOffset: 0,
        pageHeight: meta.height ?? 0,
      }
    }

    // ---- 手动区域截图 ----
    // 坐标以页面左上角为原点，单位 CSS 像素；captureBeyondViewport 允许裁到视口之外。
    if (payload.clip) {
      const png = (await page.screenshot({
        type: 'png',
        captureBeyondViewport: true,
        clip: payload.clip,
      })) as Buffer
      const image = (await encodeImage(png, payload.format, payload.quality)).toString('base64')

      return {
        segments: [{ offset: 0, height: payload.clip.height, image }],
        isEnd: true,
        nextOffset: 0,
        pageHeight: payload.clip.height,
      }
    }

    // ---- 整页截图 ----
    if (payload.fullPage) {
      if (websiteType !== 'static') {
        await preloadLazyContent(page)
        await waitForDynamicContent(page)
      }

      const { pageHeight } = await measurePage(page)
      if (pageHeight > MAX_FULLPAGE_HEIGHT) {
        throw new HttpError(
          413,
          `页面高度 ${pageHeight}px 超出整页截图上限 ${MAX_FULLPAGE_HEIGHT}px，请改用分段截图`
        )
      }

      // 这里走 puppeteer 自己的 fullPage 路径（内部同样按内容尺寸裁剪），
      // 比自己算 clip 更稳，也不受页面滚动位置影响。
      const png = (await page.screenshot({
        fullPage: true,
        type: 'png',
        optimizeForSpeed: true,
      })) as Buffer
      const image = (await encodeImage(png, payload.format, payload.quality)).toString('base64')

      return { segments: [{ offset: 0, height: pageHeight, image }], isEnd: true, nextOffset: 0, pageHeight }
    }

    // ---- 普通单次截图（当前视口）----
    if (payload.singleShot) {
      const png = (await page.screenshot({
        fullPage: false,
        type: 'png',
        optimizeForSpeed: true,
        captureBeyondViewport: false,
      })) as Buffer
      const image = (await encodeImage(png, payload.format, payload.quality)).toString('base64')

      return { segments: [{ offset: 0, height: 0, image }], isEnd: true, nextOffset: 0, pageHeight: 0 }
    }

    // ---- 分段截图 ----
    // 滚动位置由前端通过 offset 传入，服务端不保存任何会话状态，
    // 这样多实例部署、重启、并发请求都不会互相污染。
    const offset = normalizeOffset(payload.offset)
    const maxSegments = normalizeMaxSegments(payload.maxSegments)

    if (websiteType !== 'static') {
      await preloadLazyContent(page)
    }

    const { pageHeight, viewportWidth, viewportHeight } = await measurePage(page)

    if (offset >= pageHeight) {
      return { segments: [], isEnd: true, nextOffset: offset, pageHeight }
    }

    // 裁剪坐标以页面左上角为原点，先把滚动位置归零再截，
    // 避免页面残留的滚动位置影响 clip 的参考系。
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {})

    // 一次请求内连续截多段：页面只加载一次、预加载滚动只跑一次，
    // 省掉的是 N 次 Chromium 冷启动 + N 次完整页面加载。
    const segments: CapturedSegment[] = []
    let cursor = offset

    while (segments.length < maxSegments && cursor < pageHeight) {
      // 最后一段按剩余高度裁剪，避免 clip 越出页面边界导致截图报错
      const height = Math.max(1, Math.min(viewportHeight, pageHeight - cursor))
      const image = await takeClip(page, cursor, viewportWidth, height)
      segments.push({ offset: cursor, height, image })
      cursor += height
    }

    return {
      segments,
      isEnd: cursor >= pageHeight,
      nextOffset: cursor,
      pageHeight,
    }
  })
}

/** 统一重试入口：保证每次重试都带上完整参数（原实现在递归时漏传了 singleShot） */
async function captureWithRetry(payload: ScreenshotPayload): Promise<CaptureOutcome> {
  let lastError: unknown

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await captureOnce(payload)
    } catch (error) {
      lastError = error
      // 确定性错误重试只会白白拖长响应时间
      if (!isRetryable(error) || attempt === MAX_RETRIES) break

      console.warn(`截图失败，正在重试 (${attempt + 1}/${MAX_RETRIES})：`, error)
      await sleep(RETRY_DELAY_MS)
    }
  }

  throw lastError
}

export async function POST(request: Request) {
  try {
    if (!isAuthorized(request)) {
      throw new HttpError(401, '缺少或错误的访问令牌')
    }

    const clientKey = getClientKey(request)
    const quota = await ipLimiter.take(clientKey)
    if (!quota.allowed) {
      return Response.json(
        { success: false, error: '请求过于频繁，请稍后再试' },
        { status: 429, headers: { ...NO_STORE_HEADERS, 'Retry-After': String(quota.retryAfterSec) } }
      )
    }

    const body = (await readJsonBody(request)) as Partial<ScreenshotPayload>

    let target: URL
    try {
      target = assertSafeUrl(body?.url)
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'url 参数不合法')
    }

    // 精细化截图参数：格式 / 质量 / 选择器 / 裁剪区域。
    // 解析放到这里而不是 captureOnce 里，是为了让非法参数尽早以 400 失败，
    // 不必先拉起 Chromium 才报错（省一次昂贵的浏览器启动）。
    const format = parseFormat(body.format)
    const quality = parseQuality(body.quality, format)
    const selector = parseSelector(body.selector)
    const clip = parseClip(body.clip)

    // 优先级：selector > clip > fullPage > singleShot > 分段。
    // selector / clip 会隐式覆盖整页与视口模式，避免语义冲突。
    const fullPage = Boolean(body.fullPage) && !selector && !clip
    const singleShot = Boolean(body.singleShot) && !selector && !clip && !fullPage

    // 分段模式恒为 PNG；其余模式按 format 输出。
    const effectiveFormat = selector || clip || fullPage || singleShot ? format : 'png'

    // 挂起的排队请求数也一并回传，方便运维侧观察压力
    const payload: ScreenshotPayload = {
      url: target.toString(),
      fullPage,
      singleShot,
      offset: normalizeOffset(body.offset),
      maxSegments: normalizeMaxSegments(body.maxSegments ?? (singleShot || fullPage ? 1 : DEFAULT_MAX_SEGMENTS)),
      selector,
      clip,
      format,
      quality,
    }

    // 并发闸门：每个截图任务都要占一个 Chromium。队列满 / 等待超时抛出的
    // QueueFullError / QueueTimeoutError 会被外层的 toHttpError 翻译成 503，
    // 避免瞬间大量请求把内存打满（在内存受限的容器里尤其关键）。
    // 停机排空阶段直接拒绝新请求。这里必须「拒绝」而不是「照常排队」：
    // 排空有超时上限，此时进来的请求大概率会在半途被掐断，
    // 客户端拿到连接重置，比立刻收到 503 后重试其他实例更糟。
    if (!tryBeginRequest()) {
      throw new HttpError(503, '实例正在停机排空，不再接收新的截图任务')
    }

    const release = await captureSemaphore.acquire()
    try {
      const result = await captureWithRetry(payload)

      return Response.json(
        {
          success: true,
          // segments 是标准字段；screenshot 保留为第一段的别名，兼容旧调用方
          segments: result.segments.map(segment => ({
            offset: segment.offset,
            height: segment.height,
            image: segment.image,
            format: effectiveFormat,
          })),
          screenshot: result.segments[0]?.image ?? '',
          isEnd: result.isEnd,
          nextOffset: result.nextOffset,
          pageHeight: result.pageHeight,
          queue: { active: captureSemaphore.activeCount, waiting: captureSemaphore.waitingCount },
          format: effectiveFormat,
          contentType: CONTENT_TYPES[effectiveFormat],
        },
        { headers: NO_STORE_HEADERS }
      )
    } finally {
      release()
      endRequest()
    }
  } catch (error) {
    const httpError = toHttpError(error)
    if (httpError.status >= 500) {
      console.error('Screenshot error:', error)
    }

    return Response.json(
      { success: false, error: httpError.message },
      { status: httpError.status, headers: NO_STORE_HEADERS }
    )
  }
}
