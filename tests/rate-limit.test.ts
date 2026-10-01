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

describe('TokenBucketLimiter', () => {
  test('容量用尽前放行，用尽后拒绝', () => {
    const limiter = new TokenBucketLimiter(3, 0)

    assert.equal(limiter.take('ip').allowed, true)
    assert.equal(limiter.take('ip').allowed, true)
    assert.equal(limiter.take('ip').allowed, true)

    const denied = limiter.take('ip')
    assert.equal(denied.allowed, false)
    assert.ok(denied.retryAfterSec >= 1, '应给出建议等待秒数')
  })

  test('不同 key 各用各的额度', () => {
    const limiter = new TokenBucketLimiter(1, 0)

    assert.equal(limiter.take('a').allowed, true)
    assert.equal(limiter.take('a').allowed, false)
    assert.equal(limiter.take('b').allowed, true)
  })

  test('随时间补充令牌', async () => {
    // 容量 1，每秒补 50 个 —— 等 40ms 就足够回满
    const limiter = new TokenBucketLimiter(1, 50)

    assert.equal(limiter.take('ip').allowed, true)
    assert.equal(limiter.take('ip').allowed, false)

    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(limiter.take('ip').allowed, true, '等待后应恢复额度')
  })

  test('补充不会超过容量上限', async () => {
    const limiter = new TokenBucketLimiter(2, 1000)
    await new Promise(resolve => setTimeout(resolve, 30))

    // 即便过了很久，也只能拿到容量上限那么多
    assert.equal(limiter.take('ip').allowed, true)
    assert.equal(limiter.take('ip').allowed, true)
    assert.equal(limiter.take('ip').allowed, false)
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
