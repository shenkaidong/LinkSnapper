/**
 * 视觉变更监控两条接口的公共外壳。
 *
 * 鉴权 → 限流 → 停机排空 → 并发闸门 这四件事与截图接口完全一致，
 * 复制一份迟早会漏配。所以抽出来，让两个路由只写各自的业务。
 *
 * 这里刻意复用 `captureSemaphore` 的实例而不是各建一个：Next.js 每个 route
 * 模块独立求值，各建一个等于把「最多 3 个 Chromium」放大成「接口数 × 3」。
 */

import { buildScreenshotPayload, captureSemaphore, captureWithRetry, toHttpError } from '@/services/capture'
import { TokenBucketLimiter, getClientKey } from '@/utils/rate-limit'
import { createRateLimitBackend } from '@/utils/rate-limit-store'
import { endRequest, tryBeginRequest } from '@/utils/lifecycle'
import { HttpError } from '@/utils/http-error'
import { isAuthorized } from '@/utils/auth'

const RATE_LIMIT_CAPACITY = Number(process.env.RATE_LIMIT_CAPACITY) || 6
const RATE_LIMIT_REFILL_PER_SEC = Number(process.env.RATE_LIMIT_REFILL_PER_SEC) || 0.2

const ipLimiter = new TokenBucketLimiter(RATE_LIMIT_CAPACITY, RATE_LIMIT_REFILL_PER_SEC, createRateLimitBackend().backend)

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' }

export interface ScreenshotJob {
  /** 已完成的截图参数（基准图恒为 png，比对才有意义） */
  payload: ReturnType<typeof buildScreenshotPayload>['payload']
  /** 释放并发闸门 */
  release: () => void
  /** 原始请求体：key / threshold 这类非截图参数只在这里拿得到 */
  body: Record<string, unknown>
}

/**
 * 走完整的守卫后，交出「已经替我截好一张图」的工作机会。
 * work 抛出的异常会被翻译成 HTTP 语义，>=500 才记账打日志。
 */
export async function runSnapshotJob(request: Request, work: (job: ScreenshotJob) => Promise<unknown>): Promise<Response> {
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

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, '请求体必须是 JSON 对象')
    }

    if (!tryBeginRequest()) {
      throw new HttpError(503, '实例正在停机排空，不再接收新的任务')
    }

    const { payload } = buildScreenshotPayload(body)
    // 基准图与比对图必须是 png：jpeg 的有损压缩会让「没变」也报出几个百分点的差异，
    // 而且 sharp 的 flatten / removeAlpha 在 png 上才是确定性的。
    payload.format = 'png'

    const release = await captureSemaphore.acquire()
    try {
      const result = await work({ payload, release, body })
      return Response.json(result, { headers: NO_STORE_HEADERS })
    } finally {
      release()
    }
  } catch (error) {
    const httpError = toHttpError(error)
    if (httpError.status >= 500) {
      console.error('Snapshot job error:', error)
    }
    return Response.json(
      { success: false, error: httpError.message },
      { status: httpError.status, headers: NO_STORE_HEADERS }
    )
  } finally {
    endRequest()
  }
}

/** 跑一次截图并返回 PNG Buffer。调用方必须自己释放闸门。 */
export async function capturePng(payload: ScreenshotJob['payload']): Promise<Buffer> {
  const outcome = await captureWithRetry(payload)
  const first = outcome.segments[0]
  if (!first?.image) {
    throw new HttpError(502, '截图结果为空')
  }
  return Buffer.from(first.image, 'base64')
}
