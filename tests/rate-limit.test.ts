/**
 * 限流与并发闸门的单元测试。
 *
 * 重点验证两件在旧实现里缺失的能力：
 *   1. 排队队列有上限 —— 超出的请求立刻被拒，而不是无限堆积；
 *   2. 排队有超时 —— 挂太久的请求会被释放，不会一直占着连接。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { TokenBucketLimiter, BoundedSemaphore, QueueFullError, QueueTimeoutError, getClientKey } from '../src/utils/rate-limit.ts'
import { createRateLimitBackend, InMemoryBackend } from '../src/utils/rate-limit-store.ts'

/** 可控时钟：让令牌桶的时间推进完全由测试决定 */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_000_000
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

describe('TokenBucketLimiter', () => {
  test('容量用尽前放行，用尽后拒绝', async () => {
    const limiter = new TokenBucketLimiter(3, 0)

    assert.equal((await limiter.take('ip')).allowed, true)
    assert.equal((await limiter.take('ip')).allowed, true)
    assert.equal((await limiter.take('ip')).allowed, true)

    const denied = await limiter.take('ip')
    assert.equal(denied.allowed, false)
    assert.ok(denied.retryAfterSec >= 1, '应给出建议等待秒数')
  })

  test('不同 key 各用各的额度', async () => {
    const limiter = new TokenBucketLimiter(1, 0)

    assert.equal((await limiter.take('a')).allowed, true)
    assert.equal((await limiter.take('a')).allowed, false)
    assert.equal((await limiter.take('b')).allowed, true)
  })

  // 下面两个用例用注入的固定时钟，而不是真实时间。
  //
  // 原因：令牌桶是否放行取决于「两次取令牌之间流逝了多久」。用真实时间时，
  // 每次 await take() 本身就会耗掉约 1ms，而补充速率是 1000/秒 —— 一次 await
  // 就补回 1 个令牌，导致「本该被拒的第 3 次请求」被放行。这种断言只在机器
  // 负载恰好够低时才通过，属于典型的 flaky 测试（调依赖补丁改变调度时序就会翻车）。
  test('随时间补充令牌', async () => {
    const clock = fakeClock()
    const limiter = new TokenBucketLimiter(1, 50, undefined, clock.now)

    assert.equal((await limiter.take('ip')).allowed, true)
    assert.equal((await limiter.take('ip')).allowed, false)

    clock.advance(60) // 60ms × 50/秒 = 3 个令牌，足够回满容量 1
    assert.equal((await limiter.take('ip')).allowed, true, '时间推进后应恢复额度')
  })

  test('补充不会超过容量上限', async () => {
    const clock = fakeClock()
    const limiter = new TokenBucketLimiter(2, 1000, undefined, clock.now)

    // 推进 10 秒 = 理论补充 10000 个令牌，但上限是容量 2
    clock.advance(10_000)

    // 时钟由测试掌控，三次 take 之间不流逝时间，因此结果是确定的
    assert.equal((await limiter.take('ip')).allowed, true)
    assert.equal((await limiter.take('ip')).allowed, true)
    assert.equal((await limiter.take('ip')).allowed, false, '回满后最多只能取到容量上限')
  })

  test('不补充（refill=0）被拒时给出有限等待值而非 Infinity', async () => {
    const limiter = new TokenBucketLimiter(1, 0)
    assert.equal((await limiter.take('ip')).allowed, true)
    const denied = await limiter.take('ip')
    assert.equal(denied.allowed, false)
    assert.ok(Number.isFinite(denied.retryAfterSec), '等待秒数必须是有限值')
  })
})

describe('RateLimitBackend', () => {
  test('默认后端是进程内（单实例）', () => {
    // 不设置 REDIS_URL 时一定是 memory 模式
    const { mode } = createRateLimitBackend()
    assert.equal(mode, 'memory')
  })

  test('InMemoryBackend 原子扣减后状态正确', async () => {
    const backend = new InMemoryBackend()
    const now = 1_000_000

    // 首次：桶以 capacity 初始化再扣 1
    const s1 = await backend.apply('k', 3, 0, 1, now, 10_000)
    assert.equal(s1.tokens, 2)

    // 第二次再扣 1
    const s2 = await backend.apply('k', 3, 0, 1, now + 10, 10_000)
    assert.equal(s2.tokens, 1)
  })
})

describe('BoundedSemaphore', () => {
  test('未达上限时可直接获取', async () => {
    const semaphore = new BoundedSemaphore(2, 5, 1000)

    const releaseA = await semaphore.acquire()
    const releaseB = await semaphore.acquire()
    assert.equal(semaphore.activeCount, 2)

    releaseA()
    releaseB()
    assert.equal(semaphore.activeCount, 0)
  })

  test('多余请求进入队列，释放后按序被唤醒', async () => {
    const semaphore = new BoundedSemaphore(1, 5, 1000)

    const releaseFirst = await semaphore.acquire()
    const waiting = semaphore.acquire()

    // 让等待者先挂上，再释放
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(semaphore.waitingCount, 1)

    releaseFirst()
    const releaseSecond = await waiting
    assert.equal(semaphore.activeCount, 1)

    releaseSecond()
    assert.equal(semaphore.activeCount, 0)
  })

  test('队列满时立刻拒绝，不无限堆积', async () => {
    const semaphore = new BoundedSemaphore(1, 1, 5000)

    const releaseFirst = await semaphore.acquire()
    const queued = semaphore.acquire().catch(error => error)

    await new Promise(resolve => setTimeout(resolve, 10))

    await assert.rejects(() => semaphore.acquire(), QueueFullError)

    releaseFirst()
    await queued
  })

  test('排队超时后抛错并让出位置', async () => {
    const semaphore = new BoundedSemaphore(1, 5, 50)

    const releaseFirst = await semaphore.acquire()

    await assert.rejects(() => semaphore.acquire(), QueueTimeoutError)
    assert.equal(semaphore.waitingCount, 0, '超时后应把自己从队列里摘掉')

    releaseFirst()
    assert.equal(semaphore.activeCount, 0)
  })

  test('重复释放不会把计数弄坏', async () => {
    const semaphore = new BoundedSemaphore(2, 5, 1000)

    const release = await semaphore.acquire()
    release()
    release()
    release()

    assert.equal(semaphore.activeCount, 0, '重复调用 release 不应变成负数')
  })
})

describe('getClientKey', () => {
  test('优先取 x-forwarded-for 的第一个地址', () => {
    const request = new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' },
    })
    assert.equal(getClientKey(request), '203.0.113.7')
  })

  test('退回 x-real-ip', () => {
    const request = new Request('http://localhost/', { headers: { 'x-real-ip': '198.51.100.9' } })
    assert.equal(getClientKey(request), '198.51.100.9')
  })

  test('都没有时返回 unknown 而不是抛错', () => {
    const request = new Request('http://localhost/')
    assert.equal(getClientKey(request), 'unknown')
  })
})
