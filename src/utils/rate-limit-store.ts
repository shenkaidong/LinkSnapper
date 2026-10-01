/**
 * 限流状态的存储后端。
 *
 * 默认实现是进程内的 Map（单实例部署够用）。但截图服务一旦水平扩展成多副本，
 * 每个实例各限各的会把实际额度放大 N 倍 —— 公网部署下这点会被爬虫瞬间利用。
 * 这时把后端换成 Redis，所有副本共享同一份令牌桶，限流才真正生效。
 *
 * 设计上把「状态存哪」和「令牌桶算法」解耦：算法（按时间补充、扣减、算等待时长）
 * 留在 TokenBucketLimiter，后端只负责「原子地读—补充—扣减—写回」一个桶。
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 一个令牌桶的瞬时状态 */
export interface BucketState {
  tokens: number
  updatedAt: number
}

/** 限流后端接口：算法层只依赖这个最小契约 */
export interface RateLimitBackend {
  /** 原子地对该 key 扣减 cost 个令牌（先按时间补充），返回扣减后的状态 */
  apply(key: string, capacity: number, refillPerSecond: number, cost: number, now: number, ttlMs: number): Promise<BucketState>
  /** 删除某个 key（用于达到容量上限时的回收） */
  delete(key: string): Promise<void>
  /** 当前桶数量（用于容量保护 / 观测） */
  count(): Promise<number>
}

/**
 * 进程内实现：用 Map 保存每个 key 的桶状态。
 * 这是默认后端，单实例下零额外依赖、零网络开销。
 */
export class InMemoryBackend implements RateLimitBackend {
  private readonly buckets = new Map<string, BucketState>()
  private readonly maxKeys: number

  constructor(maxKeys = 20_000) {
    this.maxKeys = maxKeys
  }

  async apply(
    key: string,
    capacity: number,
    refillPerSecond: number,
    cost: number,
    now: number,
    _ttlMs: number
  ): Promise<BucketState> {
    let bucket = this.buckets.get(key)

    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: now }
      this.buckets.set(key, bucket)
      if (this.buckets.size > this.maxKeys) this.evict(now, capacity, refillPerSecond)
    } else {
      const elapsedSec = (now - bucket.updatedAt) / 1000
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSecond)
      bucket.updatedAt = now
    }

    bucket.tokens -= cost
    return bucket
  }

  async delete(key: string): Promise<void> {
    this.buckets.delete(key)
  }

  async count(): Promise<number> {
    return this.buckets.size
  }

  /**
   * 先回收已经完全回满的桶，实在不够再整体清空
   * （宁可短暂放宽也不要让 Map 无限增长把内存吃掉）。
   */
  private evict(now: number, capacity: number, refillPerSecond: number): void {
    const fullRefillMs = (capacity / refillPerSecond) * 1000
    const expired: string[] = []

    // 用 forEach 而不是 for...of：tsconfig 的 target 是 es5，直接迭代 Map 编译不过
    this.buckets.forEach((bucket, key) => {
      if (now - bucket.updatedAt >= fullRefillMs) expired.push(key)
    })
    expired.forEach(key => this.buckets.delete(key))

    if (this.buckets.size > this.maxKeys) this.buckets.clear()
  }
}

// 原子扣减的 Lua 脚本：在 Redis 端完成「读—补充—扣减—写回」，
// 避免多副本并发时各读各写导致限流失效。返回 [剩余令牌, 上次更新时间戳]。
const REDIS_BUCKET_LUA = `
local data = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAt')
local tokens = tonumber(data[1])
local updatedAt = tonumber(data[2])
if tokens == nil then
  tokens = tonumber(ARGV[1])
  updatedAt = tonumber(ARGV[4])
end
local elapsed = (tonumber(ARGV[4]) - updatedAt) / 1000
tokens = math.min(tonumber(ARGV[1]), tokens + elapsed * tonumber(ARGV[2]))
tokens = tokens - tonumber(ARGV[3])
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'updatedAt', tonumber(ARGV[4]))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
return {tokens, updatedAt}
`

/**
 * Redis 实现：跨副本共享令牌桶。
 *
 * ioredis 是「可选依赖」——只有设置了 REDIS_URL 才会被加载；没装时由工厂层
 * 回退到内存，保证「没配 Redis」永远不会让服务起不来。
 */
export class RedisBackend implements RateLimitBackend {
  private readonly client: any

  constructor(client: any) {
    this.client = client
  }

  async apply(
    key: string,
    capacity: number,
    refillPerSecond: number,
    cost: number,
    now: number,
    ttlMs: number
  ): Promise<BucketState> {
    const result = await this.client.eval(REDIS_BUCKET_LUA, 1, key, capacity, refillPerSecond, cost, now, ttlMs)
    return { tokens: Number(result[0]), updatedAt: Number(result[1]) }
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key).catch(() => {})
  }

  async count(): Promise<number> {
    try {
      return await this.client.dbsize()
    } catch {
      return -1
    }
  }
}

export type RateLimitMode = 'memory' | 'redis'

let cachedBackend: RateLimitBackend | null = null
let cachedMode: RateLimitMode = 'memory'

/**
 * 根据环境变量选择后端：
 *   - 默认（无 REDIS_URL）：进程内 Map；
 *   - 设置了 REDIS_URL：尝试连 Redis；ioredis 未装则告警并回退内存。
 *
 * 连接是惰性的（lazyConnect），真正的可用性由截图请求触发；
 * 连不上时 RedisBackend.apply 抛错，由调用方按 500 处理。
 */
export function createRateLimitBackend(): { backend: RateLimitBackend; mode: RateLimitMode } {
  if (cachedBackend) return { backend: cachedBackend, mode: cachedMode }

  const redisUrl = process.env.REDIS_URL
  if (redisUrl) {
    try {
      const ioredis = require('ioredis')
      const Redis = ioredis.default || ioredis
      const client = new Redis(redisUrl, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 2,
        lazyConnect: true,
      })
      cachedBackend = new RedisBackend(client)
      cachedMode = 'redis'
      console.log('[rate-limit] 使用 Redis 后端（多实例共享限流）')
    } catch (error) {
      console.warn('[rate-limit] 设置了 REDIS_URL 但无法加载 ioredis，回退到进程内限流：', (error as Error).message)
      cachedBackend = new InMemoryBackend()
      cachedMode = 'memory'
    }
  } else {
    cachedBackend = new InMemoryBackend()
    cachedMode = 'memory'
  }

  return { backend: cachedBackend, mode: cachedMode }
}
