/**
 * POST /api/screenshot —— 截图接口。
 *
 * 这一层刻意做得很薄：只负责
 *   鉴权 → 限流 → 解析参数 → 过并发闸门 → 组装响应，
 * 真正"打开浏览器截图"的管线在 `@/services/capture`。
 *
 * 抽出去的原因有两个：
 *   1. Next.js 的 route 模块不允许导出非路由成员，而批量截图要复用同一条管线；
 *   2. 安全校验与重试策略只应有一份实现，复制一份迟早会走偏。
 */

import {
  buildScreenshotPayload,
  captureWithRetry,
  toHttpError,
} from '@/services/capture'
import { BoundedSemaphore, TokenBucketLimiter, getClientKey } from '@/utils/rate-limit'
import { createRateLimitBackend } from '@/utils/rate-limit-store'
import { endRequest, tryBeginRequest } from '@/utils/lifecycle'
import { HttpError, readJsonBody } from '@/utils/http-error'
import { isAuthorized } from '@/utils/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_CONCURRENT_CAPTURES = Number(process.env.MAX_CONCURRENT_CAPTURES) || 3
const MAX_QUEUE_LENGTH = Number(process.env.MAX_QUEUE_LENGTH) || 24
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS) || 45_000

// 每 IP 的令牌桶：容量 6 次突发，之后按 0.2 次/秒（12 次/分钟）补充
const RATE_LIMIT_CAPACITY = Number(process.env.RATE_LIMIT_CAPACITY) || 6
const RATE_LIMIT_REFILL_PER_SEC = Number(process.env.RATE_LIMIT_REFILL_PER_SEC) || 0.2

const captureSemaphore = new BoundedSemaphore(MAX_CONCURRENT_CAPTURES, MAX_QUEUE_LENGTH, QUEUE_TIMEOUT_MS)
// 限流后端：默认进程内；设置 REDIS_URL 后自动切换为跨副本共享的 Redis 后端
const ipLimiter = new TokenBucketLimiter(RATE_LIMIT_CAPACITY, RATE_LIMIT_REFILL_PER_SEC, createRateLimitBackend().backend)

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' }

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

    const body = (await readJsonBody(request)) as Record<string, unknown>

    // 参数解析（含 URL 安全校验）放在拉起浏览器之前，非法参数直接 400
    const { payload, effectiveFormat, contentType } = buildScreenshotPayload(body)

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
          contentType,
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
