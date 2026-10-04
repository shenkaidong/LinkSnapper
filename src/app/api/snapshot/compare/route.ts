/**
 * POST /api/snapshot/compare —— 视觉变更监控的第二步：跟基准图比。
 *
 * 返回三样东西：变了没（changed）、变了多少（changedRatio / boundingBox）、
 * 以及一张把差异标红的图（diffImage，base64 png），
 * 这样人不用下载原图也能一眼看出改了哪块。
 *
 * 基准图缺失时返回 404 而不是静默建立新基准：自动建基准会让人以为
 * "从没报警过"其实只是"从来没比对过"，这类静默失败比报错危险得多。
 */

import { capturePng, runSnapshotJob } from '@/services/snapshot-guard'
import { compareScreenshots } from '@/services/snapshot-diff'
import { deriveSnapshotKey, loadSnapshot, snapshotExists } from '@/services/snapshot-store'
import { HttpError } from '@/utils/http-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return runSnapshotJob(request, async job => {
    const { body, payload } = job

    const explicitKey = typeof body.key === 'string' && body.key.trim() !== '' ? body.key.trim() : null
    const key = explicitKey ?? deriveSnapshotKey(payload.url, payload as unknown as Record<string, unknown>)

    if (!(await snapshotExists(key))) {
      throw new HttpError(404, `基准图 "${key}" 不存在，请先 POST /api/snapshot 保存基准再比对`)
    }

    const { png: baseline } = await loadSnapshot(key)
    if (!baseline) {
      throw new HttpError(500, `基准图 "${key}" 读取失败，文件可能已损坏`)
    }

    const current = await capturePng(payload)
    const result = await compareScreenshots(baseline, current, {
      threshold: body.threshold,
      maxSide: body.maxSide,
    })

    return {
      success: true,
      action: 'compare',
      key,
      url: payload.url,
      changed: result.changedRatio > 0,
      changedPixels: result.changedPixels,
      changedRatio: Number(result.changedRatio.toFixed(6)),
      boundingBox: result.boundingBox,
      width: result.width,
      height: result.height,
      threshold: result.threshold,
      scaled: result.scaled,
      diffImage: result.diffImage.toString('base64'),
      comparedAt: new Date().toISOString(),
    }
  })
}

export function GET() {
  return Response.json(
    { success: false, error: '比对基准图请用 POST /api/snapshot/compare' },
    { status: 405, headers: { 'Cache-Control': 'no-store' } }
  )
}
