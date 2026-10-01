#!/usr/bin/env node
/**
 * 分段截图的性能对照。
 *
 * 对比两种取到同样 3 段的写法：
 *   A. 每段一次请求（maxSegments=1），即重构前的行为 —— 每次都要重新加载页面
 *   B. 一次请求取 3 段（maxSegments=3）—— 页面只加载一次
 *
 * 同时校验两者拿到的分段内容完全一致，确保「更快」不是因为少干活。
 *
 * 用法：BASE_URL=http://127.0.0.1:3100 node scripts/bench.mjs
 */

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const ITERATIONS = Number(process.env.BENCH_ITERATIONS) || 3
const TARGET_URL = process.env.BENCH_URL || `${BASE_URL}/test-fixture.html`

async function capture(payload) {
  const response = await fetch(`${BASE_URL}/api/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await response.json()
  if (!data.success) throw new Error(data.error || '截图失败')
  return data
}

/** A：逐段请求，每次都重新加载页面 */
async function sequential() {
  const startedAt = performance.now()
  const segments = []
  let offset = 0

  for (let i = 0; i < 3; i++) {
    const data = await capture({ url: TARGET_URL, offset, maxSegments: 1 })
    for (const segment of data.segments) segments.push(segment)
    if (data.isEnd) break
    offset = data.nextOffset
  }

  return { elapsed: performance.now() - startedAt, segments, requests: segments.length }
}

/** B：一次请求拿 3 段 */
async function batched() {
  const startedAt = performance.now()
  const data = await capture({ url: TARGET_URL, offset: 0, maxSegments: 3 })
  return { elapsed: performance.now() - startedAt, segments: data.segments, requests: 1 }
}

function summarize(segments) {
  return segments.map(s => `${s.offset}+${s.height}`).join(' → ')
}

async function main() {
  console.log(`LinkSnapper 分段截图性能对照 → ${BASE_URL}`)
  console.log(`目标页面：${TARGET_URL}\n`)

  // 预热：把共享浏览器实例拉起来，避免把冷启动算进第一次测量
  await capture({ url: TARGET_URL, offset: 0, maxSegments: 1 })
  console.log('已完成预热（浏览器实例常驻）\n')

  const seqRuns = []
  const batRuns = []
  let seqSegments = null
  let batSegments = null

  for (let i = 0; i < ITERATIONS; i++) {
    const seq = await sequential()
    const bat = await batched()
    seqRuns.push(seq.elapsed)
    batRuns.push(bat.elapsed)
    seqSegments = seq.segments
    batSegments = bat.segments
    console.log(
      `第 ${i + 1} 轮  逐段请求 ${seq.elapsed.toFixed(0)}ms (${seq.requests} 次请求)   ` +
        `批量请求 ${bat.elapsed.toFixed(0)}ms (${bat.requests} 次请求)`
    )
  }

  const avg = values => values.reduce((sum, value) => sum + value, 0) / values.length
  const seqAvg = avg(seqRuns)
  const batAvg = avg(batRuns)

  console.log(`\n平均：逐段 ${seqAvg.toFixed(0)}ms  →  批量 ${batAvg.toFixed(0)}ms`)
  console.log(`提速：${(seqAvg / batAvg).toFixed(2)}×，单次节省约 ${(seqAvg - batAvg).toFixed(0)}ms`)

  const sameShape = summarize(seqSegments) === summarize(batSegments)
  console.log(`\n分段结果一致性：${sameShape ? '一致 ✓' : '不一致 ✗'}`)
  console.log(`  逐段：${summarize(seqSegments)}`)
  console.log(`  批量：${summarize(batSegments)}`)

  if (!sameShape) process.exit(1)
}

main().catch(error => {
  console.error('压测失败：', error.message)
  process.exit(1)
})
