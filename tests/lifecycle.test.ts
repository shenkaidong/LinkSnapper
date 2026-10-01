import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  __resetForTests,
  endRequest,
  inFlightCount,
  isShuttingDown,
  onShutdown,
  shutdown,
  tryBeginRequest,
} from '../src/utils/lifecycle.ts'

describe('lifecycle', () => {
  test('初始状态：未在停机、无在途请求', () => {
    __resetForTests()
    assert.equal(isShuttingDown(), false)
    assert.equal(inFlightCount(), 0)
  })

  test('在途请求的登记与注销', () => {
    __resetForTests()
    assert.equal(tryBeginRequest(), true)
    assert.equal(inFlightCount(), 1)
    tryBeginRequest()
    assert.equal(inFlightCount(), 2)
    endRequest()
    assert.equal(inFlightCount(), 1)
    endRequest()
    assert.equal(inFlightCount(), 0)
  })

  test('注销次数多于登记时不会变成负数', () => {
    __resetForTests()
    endRequest()
    endRequest()
    assert.equal(inFlightCount(), 0)
  })

  test('停机中拒绝新请求（而不是让它排队后被掐断）', async () => {
    __resetForTests()
    const done = shutdown('test', { exit: false })
    assert.equal(isShuttingDown(), true, '调用 shutdown 后应立即置为停机')
    assert.equal(tryBeginRequest(), false, '停机中不应再接收新请求')
    await done
  })

  test('排空会等待在途请求结束，而不是立刻关机', async () => {
    __resetForTests()
    tryBeginRequest()

    let finished = false
    const done = shutdown('test', { exit: false }).then(() => {
      finished = true
    })

    // 让 shutdown 内部的 await 有机会推进
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(finished, false, '在途请求未结束时不应完成关机')

    endRequest()
    await done
    assert.equal(finished, true, '在途请求结束后应完成关机')
  })

  test('关机钩子会被执行', async () => {
    __resetForTests()
    const calls: string[] = []
    onShutdown(() => {
      calls.push('close-browser')
    })
    onShutdown(() => {
      calls.push('flush-metrics')
    })

    await shutdown('test', { exit: false })
    assert.deepEqual(calls, ['close-browser', 'flush-metrics'])
  })

  test('单个关机钩子抛错不影响其它钩子', async () => {
    __resetForTests()
    const calls: string[] = []
    onShutdown(() => {
      throw new Error('钩子故障')
    })
    onShutdown(() => {
      calls.push('still-ran')
    })

    await shutdown('test', { exit: false })
    assert.deepEqual(calls, ['still-ran'])
  })

  test('重复调用 shutdown 返回同一个 Promise（幂等）', async () => {
    __resetForTests()
    const first = shutdown('test', { exit: false })
    const second = shutdown('test', { exit: false })
    assert.equal(first, second)
    await first
  })
})
