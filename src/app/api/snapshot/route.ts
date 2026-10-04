/**
 * POST /api/snapshot —— 保存（或覆盖）一份视觉基准图。
 *
 * 视觉变更监控的第一步：把「当前认为正确的样子」冻结下来，
 * 之后每次巡检都跟这张图比。存的是 png + 一份记录参数的 json，
 * 所以事后能回答「当初是在什么视口、什么暗色模式下冻的基准」。
 *
 * key 可以不传：默认由 URL + 截图参数哈希得到。这样「同一个地址在不同视口下」
 * 天然是不同基准，调用方不用自己维护 id，两个调用方也不会互相覆盖。
 */

import { capturePng, runSnapshotJob } from '@/services/snapshot-guard'
import { deriveSnapshotKey, saveSnapshot } from '@/services/snapshot-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function pickKey(body: Record<string, unknown>): string | null {
  const raw = body.key
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

export async function POST(request: Request) {
  return runSnapshotJob(request, async job => {
    const key = pickKey(job.body) ?? deriveSnapshotKey(job.payload.url, job.payload as unknown as Record<string, unknown>)

    const png = await capturePng(job.payload)
    const meta = await saveSnapshot(key, png, {
      key,
      url: job.payload.url,
      // 存归一化后的参数而不是调用方原始 JSON：后者混着 offset / maxSegments
      // 这类只对本次请求有意义的字段，事后没法复现当时的基准。
      params: job.payload as unknown as Record<string, unknown>,
      format: 'png',
      savedAt: new Date().toISOString(),
    })

    return {
      success: true,
      action: 'baseline',
      key,
      url: meta.url,
      savedAt: meta.savedAt,
      bytes: meta.bytes,
      image: png.toString('base64'),
    }
  })
}

export function GET() {
  return Response.json(
    { success: false, error: '保存基准图请用 POST /api/snapshot' },
    { status: 405, headers: { 'Cache-Control': 'no-store' } }
  )
}
