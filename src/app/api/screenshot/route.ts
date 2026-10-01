import puppeteer, { Browser, Page } from 'puppeteer-core'
import getChromePath from '@/utils/chrome'
import { assertSafeUrl } from '@/utils/url-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000
const NAV_TIMEOUT_MS = 30000
const PRELOAD_MAX_MS = 15000
const SETTLE_MAX_MS = 6000
const MAX_OFFSET = 500_000
const MAX_CONCURRENT_BROWSERS = 3

type WebsiteType = 'dynamic' | 'static' | 'spa'

interface ScreenshotPayload {
  url: string
  fullPage?: boolean
  singleShot?: boolean
  offset?: number
}

interface ScreenshotResult {
  screenshot: string
  isEnd: boolean
  nextOffset: number
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * 浏览器实例很吃内存，这里做一层进程内并发闸门，防止并发请求把机器打爆。
 * 注意这是进程内的，多实例部署时每个实例各限各的。
 */
let activeBrowsers = 0
const waitingForSlot: Array<() => void> = []

async function acquireBrowserSlot(): Promise<() => void> {
  while (activeBrowsers >= MAX_CONCURRENT_BROWSERS) {
    await new Promise<void>(resolve => waitingForSlot.push(resolve))
  }
  activeBrowsers++

  let released = false
  return () => {
    if (released) return
    released = true
    activeBrowsers--
    waitingForSlot.shift()?.()
  }
}

/** 已知的动态加载站点，走更长的等待策略 */
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

/**
 * 判断一次失败是否值得重试。
 * 域名不存在、地址非法、被浏览器直接拒绝这类错误重试多少次结果都一样，
 * 而超时、连接被重置这类则往往是瞬时的，值得重试。
 */
function isRetryable(error: unknown): boolean {
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

async function detectWebsiteType(page: Page, url: string): Promise<WebsiteType> {
  if (KNOWN_DYNAMIC_SITES.some(site => url.includes(site))) {
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
 * 原实现用 while(true)，遇到无限滚动站点会一直转下去，这里加了时间上限。
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

async function launchBrowser(): Promise<Browser> {
  const executablePath = await getChromePath()

  return puppeteer.launch({
    executablePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1920,1080',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad',
      '--disable-component-extensions-with-background-pages',
      '--disable-extensions',
      '--disable-ipc-flooding-protection',
      '--disable-renderer-backgrounding',
      // 只允许出现一次 --disable-features，重复出现时后一个的值会覆盖前一个。
      // 同时刻意移除了 --disable-web-security：它会关闭同源策略，
      // 配合「任意 URL 都能访问」的截图能力，等于把 SSRF 放大。
      '--disable-features=TranslateUI',
      '--enable-features=NetworkService,NetworkServiceInProcess',
      '--force-color-profile=srgb',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-pings',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ],
    defaultViewport: {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
    },
    protocolTimeout: NAV_TIMEOUT_MS,
  })
}

async function captureOnce(payload: ScreenshotPayload, target: URL): Promise<ScreenshotResult> {
  const release = await acquireBrowserSlot()
  let browser: Browser | null = null

  try {
    browser = await launchBrowser()
    const page = await browser.newPage()

    await page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)
    await page.setDefaultTimeout(NAV_TIMEOUT_MS)
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'zh-CN,zh;q=0.9',
    })

    await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })

    const websiteType = await detectWebsiteType(page, target.toString())
    await settlePage(page, websiteType)

    // ---- 整页截图 ----
    if (payload.fullPage) {
      if (websiteType !== 'static') {
        await preloadLazyContent(page)
        await waitForDynamicContent(page)
      }

      const screenshot = await page.screenshot({
        fullPage: true,
        type: 'png',
        optimizeForSpeed: true,
        encoding: 'base64',
      })

      return { screenshot: screenshot as string, isEnd: true, nextOffset: 0 }
    }

    // ---- 普通单次截图 ----
    if (payload.singleShot) {
      const screenshot = await page.screenshot({
        fullPage: false,
        type: 'png',
        optimizeForSpeed: true,
        encoding: 'base64',
      })

      return { screenshot: screenshot as string, isEnd: true, nextOffset: 0 }
    }

    // ---- 分段截图 ----
    // 滚动位置由前端通过 offset 传入，服务端不再保存任何会话状态，
    // 这样多实例部署、重启、并发请求都不会互相污染。
    const offset = normalizeOffset(payload.offset)

    if (websiteType !== 'static') {
      await preloadLazyContent(page)
    }

    const { pageHeight, viewportWidth, viewportHeight } = await measurePage(page)

    if (offset >= pageHeight) {
      return { screenshot: '', isEnd: true, nextOffset: offset }
    }

    // 最后一段按剩余高度裁剪，避免 clip 越出页面边界导致截图报错
    const height = Math.max(1, Math.min(viewportHeight, pageHeight - offset))

    const screenshot = await page.screenshot({
      fullPage: false,
      type: 'png',
      optimizeForSpeed: true,
      encoding: 'base64',
      clip: {
        x: 0,
        y: offset,
        width: Math.max(1, viewportWidth),
        height,
      },
    })

    const nextOffset = offset + height
    return {
      screenshot: screenshot as string,
      isEnd: nextOffset >= pageHeight,
      nextOffset,
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {})
    }
    release()
  }
}

/** 统一重试入口：保证每次重试都带上完整参数（原实现在递归时漏传了 singleShot） */
async function captureWithRetry(payload: ScreenshotPayload, target: URL): Promise<ScreenshotResult> {
  let lastError: unknown

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await captureOnce(payload, target)
    } catch (error) {
      lastError = error
      // 域名解析失败、无效地址这类属于确定性错误，重试只会白白拖长响应时间
      if (!isRetryable(error) || attempt === MAX_RETRIES) break

      console.warn(`截图失败，正在重试 (${attempt + 1}/${MAX_RETRIES})：`, error)
      await sleep(RETRY_DELAY_MS)
    }
  }

  throw lastError instanceof Error ? lastError : new Error('截图失败，请稍后重试')
}

export async function POST(request: Request) {
  let body: ScreenshotPayload

  try {
    body = await request.json()
  } catch {
    return Response.json({ success: false, error: '请求体不是合法的 JSON' }, { status: 400 })
  }

  try {
    const target = assertSafeUrl(body?.url)
    const payload: ScreenshotPayload = {
      url: target.toString(),
      fullPage: Boolean(body.fullPage),
      singleShot: Boolean(body.singleShot),
      offset: normalizeOffset(body.offset),
    }

    const result = await captureWithRetry(payload, target)

    return Response.json({
      success: true,
      screenshot: result.screenshot,
      isEnd: result.isEnd,
      nextOffset: result.nextOffset,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '截图失败，请稍后重试'
    console.error('Screenshot error:', error)
    return Response.json({ success: false, error: message }, { status: 400 })
  }
}
