import { getBrowserStatus } from '@/services/browser'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 健康检查。
 * 只报进程自身的状态，不主动去拉起浏览器 —— 健康检查本身不应该产生副作用，
 * 否则探针会把机器上的 Chromium 一直保活。
 */
export async function GET() {
  const browser = getBrowserStatus()

  return Response.json(
    {
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      browser: {
        connected: browser.connected,
        activeUsers: browser.activeUsers,
        idleShutdownMs: browser.idleShutdownMs,
      },
      guards: {
        privateNetworkBlocked: process.env.ALLOW_PRIVATE_NETWORK !== 'true',
        tokenRequired: Boolean(process.env.SCREENSHOT_API_TOKEN),
        allowedInternalHosts: (process.env.ALLOWED_INTERNAL_HOSTS || '')
          .split(',')
          .map(item => item.trim())
          .filter(Boolean),
      },
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
