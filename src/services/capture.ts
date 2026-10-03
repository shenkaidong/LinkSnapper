/**
 * 截图管线。
 *
 * 原先这些逻辑都写在 `src/app/api/screenshot/route.ts` 里，但 Next.js 的
 * route 模块**不允许导出非路由成员**（会触发路由类型生成报错），而批量截图
 * 与将来的异步任务模式都必须复用同一条管线（同样的安全校验、同样的重试策略）。
 *
 * 与其复制一份，不如把管线抽出来：路由层只负责
 * 「鉴权 → 限流 → 解析参数 → 过并发闸门 → 组装响应」，
 * 真正"打开浏览器截图"的部分集中在这里。
 */

import { ElementHandle, Page } from 'puppeteer-core'
import sharp from 'sharp'
import { withPage } from '@/services/browser'
import {
  CONTENT_TYPES,
  buildHideCss,
  encodeImage,
  ImageFormat,
  parseBlockFlag,
  parseClip,
  parseDarkMode,
  parseFormat,
  parseHideSelectors,
  parseInjectCss,
  parseInjectJs,
  parseQuality,
  parseSelector,
  parseWaitForSelector,
  parseWaitForTimeout,
  resolveViewport,
  ViewportSpec,
} from '@/utils/screenshot-params'
import { COOKIE_BANNER_SELECTORS, hideRules, isAdRequest } from '@/utils/page-decoration'
import {
  assertSafeUrl,
  isBlockedHostname,
  isHostnameResolvingToPrivate,
  isPrivateNetworkAllowed,
  SAFE_INTERNAL_PROTOCOLS,
} from '@/utils/url-guard'
import { HttpError } from '@/utils/http-error'

export const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 2
const RETRY_DELAY_MS = 1200
export const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS) || 30_000
const PRELOAD_MAX_MS = 12_000
const SETTLE_MAX_MS = 6_000
const MAX_OFFSET = 500_000

/** 整页截图与分段截图的高度上限。一条 1920x30000 的 PNG base64 后约 30MB。 */
export const MAX_FULLPAGE_HEIGHT = Number(process.env.MAX_FULLPAGE_HEIGHT) || 30_000

/** 单次请求最多返回几段（一次返回太多段会让响应体膨胀、前端渲染卡顿） */
export const DEFAULT_MAX_SEGMENTS = 6
export const MAX_SEGMENTS_PER_REQUEST = 12

export type WebsiteType = 'dynamic' | 'static' | 'spa'

export interface ScreenshotPayload {
  url: string
  fullPage?: boolean
  singleShot?: boolean
  offset?: number
  maxSegments?: number
  selector?: string | null
  clip?: { x: number; y: number; width: number; height: number } | null
  format: ImageFormat
  quality: number
  /** 视口 / 设备模拟；null 表示用浏览器默认（1920x1080） */
  viewport?: ViewportSpec | null
  /** 暗色模式（prefers-color-scheme: dark） */
  darkMode?: boolean
  /** 拦截广告与统计追踪请求 */
  blockAds?: boolean
  /** 隐藏 Cookie 同意横幅 */
  blockCookieBanners?: boolean
  /** 额外要隐藏的元素选择器 */
  hideSelectors?: string[]
  /** 额外注入的 CSS */
  css?: string | null
  /** 页面加载后执行的 JS */
  js?: string | null
  /** 截图前等待该选择器出现 */
  waitForSelector?: string | null
  /** 额外等待毫秒数 */
  waitForTimeout?: number
}

export interface CapturedSegment {
  offset: number
  height: number
  image: string
}

export interface CaptureOutcome {
  segments: CapturedSegment[]
  isEnd: boolean
  nextOffset: number
  pageHeight: number
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 已知的动态加载站点，走更长的等待策略。按主机名后缀匹配，不能用 includes。 */
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

/** 判断一次失败是否值得重试：确定性错误重试多少次结果都一样 */
function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status >= 500

  const message = error instanceof Error ? error.message : String(error ?? '')
  if (message.includes('ERR_NAME_NOT_RESOLVED') || message.includes('ENOTFOUND')) return false
  if (message.includes('net::ERR_INVALID_URL')) return false
  if (message.includes('Execution context was destroyed')) return true
  if (message.includes('Navigation timeout') || message.includes('Timeout')) return true
  return true
}

/** 把底层异常翻译成对调用方有意义的 HTTP 错误 */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error

  const message = error instanceof Error ? error.message : String(error ?? '')

  if (message.includes('ERR_NAME_NOT_RESOLVED') || message.includes('ENOTFOUND')) {
    return new HttpError(502, '域名无法解析，请检查网址是否正确')
  }
  if (message.includes('Navigation timeout') || message.includes('Timeout')) {
    return new HttpError(504, '页面加载超时，请稍后重试')
  }
  if (message.includes('net::ERR_INVALID_URL')) {
    return new HttpError(400, '网址格式不正确')
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
    // 部署/配置缺失，不是内部 bug：503 比 500 准确，并把安装命令透传给调用方
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
 * 只校验用户填进来的那个 URL 是拦不住 SSRF 的：页面可以 302 跳到内网；
 * 页面里的 img / script / fetch 也能打到内网；域名合法但 DNS 指向 127.0.0.1。
 * 所以必须在浏览器真正发出请求的那一刻逐个校验。
 */
async function installRequestGuard(page: Page, state: GuardState, blockAds = false): Promise<void> {
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

        // 广告拦截放在安全校验之后、放行之前：保证"该拦的一定被拦"，
        // 不会因为广告规则先命中就漏掉内网请求。
        if (blockAds && isAdRequest(request.url())) {
          await request.abort('blockedbyclient')
          return
        }

        if (!isPrivateNetworkAllowed()) {
          if (isBlockedHostname(parsed.hostname)) {
            state.blockedUrl = request.url()
            await request.abort('blockedbyclient')
            return
          }
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
    .evaluate(
      () =>
        typeof window.history.pushState === 'function' &&
        !!document.querySelector('div[id="app"], div[id="root"], div[id="__next"]')
    )
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

/** 预加载懒加载内容：滚到底再回顶部。加时间上限，避免无限滚动站点死循环。 */
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

          if (y === lastY) break
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

  // 注意：不能再用 page.waitForTimeout，该 API 在 puppeteer 22 中已被移除
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
      width,
      height,
    },
  })

  return image as string
}

/**
 * 导航**之前**就要生效的选项：视口尺寸与暗色模式。
 * 必须早于 page.goto —— 页面加载时就会读取视口与 prefers-color-scheme，
 * 等加载完再改，响应式断点和暗色样式都已经按旧值渲染完毕了。
 */
async function applyPreNavigationOptions(page: Page, payload: ScreenshotPayload): Promise<void> {
  if (payload.viewport) {
    await page.setViewport(payload.viewport)
  }

  // 暗色模式必须**无条件**模拟，而不是"只在 darkMode=true 时模拟 dark"。
  // 否则 prefers-color-scheme 取的是宿主 OS 的主题：开发者在深色模式的 macOS 上
  // 测出来是暗色，同样的请求部署到 Linux 容器里却是亮色 —— 同一个 URL、
  // 同一份参数，产出两张不同的图。截图服务的输出必须只由参数决定，
  // 不能由服务器的系统设置决定。
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: payload.darkMode ? 'dark' : 'light' },
  ])
}

/**
 * 导航**之后**才生效的选项：等待选择器、注入 CSS/JS、隐藏元素、额外延时。
 * 顺序有讲究：先等目标元素出现，再注入修饰，最后才按 waitForTimeout 让页面消化。
 */
async function applyPostNavigationOptions(page: Page, payload: ScreenshotPayload): Promise<void> {
  if (payload.waitForSelector) {
    try {
      await page.waitForSelector(payload.waitForSelector, { timeout: NAV_TIMEOUT_MS })
    } catch {
      throw new HttpError(504, `等待选择器 "${payload.waitForSelector}" 超时（${NAV_TIMEOUT_MS}ms）`)
    }
  }

  const cssParts: string[] = []
  if (payload.blockCookieBanners) cssParts.push(hideRules(COOKIE_BANNER_SELECTORS))
  const hideCss = buildHideCss(payload.hideSelectors ?? [])
  if (hideCss) cssParts.push(hideCss)
  if (payload.css) cssParts.push(payload.css)

  if (cssParts.length > 0) {
    await page.addStyleTag({ content: cssParts.join('\n') }).catch(() => {})
  }

  if (payload.js) {
    // 注入脚本失败不能让整个截图失败 —— 页面本身可能已经截得到
    await page.evaluate(payload.js).catch(() => {})
  }

  if (payload.waitForTimeout && payload.waitForTimeout > 0) {
    await new Promise(resolve => setTimeout(resolve, payload.waitForTimeout))
  }
}

async function captureOnce(payload: ScreenshotPayload): Promise<CaptureOutcome> {
  const target = new URL(payload.url)
  const guard: GuardState = { blockedUrl: null }

  return withPage(async page => {
    await installRequestGuard(page, guard, Boolean(payload.blockAds))
    await applyPreNavigationOptions(page, payload)

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
    await applyPostNavigationOptions(page, payload)

    // ---- PDF 输出 ----
    // PDF 是整份文档的输出，与"截某个元素/某个区域"语义冲突，
    // 因此优先级最前，selector / clip 会被忽略。
    if (payload.format === 'pdf') {
      const pdf = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }))
      return {
        segments: [{ offset: 0, height: 0, image: pdf.toString('base64') }],
        isEnd: true,
        nextOffset: 0,
        pageHeight: 0,
      }
    }

    // ---- 元素级截图 ----
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
    const offset = normalizeOffset(payload.offset)
    const maxSegments = normalizeMaxSegments(payload.maxSegments)

    if (websiteType !== 'static') {
      await preloadLazyContent(page)
    }

    const { pageHeight, viewportWidth, viewportHeight } = await measurePage(page)

    if (offset >= pageHeight) {
      return { segments: [], isEnd: true, nextOffset: offset, pageHeight }
    }

    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {})

    const segments: CapturedSegment[] = []
    let cursor = offset

    while (segments.length < maxSegments && cursor < pageHeight) {
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

/** 统一重试入口：保证每次重试都带上完整参数 */
export async function captureWithRetry(payload: ScreenshotPayload): Promise<CaptureOutcome> {
  let lastError: unknown

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await captureOnce(payload)
    } catch (error) {
      lastError = error
      if (!isRetryable(error) || attempt === MAX_RETRIES) break

      console.warn(`截图失败，正在重试 (${attempt + 1}/${MAX_RETRIES})：`, error)
      await sleep(RETRY_DELAY_MS)
    }
  }

  throw lastError
}

// ---------------------------------------------------------------------------
// 请求体解析（单张与批量共用同一套校验，避免出现两套规则）
// ---------------------------------------------------------------------------

export interface BuiltPayload {
  payload: ScreenshotPayload
  /** 实际生效的输出格式（分段模式恒为 png） */
  effectiveFormat: ImageFormat
  contentType: string
}

/**
 * 把外部请求体解析成管线参数。
 *
 * 所有解析都在这里完成而不是在 captureOnce 里，是为了让非法参数尽早以 400 失败，
 * 不必先拉起 Chromium（省一次昂贵的浏览器启动）。
 */
export function buildScreenshotPayload(raw: Record<string, unknown>): BuiltPayload {
  let target: URL
  try {
    target = assertSafeUrl(raw.url)
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'url 参数不合法')
  }

  const format = parseFormat(raw.format)
  const quality = parseQuality(raw.quality, format)
  const selector = parseSelector(raw.selector)
  const clip = parseClip(raw.clip)

  const viewport = resolveViewport({
    device: raw.device,
    width: raw.width,
    height: raw.height,
    deviceScaleFactor: raw.deviceScaleFactor,
  })
  const darkMode = parseDarkMode(raw.darkMode)
  const blockAds = parseBlockFlag(raw.blockAds)
  const blockCookieBanners = parseBlockFlag(raw.blockCookieBanners)
  const hideSelectors = parseHideSelectors(raw.hideSelectors)
  const css = parseInjectCss(raw.css)
  const js = parseInjectJs(raw.js)
  const waitForSelector = parseWaitForSelector(raw.waitForSelector)
  const waitForTimeout = parseWaitForTimeout(raw.waitForTimeout)

  // 优先级：pdf > selector > clip > fullPage > singleShot > 分段
  const isPdf = format === 'pdf'
  const fullPage = Boolean(raw.fullPage) && !selector && !clip && !isPdf
  const singleShot = Boolean(raw.singleShot) && !selector && !clip && !fullPage && !isPdf

  const effectiveFormat = isPdf || selector || clip || fullPage || singleShot ? format : 'png'

  return {
    payload: {
      url: target.toString(),
      fullPage,
      singleShot,
      offset: normalizeOffset(raw.offset),
      maxSegments: normalizeMaxSegments(
        raw.maxSegments ?? (singleShot || fullPage ? 1 : DEFAULT_MAX_SEGMENTS)
      ),
      selector,
      clip,
      format: effectiveFormat,
      quality,
      viewport,
      darkMode,
      blockAds,
      blockCookieBanners,
      hideSelectors,
      css,
      js,
      waitForSelector,
      waitForTimeout,
    },
    effectiveFormat,
    contentType: CONTENT_TYPES[effectiveFormat],
  }
}
