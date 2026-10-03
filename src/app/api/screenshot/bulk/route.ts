/**
 * POST /api/screenshot/bulk —— 批量截图。
 *
 * 竞品普遍提供"一次调用截多个 URL"（ScreenshotInk 支持一次 20 个）。
 * 价值不只是省几次 HTTP 往返：批量审计竞品页面、整站巡检这类场景里，
 * 调用方根本不想自己写并发控制与错误聚合。
 *
 * 设计取舍：
 *   - **单个失败不影响整批**。这是批量接口的核心语义 —— 20 个里挂 1 个
 *     就返回 500 的话，调用方还得自己重试，这个接口就没意义了。
 *     所以 HTTP 状态只在"请求本身不合法"时才非 200。
 *   - **并发刻意压低**（默认 2）。每个截图都要占一个 Chromium，
 *     20 个一起上会把内存打满，反而全部超时。
 *   - **限流按张数计费**，否则批量接口就是白送的限流绕过通道。
 *   - 安全校验与单张完全相同（复用 buildScreenshotPayload），
 *     不存在"批量模式下校验更松"这回事。
 */

import { buildScreenshotPayload, captureWithRetry, toHttpError } from '@/services/capture'
import { BoundedSemaphore, TokenBucketLimiter, getClientKey } from '@/utils/rate-limit'
import { createRateLimitBackend } from '@/utils/rate-limit-store'
import { endRequest, tryBeginRequest } from '@/utils/lifecycle'
import { HttpError, readJsonBody } from '@/utils/http-error'
import { isAuthorized } from '@/utils/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_URLS_PER_BATCH = 20
const MAX_CONCURRENT_CAPTURES = Number(process.env.MAX_CONCURRENT_CAPTURES) || 3
const MAX_QUEUE_LENGTH = Number(process.env.MAX_QUEUE_LENGTH) || 24
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS) || 45_000

const RATE_LIMIT_CAPACITY = Number(process.env.RATE_LIMIT_CAPACITY) || 6
const RATE_LIMIT_REFILL_PER_SEC = Number(process.env.RATE_LIMIT_REFILL_PER_SEC) || 0.2

const captureSemaphore = new BoundedSemaphore(MAX_CONCURRENT_CAPTURES, MAX_QUEUE_LENGTH, QUEUE_TIMEOUT_MS)
const ipLimiter = new TokenBucketLimiter(RATE_LIMIT_CAPACITY, RATE_LIMIT_REFILL_PER_SEC, createRateLimitBackend().backend)

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' }

function parseUrls(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'urls 必须是数组')
  if (value.length === 0) throw new HttpError(400, 'urls 不能为空')
  if (value.length > MAX_URLS_PER_BATCH) {
    throw new HttpError(400, `单次最多批量截取 ${MAX_URLS_PER_BATCH} 个地址，当前 ${value.length} 个`)
  }

  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new HttpError(400, `urls[${index}] 必须是非空字符串`)
    }
    return item
  })
}

function parseConcurrency(value: unknown): number {
  if (value === undefined || value === null || value === '') return 2
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) throw new HttpError(400, 'concurrency 必须是正整数')
  return Math.min(4, Math.trunc(n))
}

/** 受控并发：一次最多跑 limit 个，避免同时拉起十几个 Chromium */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })

  await Promise.all(runners)
  return results
}

export async function POST(request: Request) {
  try {
    if (!isAuthorized(request)) {
      throw new HttpError(401, '缺少或错误的访问令牌')
    }

    const body = (await readJsonBody(request)) as Record<string, unknown>
    const urls = parseUrls(body.urls)
    const concurrency = parseConcurrency(body.concurrency)

    // 按张数扣额度：批量接口不能成为绕过限流的后门
    const clientKey = getClientKey(request)
    for (let i = 0; i < urls.length; i++) {
      const quota = await ipLimiter.take(clientKey)
      if (!quota.allowed) {
        return Response.json(
          { success: false, error: `请求过于频繁：批量截取 ${urls.length} 张需要同等额度，请稍后再试` },
          { status: 429, headers: { ...NO_STORE_HEADERS, 'Retry-After': String(quota.retryAfterSec) } }
        )
      }
    }

    if (!tryBeginRequest()) {
      throw new HttpError(503, '实例正在停机排空，不再接收新的截图任务')
    }

    // 单张的公共参数（去掉批量专属字段），逐张与 url 合并后复用同一套校验
    const shared = { ...body }
    delete shared.urls
    delete shared.concurrency

    const startedAt = Date.now()

    const results = await mapWithConcurrency(urls, concurrency, async url => {
      try {
        const { payload, effectiveFormat, contentType } = buildScreenshotPayload({ ...shared, url })
        const release = await captureSemaphore.acquire()
        let outcome
        try {
          outcome = await captureWithRetry(payload)
        } finally {
          release()
        }

        return {
          url,
          success: true as const,
          segments: outcome.segments.map(segment => ({
            offset: segment.offset,
            height: segment.height,
            image: segment.image,
            format: effectiveFormat,
          })),
          screenshot: outcome.segments[0]?.image ?? '',
          isEnd: outcome.isEnd,
          pageHeight: outcome.pageHeight,
          format: effectiveFormat,
          contentType,
        }
      } catch (error) {
        const httpError = toHttpError(error)
        return { url, success: false as const, error: httpError.message }
      }
    })

    const succeeded = results.filter(r => r.success).length

    return Response.json(
      {
        success: true,
        total: urls.length,
        succeeded,
        failed: urls.length - succeeded,
        elapsedMs: Date.now() - startedAt,
        results,
      },
      { headers: NO_STORE_HEADERS }
    )
  } catch (error) {
    const httpError = toHttpError(error)
    if (httpError.status >= 500) {
      console.error('Bulk screenshot error:', error)
    }
    return Response.json(
      { success: false, error: httpError.message },
      { status: httpError.status, headers: NO_STORE_HEADERS }
    )
  } finally {
    endRequest()
  }
}
