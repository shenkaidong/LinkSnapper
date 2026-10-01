/**
 * 精细化截图参数的单元测试。
 *
 * parseFormat / parseQuality / parseSelector / parseClip 都是纯函数，
 * 不依赖浏览器，秒级跑完；encodeImage 只依赖 sharp，也不拉起 Chromium。
 * 把它们自动验证，比「手工 curl 一遍看着像对的」可靠得多。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  parseFormat,
  parseQuality,
  parseSelector,
  parseClip,
  encodeImage,
} from '../src/utils/screenshot-params.ts'

function isHttpError(e: unknown): e is { status: number } {
  return typeof e === 'object' && e !== null && 'status' in e && typeof (e as any).status === 'number'
}

describe('parseFormat', () => {
  test('默认 / 空值回退为 png', () => {
    assert.equal(parseFormat(undefined), 'png')
    assert.equal(parseFormat(null), 'png')
    assert.equal(parseFormat(''), 'png')
  })

  test('接受 jpeg / webp，且大小写不敏感', () => {
    assert.equal(parseFormat('jpeg'), 'jpeg')
    assert.equal(parseFormat('webp'), 'webp')
    assert.equal(parseFormat('PNG'), 'png')
  })

  test('非法格式抛 400', () => {
    let err: unknown
    try {
      parseFormat('gif')
    } catch (e) {
      err = e
    }
    assert.ok(isHttpError(err) && err.status === 400, '应抛 400')
  })
})

describe('parseQuality', () => {
  test('png 始终忽略质量返回 0', () => {
    assert.equal(parseQuality(95, 'png'), 0)
    assert.equal(parseQuality('oops', 'png'), 0)
  })

  test('jpeg / webp 默认质量 80', () => {
    assert.equal(parseQuality(undefined, 'jpeg'), 80)
    assert.equal(parseQuality(NaN, 'webp'), 80)
  })

  test('数值被夹紧到 1..100', () => {
    assert.equal(parseQuality(0, 'jpeg'), 1)
    assert.equal(parseQuality(999, 'webp'), 100)
    assert.equal(parseQuality(42.9, 'jpeg'), 42)
  })
})

describe('parseSelector', () => {
  test('空 / 缺失返回 null（表示不启用元素截图）', () => {
    assert.equal(parseSelector(undefined), null)
    assert.equal(parseSelector(null), null)
    assert.equal(parseSelector(''), null)
  })

  test('合法选择器原样返回', () => {
    assert.equal(parseSelector('#main .card'), '#main .card')
  })

  test('非字符串或过长抛错', () => {
    let e1: unknown
    try {
      parseSelector(123)
    } catch (e) {
      e1 = e
    }
    assert.ok(isHttpError(e1) && e1.status === 400)

    let e2: unknown
    try {
      parseSelector('a'.repeat(201))
    } catch (e) {
      e2 = e
    }
    assert.ok(isHttpError(e2) && e2.status === 400)
  })
})

describe('parseClip', () => {
  test('缺失返回 null', () => {
    assert.equal(parseClip(undefined), null)
    assert.equal(parseClip(null), null)
  })

  test('合法裁剪对象原样返回', () => {
    const clip = parseClip({ x: 10, y: 20, width: 300, height: 400 })
    assert.deepEqual(clip, { x: 10, y: 20, width: 300, height: 400 })
  })

  test('非对象抛 400', () => {
    let err: unknown
    try {
      parseClip('not-an-object')
    } catch (e) {
      err = e
    }
    assert.ok(isHttpError(err) && err.status === 400)
  })

  test('字段非数字抛 400', () => {
    let err: unknown
    try {
      parseClip({ x: 0, y: 0, width: 'wide', height: 10 })
    } catch (e) {
      err = e
    }
    assert.ok(isHttpError(err) && err.status === 400)
  })

  test('宽高为非正数抛 400', () => {
    let err: unknown
    try {
      parseClip({ x: 0, y: 0, width: 0, height: 10 })
    } catch (e) {
      err = e
    }
    assert.ok(isHttpError(err) && err.status === 400)
  })

  test('尺寸过大抛 413', () => {
    let err: unknown
    try {
      parseClip({ x: 0, y: 0, width: 300_000, height: 10 })
    } catch (e) {
      err = e
    }
    assert.ok(isHttpError(err) && err.status === 413)
  })
})

describe('encodeImage', () => {
  // 生成一张 4x4 的红色 PNG 作为输入
  async function makePng(): Promise<Buffer> {
    return sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer()
  }

  test('png 原样返回（且仍是合法 PNG）', async () => {
    const png = await makePng()
    const out = await encodeImage(png, 'png', 0)
    assert.deepEqual(out, png)
  })

  test('jpeg 输出以 FF D8 FF 开头（JPEG 魔术字节）', async () => {
    const png = await makePng()
    const out = await encodeImage(png, 'jpeg', 80)
    assert.equal(out[0], 0xff)
    assert.equal(out[1], 0xd8)
    assert.equal(out[2], 0xff)
  })

  test('webp 输出以 RIFF....WEBP 开头', async () => {
    const png = await makePng()
    const out = await encodeImage(png, 'webp', 80)
    const head = out.subarray(0, 4).toString('ascii')
    const fmt = out.subarray(8, 12).toString('ascii')
    assert.equal(head, 'RIFF')
    assert.equal(fmt, 'WEBP')
  })
})
