/**
 * 视觉变更监控：像素比对。
 *
 * 这是「变了没」这个结论的唯一来源，所以每条断言都贴着真实结论去写 ——
 * 比如差异区域的外接框，必须能标到真实位置（缩放过后还可能错），
 * 光断言「changedRatio > 0」等于什么都没测。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { compareScreenshots, resolveThreshold, resolveMaxSide } from '../src/services/snapshot-diff.ts'

async function solid(width: number, height: number, background: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer()
}

/** 在纯色底上挖一块指定颜色的矩形，返回该矩形图 */
async function withBlock(
  width: number,
  height: number,
  background: string,
  block: { x: number; y: number; width: number; height: number; color: string }
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } })
    .composite([{ input: await solid(block.width, block.height, block.color), left: block.x, top: block.y }])
    .png()
    .toBuffer()
}

describe('compareScreenshots', () => {
  test('完全相同的图没有差异', async () => {
    const image = await solid(240, 120, '#3b82f6')

    const result = await compareScreenshots(image, image)

    assert.equal(result.changedPixels, 0)
    assert.equal(result.changedRatio, 0)
    assert.equal(result.boundingBox, null)
    assert.equal(result.scaled, false)
  })

  test('一块红色区域：比例与外接框都要对', async () => {
    const base = await solid(200, 100, '#ffffff')
    const next = await withBlock(200, 100, '#ffffff', {
      x: 100,
      y: 40,
      width: 50,
      height: 20,
      color: '#ff0000',
    })

    const result = await compareScreenshots(base, next)

    assert.equal(result.changedPixels, 50 * 20)
    assert.equal(result.changedRatio, 0.05)
    assert.deepEqual(result.boundingBox, { x: 100, y: 40, width: 50, height: 20 })
  })

  test('尺寸不同的图比对不报错，而是给出差异结论', async () => {
    const base = await solid(400, 200, '#ffffff')
    const next = await withBlock(200, 100, '#ffffff', { x: 0, y: 0, width: 100, height: 50, color: '#000000' })

    const result = await compareScreenshots(base, next)

    // 画布取两张图里较大的那个尺寸
    assert.equal(result.width, 400)
    assert.equal(result.height, 200)
    assert.ok(result.changedRatio > 0, '不同尺寸的图应当判定为有差异')
  })

  test('阈值决定噪声算不算变化', async () => {
    const base = await solid(80, 80, '#808080')
    // 每个通道整体偏移 +5：肉眼看着几乎一样，但确实是不同像素
    const next = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#858585' } })
      .png()
      .toBuffer()

    assert.equal((await compareScreenshots(base, next)).changedPixels, 0, '默认阈值 16 应过滤掉 +5 的抖动')

    const sensitive = await compareScreenshots(base, next, { threshold: 2 })
    assert.equal(sensitive.changedPixels, 80 * 80, '阈值降到 2 后整张图都算变化')
    assert.equal(sensitive.changedRatio, 1)
  })

  test('阈值/maxSide 传非法值时兜回默认值', () => {
    assert.equal(resolveThreshold(undefined), 16)
    assert.equal(resolveThreshold('abc'), 16)
    assert.equal(resolveThreshold(-1), 16)
    assert.equal(resolveThreshold('300'), 255)
    assert.equal(resolveMaxSide(undefined), 1600)
    assert.equal(resolveMaxSide('0'), 1600)
    assert.equal(resolveMaxSide(99999), 4000)
  })

  test('长图被缩到 maxSide 以内，外接框换算回原图坐标', async () => {
    const base = await solid(60, 600, '#ffffff')
    const next = await withBlock(60, 600, '#ffffff', { x: 0, y: 300, width: 30, height: 60, color: '#ff0000' })

    const result = await compareScreenshots(base, next, { maxSide: 100 })

    assert.equal(result.scaled, true)
    // 缩放后仍要能定位到"原图 y=300 附近变了"，而不是缩略图上的 y=30
    assert.ok(result.boundingBox, '应当有外接框')
    assert.ok(result.boundingBox!.y >= 250, `boundingBox.y=${result.boundingBox?.y} 应接近原图 300`)
    assert.ok(result.boundingBox!.y <= 350)
    assert.ok(result.boundingBox!.height >= 40)
  })

  test('diffImage 是一张可用的 png', async () => {
    const base = await solid(120, 60, '#ffffff')
    const next = await withBlock(120, 60, '#ffffff', { x: 10, y: 10, width: 20, height: 20, color: '#000000' })

    const result = await compareScreenshots(base, next)
    const meta = await sharp(result.diffImage).metadata()

    assert.equal(meta.format, 'png')
    assert.equal(meta.width, 120)
    assert.equal(meta.height, 60)
  })

  test('alpha 通道被压平，不会把透明当差异', async () => {
    const base = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer()
    const next = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer()

    const result = await compareScreenshots(base, next)

    // 透明图若没被 flatten，透明像素会被当成黑色差异 —— SVG 类站点就一直报警
    assert.equal(result.changedPixels, 0, '两张透明图不应报差异')
  })
})
