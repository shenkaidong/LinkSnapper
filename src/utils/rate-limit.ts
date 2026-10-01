/**
 * 轻量限流与并发闸门。
 *
 * 截图接口的成本极高：每个请求都要拉起一个真实的 Chromium 并加载外部页面，
 * 内存与 CPU 开销都在百 MB / 秒级。公网部署时如果不限流，几个人同时刷就能
 * 把机器打满，而且这类接口天然会被爬虫盯上。
 *
 * 令牌桶状态默认存在进程内（单实例够用）；多实例部署时由 RateLimitBackend
 * 切换到 Redis，所有副本共享同一份令牌桶，否则额度会被放大 N 倍。
 */

import type { RateLimitBackend } from './rate-limit-store.ts'
import { InMemoryBackend } from './rate-limit-store.ts'

/** 令牌桶：按 key（一般是客户端 IP）限速，支持突发 */
export class TokenBucketLimiter {
  private readonly backend: RateLimitBackend

  /**
   * @param capacity 突发容量（令牌数）
   * @param refillPerSecond 每秒补充速率
   * @param backend 状态后端，默认进程内 Map；多实例部署传 RedisBackend
   */
  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    backend?: RateLimitBackend
  ) {
    this.backend = backend ?? new InMemoryBackend()
  }

  /**
   * 尝试取走一个令牌（异步：Redis 后端需要网络往返）。
   * @returns allowed 是否放行；retryAfterSec 被拒时建议的等待秒数
   */
  async take(key: string): Promise<{ allowed: boolean; retryAfterSec: number; remaining: number }> {
    const now = Date.now()
    // 桶的生存时间 = 回满所需时长 + 1s 余量，过期后由后端自动回收
    const ttlMs = Math.ceil((this.capacity / this.refillPerSecond) * 1000) + 1000

    const state = await this.backend.apply(key, this.capacity, this.refillPerSecond, 1, now, ttlMs)

    if (state.tokens >= 0) {
      return { allowed: true, retryAfterSec: 0, remaining: Math.floor(state.tokens) }
    }

    const deficit = -state.tokens
    // refillPerSecond 为 0 表示「不补充」（测试或一次性配额），给一个兜底等待值避免 Infinity
    const retryAfterSec =
      this.refillPerSecond > 0 ? Math.max(1, Math.ceil(deficit / this.refillPerSecond)) : 3600
    return { allowed: false, retryAfterSec, remaining: 0 }
  }
}

export class QueueFullError extends Error {
  constructor(message = '当前排队请求过多，请稍后再试') {
    super(message)
    this.name = 'QueueFullError'
  }
}

export class QueueTimeoutError extends Error {
  constructor(message = '等待截图资源超时，请稍后再试') {
    super(message)
    this.name = 'QueueTimeoutError'
  }
}

/**
 * 有界并发闸门。
 *
 * 相比原来那个只数数量的写法，这里补了两件必须做的事：
 *   1. 排队长度有上限 —— 否则请求会无限堆积，每个都是活着的连接与内存。
 *   2. 排队有超时 —— 否则请求会一直挂到客户端自己放弃，服务端却还以为在等。
 */
export class BoundedSemaphore {
  private active = 0
  private readonly waiting: Array<{ resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = []

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
    private readonly queueTimeoutMs: number
  ) {}

  get activeCount(): number {
    return this.active
  }

  get waitingCount(): number {
    return this.waiting.length
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active++
      return this.buildRelease()
    }

    if (this.waiting.length >= this.maxQueue) {
      throw new QueueFullError()
    }

    return new Promise<() => void>((resolve, reject) => {
      const entry = {
        resolve: () => {
          clearTimeout(entry.timer)
          this.active++
          resolve(this.buildRelease())
        },
        reject: (error: Error) => {
          clearTimeout(entry.timer)
          reject(error)
        },
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(entry)
          if (index >= 0) this.waiting.splice(index, 1)
          reject(new QueueTimeoutError())
        }, this.queueTimeoutMs),
      }

      // 注意这里刻意不 unref：这个超时回调必须真的触发。
      // 一旦 unref，当事件循环上没有其它待处理任务时进程会直接退出，
      // 排队中的请求就永远等不到结果（在测试里表现为
      // "Promise resolution is still pending but the event loop has already resolved"）。
      this.waiting.push(entry)
    })
  }

  private buildRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--

      const next = this.waiting.shift()
      if (next) next.resolve()
    }
  }
}

/**
 * 从请求头里取客户端标识，用于限流分组。
 *
 * 注意：x-forwarded-for 是客户端可伪造的。只有在受信任的反向代理后面
 * （由代理覆写该头）才可信；直连暴露时应改用连接层的 remote address。
 * 这里取了常见的几个头，最坏情况下限流粒度变粗，不会失效。
 */
export function getClientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }

  return (
    request.headers.get('x-real-ip') ||
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-vercel-forwarded-for') ||
    'unknown'
  )
}
