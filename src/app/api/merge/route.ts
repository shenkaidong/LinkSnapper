import { NextResponse } from 'next/server'
import sharp from 'sharp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// sharp / libvips 对单张图片的像素数有上限，拼接后的长图很容易撞到。
// 1920 x 30000 ≈ 5760 万像素，留出足够余量。
const MAX_TOTAL_HEIGHT = 30000
const MAX_SEGMENTS = 60

export async function POST(request: Request) {
  let screenshots: unknown

  try {
    ;({ screenshots } = await request.json())
  } catch {
    return NextResponse.json({ success: false, error: '请求体不是合法的 JSON' }, { status: 400 })
  }

  if (!Array.isArray(screenshots) || screenshots.length === 0) {
    return NextResponse.json(
      { success: false, error: '请至少提供一张待拼接的截图' },
      { status: 400 }
    )
  }

  if (screenshots.length > MAX_SEGMENTS) {
    return NextResponse.json(
      { success: false, error: `单次最多拼接 ${MAX_SEGMENTS} 段，当前 ${screenshots.length} 段` },
      { status: 400 }
    )
  }

  try {
    const buffers = screenshots.map(item => {
      if (typeof item !== 'string' || item.length === 0) {
        throw new Error('截图数据格式不正确')
      }
      return Buffer.from(item, 'base64')
    })

    const metadataList = await Promise.all(buffers.map(buffer => sharp(buffer).metadata()))

    // 宽高缺失说明不是有效图片
    if (metadataList.some(meta => !meta.width || !meta.height)) {
      return NextResponse.json({ success: false, error: '存在无法解析的图片数据' }, { status: 400 })
    }

    // 以第一张的宽度为基准，其余等比缩放对齐，避免不同宽度直接叠加产生错位
    const width = metadataList[0].width as number
    const scaled = await Promise.all(
      buffers.map((buffer, index) => {
        const meta = metadataList[index]
        if (meta.width === width) return Promise.resolve(buffer)
        return sharp(buffer).resize({ width }).toBuffer()
      })
    )

    const scaledMeta = await Promise.all(scaled.map(buffer => sharp(buffer).metadata()))
    const heights = scaledMeta.map(meta => meta.height as number)

    const totalHeight = heights.reduce((sum, height) => sum + height, 0)
    if (totalHeight > MAX_TOTAL_HEIGHT) {
      return NextResponse.json(
        {
          success: false,
          error: `拼接后高度 ${totalHeight}px 超出上限 ${MAX_TOTAL_HEIGHT}px，请减少分段数量`,
        },
        { status: 400 }
      )
    }

    // 逐段累加 top 偏移，避免在 map 里反复 slice 求和
    let cursor = 0
    const layers = scaled.map((buffer, index) => {
      const layer = { input: buffer, top: cursor, left: 0 }
      cursor += heights[index]
      return layer
    })

    const merged = await sharp({
      create: {
        width,
        height: totalHeight,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .composite(layers)
      .png()
      .toBuffer()

    return NextResponse.json({
      success: true,
      mergedImage: merged.toString('base64'),
    })
  } catch (error) {
    console.error('Merge error:', error)
    const message = error instanceof Error ? error.message : '图片拼接失败'
    return NextResponse.json({ success: false, error: message }, { status: 400 })
  }
}
