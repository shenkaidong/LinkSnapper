import { getBrowserStatus } from '@/services/browser'
import { getChromeStatus } from '@/utils/chrome'
import { inFlightCount, isShuttingDown } from '@/utils/lifecycle'
import { createRateLimitBackend } from '@/utils/rate-limit-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 健康检查（同时承担就绪探针的职责）。
 *
 * 只报进程自身的状态，不主动去拉起浏览器 —— 健康检查本身不应该产生副作用，
 * 否则探针会把机器上的 Chromium 一直保活。
 *
 * 关键点是**状态码**：之前无论 chrome.ready 是什么都返回 200，编排系统会
 * 因此把流量继续打到一个 Chrome 已坏、注定 503 的实例上。现在不可用时返回
 * 503，让 K8s / Docker 的就绪探针把本实例摘出流量。
 */
export async function GET() {
  const browser = getBrowserStatus()
  const chrome = await getChromeStatus()
  const { mode: rateLimitMode } = createRateLimitBackend()

  const shuttingDown = isShuttingDown()
  // Chrome 不可用时默认判定为「未就绪」。少数部署里 Chrome 是延迟挂载的，
  // 可以用 HEALTH_REQUIRE_CHROME=false 关掉这一项，只做进程存活检查。
  const requireChrome = process.env.HEALTH_REQUIRE_CHROME !== 'false'
  const ready = !shuttingDown && (!requireChrome || chrome.ready)

  const body = {
    status: shuttingDown ? 'shutting-down' : ready ? 'ok' : 'degraded',
    ready,
    uptimeSec: Math.round(process.uptime()),
    browser: {
      connected: browser.connected,
      activeUsers: browser.activeUsers,
      idleShutdownMs: browser.idleShutdownMs,
    },
    // Chrome 就绪状态对编排系统很关键：没装 / 版本错位时应为 false，
    // 探针据此把本实例摘出流量，而不是等首请求才 503。
    chrome: {
      ready: chrome.ready,
      path: chrome.path,
      expectedVersion: chrome.expectedVersion,
      actualVersion: chrome.actualVersion,
      // 已设置但指向不存在的环境变量（CHROME_PATH 写错等）。非空说明显式配置
      // 被忽略了、实际用的是回退到的浏览器，属于需要修的配置问题。
      invalidEnvPaths: chrome.invalidEnvPaths,
      error: chrome.error,
    },
    lifecycle: {
      shuttingDown,
      inFlight: inFlightCount(),
    },
    guards: {
      privateNetworkBlocked: process.env.ALLOW_PRIVATE_NETWORK !== 'true',
      tokenRequired: Boolean(process.env.SCREENSHOT_API_TOKEN),
      allowedInternalHosts: (process.env.ALLOWED_INTERNAL_HOSTS || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean),
    },
    limits: {
      // 限流后端：memory 表示单实例；redis 表示多副本共享（需设置 REDIS_URL）。
      // 注意并发闸门（Chromium 占用数）始终是每实例的，多副本部署时
      // MAX_CONCURRENT_CAPTURES 指的是「每副本」上限。
      rateLimitMode,
      maxConcurrentCaptures: Number(process.env.MAX_CONCURRENT_CAPTURES) || 3,
    },
  }

  return Response.json(body, {
    status: ready ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  })
}
