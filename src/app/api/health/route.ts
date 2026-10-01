import { getBrowserStatus } from '@/services/browser'
import { getChromeStatus } from '@/utils/chrome'
import { createRateLimitBackend } from '@/utils/rate-limit-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 健康检查。
 * 只报进程自身的状态，不主动去拉起浏览器 —— 健康检查本身不应该产生副作用，
 * 否则探针会把机器上的 Chromium 一直保活。
 */
export async function GET() {
  const browser = getBrowserStatus()
  const chrome = await getChromeStatus()
  const { mode: rateLimitMode } = createRateLimitBackend()

  return Response.json(
    {
      status: 'ok',
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
        error: chrome.error,
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
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
