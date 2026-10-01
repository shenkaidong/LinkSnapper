/**
 * Chromium 实例管理。
 *
 * 原实现每个请求都 `puppeteer.launch()` 一次，请求结束就关掉。冷启动一个
 * Chromium 要 0.5～1.5 秒、几十 MB 内存，而分段截图意味着一页要重复这个
 * 过程 N 次 —— 代价完全花在了启动上，而不是截图本身。
 *
 * 这里改为进程内复用一个 Browser：
 *   - 页面（Page）仍然每个请求新建，用完即关，避免 cookie / 存储互相串。
 *   - Browser 常驻，空闲一段时间后自动回收，避免长期占着内存。
 *   - 进程退出时统一关闭，不留孤儿进程。
 */

import puppeteer, { Browser, Page } from 'puppeteer-core'
import { createRequire } from 'node:module'
import getChromePath from '@/utils/chrome'

const require = createRequire(import.meta.url)

/** 读入已安装的 puppeteer-core 主版本，用于决定 headless 的取值 */
function puppeteerMajor(): number {
  try {
    const pkg = require('puppeteer-core/package.json')
    return Number.parseInt(String(pkg.version).split('.')[0], 10) || 21
  } catch {
    return 21
  }
}

const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS) || 30_000
const IDLE_SHUTDOWN_MS = Number(process.env.BROWSER_IDLE_SHUTDOWN_MS) || 60_000

let sharedBrowser: Browser | null = null
let launching: Promise<Browser> | null = null
let idleTimer: NodeJS.Timeout | null = null
let activeUsers = 0

function launchArgs(): string[] {
  return [
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
    `--user-agent=${process.env.SCREENSHOT_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}`,
  ]
}

/**
 * 无头模式的取值。
 *
 * `headless: 'new'` 是 puppeteer 21 的写法，在 22+ 里已被移除（改回 `headless: true`）。
 * 做成环境变量 + 按已安装的 puppeteer-core 主版本自动兜底，是为了让
 * 「升级 puppeteer-core」不必同时改代码：升级到 22+ 时 'new' 会自动降级成 true，
 * 否则启动会直接报错。
 */
function resolveHeadlessMode(): 'new' | boolean {
  const raw = (process.env.HEADLESS_MODE || '').trim().toLowerCase()
  if (raw === 'true') return true
  if (raw === 'false') return false
  // 默认：puppeteer 21 用 'new'（新无头模式，渲染更准）；
  // 22+ 已移除该取值，回退到 true（同样是新无头模式）。
  return puppeteerMajor() >= 22 ? true : 'new'
}

async function launchBrowser(): Promise<Browser> {
  const executablePath = await getChromePath()

  const browser = await puppeteer.launch({
    executablePath,
    headless: resolveHeadlessMode(),
    args: launchArgs(),
    defaultViewport: {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
    },
    protocolTimeout: NAV_TIMEOUT_MS,
  })

  browser.on('disconnected', () => {
    if (sharedBrowser === browser) {
      sharedBrowser = null
    }
  })

  return browser
}

function cancelIdleShutdown(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function scheduleIdleShutdown(): void {
  cancelIdleShutdown()
  if (activeUsers > 0) return

  idleTimer = setTimeout(() => {
    void closeSharedBrowser()
  }, IDLE_SHUTDOWN_MS)
  idleTimer.unref?.()
}

async function acquireBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.connected) {
    return sharedBrowser
  }

  if (!launching) {
    launching = launchBrowser()
      .then(browser => {
        sharedBrowser = browser
        return browser
      })
      .finally(() => {
        launching = null
      })
  }

  return launching
}

/**
 * 借一个浏览器与一个全新页面，跑完 handler 后自动回收页面。
 * 业务代码不必关心复用与清理细节。
 */
export async function withPage<T>(handler: (page: Page, browser: Browser) => Promise<T>): Promise<T> {
  installShutdownHooks()
  const browser = await acquireBrowser()

  activeUsers++
  cancelIdleShutdown()

  let page: Page | null = null
  try {
    page = await browser.newPage()
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)
    page.setDefaultTimeout(NAV_TIMEOUT_MS)
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' })
    return await handler(page, browser)
  } finally {
    if (page) {
      await page.close().catch(() => {})
    }
    activeUsers--
    scheduleIdleShutdown()
  }
}

/** 关闭共享的浏览器实例。用于进程退出或测试收尾。 */
export async function closeSharedBrowser(): Promise<void> {
  cancelIdleShutdown()

  const browser = sharedBrowser
  sharedBrowser = null
  if (!browser) return

  await browser.close().catch(() => {})
}

// 进程退出时清理，避免留下孤儿 Chromium 进程
let hooksInstalled = false
export function installShutdownHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true

  const cleanup = () => {
    void closeSharedBrowser()
  }

  process.once('SIGTERM', cleanup)
  process.once('SIGINT', cleanup)
  process.once('beforeExit', cleanup)
}

/** 供 /api/health 之类的观测接口使用 */
export function getBrowserStatus(): { connected: boolean; activeUsers: number; idleShutdownMs: number } {
  return {
    connected: Boolean(sharedBrowser?.connected),
    activeUsers,
    idleShutdownMs: IDLE_SHUTDOWN_MS,
  }
}
