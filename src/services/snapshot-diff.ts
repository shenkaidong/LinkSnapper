/**
 * 两张截图的像素级比对（视觉变更监控的核心）。
 *
 * 只回答三件事：变了没、变了多少、变在哪。够让 Agent 或看板直接下结论，
 * 不需要引入一套自己的差异对象模型。
 *
 * 两条硬约束：
 *   - **长图不能真的吃进内存** 1920×30000 的整页截图像素级循环是 57M 次迭代，
 *     会卡死事件循环，所以比对前先把两张图等比缩到 maxSide 以内。
 *   - **尺寸不一致不算错误** 视口改了、横竖屏切了，图就是不同尺寸，
 *     这时候「有差异」本身就是结论。
 */

import sharp from 'sharp'
import { HttpError } from '@/utils/http-error'

export const DEFAULT_DIFF_THRESHOLD = 16
export const DEFAULT_DIFF_MAX_SIDE = 1600
export const MAX_CANVAS_SIDE = 4000

export interface DiffBoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface DiffResult {
  /** 差异像素数（换算回原图坐标后的整数值） */
  changedPixels: number
  /** 变化像素占画布面积的比例，0–1 */
  changedRatio: number
  /** 差异区域最小外接框；完全没变化时是 null */
  boundingBox: DiffBoundingBox | null
  /** 比对画布对应的原图尺寸（取两张图里较大的那个） */
  width: number
  height: number
  threshold: number
  /** 是否发生过缩放（缩到 maxSide 以内） */
  scaled: boolean
}

export type DiffComparison = DiffResult & { diffImage: Buffer }

interface RawImage {
  data: Buffer
  width: number
  height: number
  channels: number
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) ? n : Number.NaN
}

/** body 没给、环境变量也没给时才用默认值 —— 让阈值与画布上限可以按实例统一调 */
function fromEnv(name: string): number {
  const n = toNumber(process.env[name])
  return Number.isFinite(n) ? n : Number.NaN
}

export function resolveThreshold(value: unknown): number {
  const n = toNumber(value)
  const fallback = Number.isFinite(n) ? n : fromEnv('SNAPSHOT_DIFF_THRESHOLD')
  if (!Number.isFinite(fallback) || fallback < 0) return DEFAULT_DIFF_THRESHOLD
  return Math.min(255, Math.max(0, Math.trunc(fallback)))
}

export function resolveMaxSide(value: unknown): number {
  const n = toNumber(value)
  const fallback = Number.isFinite(n) ? n : fromEnv('SNAPSHOT_DIFF_MAX_SIDE')
  if (!Number.isFinite(fallback) || fallback <= 0) return DEFAULT_DIFF_MAX_SIDE
  return Math.min(MAX_CANVAS_SIDE, Math.max(64, Math.trunc(fallback)))
}

/**
 * 归一化为同尺寸裸像素。
 *
 * flatten + removeAlpha 让通道数恒为 3，逐像素比较不必分情况；
 * resize 用 fit:fill 把两张图拉到同一画布 —— 因为它们用的是同一个 scale，
 * 内容之间的相对位置是一致的，不会引入额外变形。
 */
async function toRaw(input: Buffer, width: number, height: number): Promise<RawImage> {
  const { data, info } = await sharp(input)
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })

  return { data, width: info.width, height: info.height, channels: info.channels }
}

/**
 * 比对两张截图。
 *
 * @param threshold 单通道差值超过该值即算「变」。默认 16 —— 再低就会把
 *   JPEG 噪声、字体抗锯齿抖动全算成变更，看板天天报警；设 0 等于关掉噪声过滤。
 */
export async function compareScreenshots(
  base: Buffer,
  next: Buffer,
  // 两个参数直接吃 HTTP body 里的原始值：非法输入在 resolve* 里被兜回默认值，
  // 不必为了这两个可选项再写一层参数校验。
  options: { threshold?: unknown; maxSide?: unknown } = {}
): Promise<DiffComparison> {
  const threshold = resolveThreshold(options.threshold)
  const maxSide = resolveMaxSide(options.maxSide)

  const baseMeta = await sharp(base).metadata()
  const nextMeta = await sharp(next).metadata()

  const baseWidth = baseMeta.width ?? 0
  const baseHeight = baseMeta.height ?? 0
  const nextWidth = nextMeta.width ?? 0
  const nextHeight = nextMeta.height ?? 0

  if (baseWidth <= 0 || baseHeight <= 0 || nextWidth <= 0 || nextHeight <= 0) {
    throw new HttpError(400, '基准图或新截图尺寸无效，无法比对')
  }

  const scale = Math.min(1, maxSide / Math.max(baseWidth, baseHeight, nextWidth, nextHeight))
  const canvasWidth = Math.max(2, Math.min(MAX_CANVAS_SIDE, Math.round(baseWidth * scale)))
  const canvasHeight = Math.max(2, Math.min(MAX_CANVAS_SIDE, Math.round(baseHeight * scale)))

  const [a, b] = await Promise.all([
    toRaw(base, canvasWidth, canvasHeight),
    toRaw(next, canvasWidth, canvasHeight),
  ])

  // ---- 逐像素扫描：差异计数 + 差异区外接框 ----
  const channels = a.channels
  const rowBytes = a.width * channels
  const { data: left } = a
  const { data: right } = b

  let changedPixels = 0
  let minX = a.width
  let minY = a.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < a.height; y++) {
    const rowStart = y * rowBytes

    for (let x = 0; x < a.width; x++) {
      const i = rowStart + x * channels

      const dr = Math.abs(left[i] - right[i])
      const dg = Math.abs(left[i + 1] - right[i + 1])
      const db = Math.abs(left[i + 2] - right[i + 2])
      if (dr <= threshold && dg <= threshold && db <= threshold) continue

      changedPixels++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  // 缩放比换算回原图坐标：boundingBox 是给人看位置的（"第 1200px 处变了"），
  // 必须回到原图尺度，否则框标不到真实位置。
  const inverse = 1 / scale
  const totalPixels = a.width * a.height

  // ---- 生成差异图：差异处标红，其余保留基准图原样 ----
  const diffImage = Buffer.allocUnsafe(rowBytes * a.height)
  for (let i = 0; i < diffImage.length; i++) {
    const changed =
      Math.abs(left[i] - right[i]) > threshold ||
      Math.abs(left[i + 1] - right[i + 1]) > threshold ||
      Math.abs(left[i + 2] - right[i + 2]) > threshold
    diffImage[i] = changed ? 255 : left[i]
    diffImage[i + 1] = changed ? 0 : left[i + 1]
    diffImage[i + 2] = changed ? 0 : left[i + 2]
  }

  const overlay = await sharp(diffImage, {
    raw: { width: a.width, height: a.height, channels: channels as 3 },
  })
    .png({ compressionLevel: 6 })
    .toBuffer()

  return {
    changedPixels,
    changedRatio: totalPixels > 0 ? changedPixels / totalPixels : 0,
    boundingBox:
      maxX < 0
        ? null
        : {
            x: Math.max(0, Math.round(minX * inverse)),
            y: Math.max(0, Math.round(minY * inverse)),
            width: Math.max(1, Math.round((maxX - minX + 1) * inverse)),
            height: Math.max(1, Math.round((maxY - minY + 1) * inverse)),
          },
    width: Math.max(baseWidth, nextWidth),
    height: Math.max(baseHeight, nextHeight),
    threshold,
    scaled: scale < 1,
    diffImage: overlay,
  }
}
