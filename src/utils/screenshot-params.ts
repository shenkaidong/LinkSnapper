import sharp from 'sharp'
import { HttpError } from './http-error.ts'

// 截图输出的图片格式。抽成单独模块，既能被路由复用，也能被单测直接覆盖，
// 同时避免把纯函数 export 在 Next.js 的 route 模块里（会触发路由类型生成报错）。
export type ImageFormat = 'png' | 'jpeg' | 'webp'

export const CONTENT_TYPES: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export function parseFormat(value: unknown): ImageFormat {
  if (value === undefined || value === null || value === '') return 'png'
  const normalized = String(value).toLowerCase()
  if (normalized === 'png' || normalized === 'jpeg' || normalized === 'webp') return normalized
  throw new HttpError(400, 'format 仅支持 png / jpeg / webp')
}

export function parseQuality(value: unknown, format: ImageFormat): number {
  // PNG 是无损格式，质量参数无意义
  if (format === 'png') return 0
  let n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) n = 80
  return Math.min(100, Math.max(1, Math.trunc(n)))
}

export function parseSelector(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new HttpError(400, 'selector 必须是字符串')
  if (value.length > 200) throw new HttpError(400, 'selector 过长（上限 200 字符）')
  return value
}

export function parseClip(
  value: unknown
): { x: number; y: number; width: number; height: number } | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'clip 必须是一个对象')
  }

  const v = value as Record<string, unknown>
  const out: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 0, height: 0 }

  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const raw = v[key]
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(n)) throw new HttpError(400, `clip.${key} 必须是数字`)
    out[key] = n
  }

  if (out.width <= 0 || out.height <= 0) {
    throw new HttpError(400, 'clip 的 width / height 必须为正数')
  }
  if (out.width > 200_000 || out.height > 200_000) {
    throw new HttpError(413, 'clip 尺寸过大')
  }

  return { x: out.x, y: out.y, width: out.width, height: out.height }
}

/**
 * 把 puppeteer 产出的 PNG 缓冲按目标格式转码。
 * 统一先截 PNG 再用 sharp 转码，有三个好处：
 *   - 不依赖 puppeteer 各版本对 webp 的原生支持是否稳定；
 *   - jpeg 顺手压白底（jpeg 没有 alpha 通道，透明区域会变黑）；
 *   - 质量参数集中处理，行为可预测。
 */
export async function encodeImage(png: Buffer, format: ImageFormat, quality: number): Promise<Buffer> {
  if (format === 'png') return png
  let pipeline = sharp(png, { failOn: 'none' })
  if (format === 'jpeg') {
    pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality })
  } else {
    pipeline = pipeline.webp({ quality })
  }
  return pipeline.toBuffer()
}
