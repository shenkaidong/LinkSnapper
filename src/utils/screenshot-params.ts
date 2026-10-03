import sharp from 'sharp'
import { HttpError } from './http-error.ts'

// 截图输出的图片格式。抽成单独模块，既能被路由复用，也能被单测直接覆盖，
// 同时避免把纯函数 export 在 Next.js 的 route 模块里（会触发路由类型生成报错）。
export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'pdf'

export const CONTENT_TYPES: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
}

export function parseFormat(value: unknown): ImageFormat {
  if (value === undefined || value === null || value === '') return 'png'
  const normalized = String(value).toLowerCase()
  if (normalized === 'png' || normalized === 'jpeg' || normalized === 'webp') return normalized
  if (normalized === 'pdf') return 'pdf'
  throw new HttpError(400, 'format 仅支持 png / jpeg / webp / pdf')
}

// ---------------------------------------------------------------------------
// 视口与设备模拟
// ---------------------------------------------------------------------------

export interface ViewportSpec {
  width: number
  height: number
  deviceScaleFactor: number
  isMobile: boolean
  hasTouch: boolean
}

/**
 * 设备预设。同类服务普遍提供 mobile / tablet / desktop 三档，
 * 这里给出有代表性的分辨率，并配套 isMobile / hasTouch ——
 * 只改分辨率不改 isMobile 的话，很多站点的响应式断点根本不会触发，
 * 截出来仍然是桌面版布局，这正是"设备模拟"最容易做成半成品的地方。
 */
export const DEVICE_PRESETS: Record<'mobile' | 'tablet' | 'desktop', ViewportSpec> = {
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  tablet: { width: 834, height: 1112, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
}

const MIN_VIEWPORT = 1
const MAX_VIEWPORT_WIDTH = 3840
const MAX_VIEWPORT_HEIGHT = 2160
const MAX_SCALE_FACTOR = 3

export function parseDevice(value: unknown): 'mobile' | 'tablet' | 'desktop' | null {
  if (value === undefined || value === null || value === '') return null
  const normalized = String(value).toLowerCase()
  if (normalized === 'mobile' || normalized === 'tablet' || normalized === 'desktop') return normalized
  throw new HttpError(400, 'device 仅支持 mobile / tablet / desktop')
}

/**
 * 解析最终视口。显式 width/height 优先于 device 预设，
 * 这样"用设备的其他属性、但自定义分辨率"这种组合也能表达。
 */
export function resolveViewport(input: {
  device?: unknown
  width?: unknown
  height?: unknown
  deviceScaleFactor?: unknown
}): ViewportSpec | null {
  const device = parseDevice(input.device)
  const hasExplicitSize = input.width !== undefined || input.height !== undefined
  const hasScale = input.deviceScaleFactor !== undefined
  if (!device && !hasExplicitSize && !hasScale) return null

  const base = device ? DEVICE_PRESETS[device] : DEVICE_PRESETS.desktop

  let width = base.width
  let height = base.height

  if (input.width !== undefined && input.width !== null && input.width !== '') {
    width = Math.trunc(Number(input.width))
    if (!Number.isFinite(width)) throw new HttpError(400, 'width 必须是数字')
  }
  if (input.height !== undefined && input.height !== null && input.height !== '') {
    height = Math.trunc(Number(input.height))
    if (!Number.isFinite(height)) throw new HttpError(400, 'height 必须是数字')
  }

  if (width < MIN_VIEWPORT || height < MIN_VIEWPORT) {
    throw new HttpError(400, 'width / height 必须为正数')
  }
  if (width > MAX_VIEWPORT_WIDTH || height > MAX_VIEWPORT_HEIGHT) {
    throw new HttpError(413, `视口尺寸过大（上限 ${MAX_VIEWPORT_WIDTH}x${MAX_VIEWPORT_HEIGHT}）`)
  }

  let deviceScaleFactor = base.deviceScaleFactor
  if (hasScale && input.deviceScaleFactor !== null && input.deviceScaleFactor !== '') {
    deviceScaleFactor = Number(input.deviceScaleFactor)
    if (!Number.isFinite(deviceScaleFactor)) throw new HttpError(400, 'deviceScaleFactor 必须是数字')
    deviceScaleFactor = Math.min(MAX_SCALE_FACTOR, Math.max(1, deviceScaleFactor))
  }

  return {
    width,
    height,
    deviceScaleFactor,
    isMobile: base.isMobile,
    hasTouch: base.hasTouch,
  }
}

// ---------------------------------------------------------------------------
// 页面修饰：暗色模式 / 隐藏元素 / 注入 CSS / 注入 JS
// ---------------------------------------------------------------------------

/** 注入脚本的大小上限，避免把巨型脚本塞进页面 */
const MAX_INJECT_BYTES = 10_000
const MAX_SELECTOR_LIST = 20

export function parseDarkMode(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false
  if (typeof value === 'boolean') return value
  const normalized = String(value).toLowerCase()
  return normalized === 'true' || normalized === '1'
}

export function parseBlockFlag(value: unknown): boolean {
  return parseDarkMode(value)
}

/** 解析"要隐藏的元素"选择器列表。空值返回空数组，调用方据此跳过注入。 */
export function parseHideSelectors(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return []

  const raw = Array.isArray(value) ? value : [value]
  if (raw.length > MAX_SELECTOR_LIST) {
    throw new HttpError(400, `hideSelectors 最多 ${MAX_SELECTOR_LIST} 个`)
  }

  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') throw new HttpError(400, 'hideSelectors 的元素必须是字符串')
    if (item.length > 200) throw new HttpError(400, 'hideSelectors 中的选择器过长（上限 200 字符）')
    // 选择器会被拼进 CSS，闭合花括号/尖括号能逃逸出规则块，必须挡掉
    if (/[{}<>]/.test(item)) throw new HttpError(400, 'hideSelectors 中的选择器含有非法字符')
    out.push(item)
  }
  return out
}

export function parseInjectCss(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new HttpError(400, 'css 必须是字符串')
  if (Buffer.byteLength(value, 'utf8') > MAX_INJECT_BYTES) {
    throw new HttpError(413, `css 过大（上限 ${MAX_INJECT_BYTES} 字节）`)
  }
  return value
}

export function parseInjectJs(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new HttpError(400, 'js 必须是字符串')
  if (Buffer.byteLength(value, 'utf8') > MAX_INJECT_BYTES) {
    throw new HttpError(413, `js 过大（上限 ${MAX_INJECT_BYTES} 字节）`)
  }
  return value
}

/** 把选择器列表拼成"隐藏这些元素"的 CSS */
export function buildHideCss(selectors: string[]): string | null {
  if (selectors.length === 0) return null
  return `${selectors.join(', ')} { display: none !important; visibility: hidden !important; }`
}

// ---------------------------------------------------------------------------
// 等待策略
// ---------------------------------------------------------------------------

const MAX_WAIT_TIMEOUT_MS = 30_000

export function parseWaitForSelector(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new HttpError(400, 'waitForSelector 必须是字符串')
  if (value.length > 200) throw new HttpError(400, 'waitForSelector 过长（上限 200 字符）')
  return value
}

export function parseWaitForTimeout(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'waitForTimeout 必须是非负数字')
  return Math.min(MAX_WAIT_TIMEOUT_MS, Math.trunc(n))
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
