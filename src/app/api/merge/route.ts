import { NextResponse } from 'next/server'
import sharp from 'sharp'

export async function POST(request: Request) {
  try {
    const { screenshots } = await request.json()

    if (!Array.isArray(screenshots) || screenshots.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Screenshots array is required and must not be empty',
      })
    }

    // 将base64字符串转换为Buffer数组
    const buffers = screenshots.map(screenshot => 
      Buffer.from(screenshot, 'base64')
    )

    // 获取每个图片的尺寸
    const dimensions = await Promise.all(
      buffers.map(buffer => sharp(buffer).metadata())
    )

    // 计算合并后图片的总高度和宽度
    const totalHeight = dimensions.reduce((sum, dim) => sum + (dim.height || 0), 0)
    const width = dimensions[0]?.width || 1920 // 使用第一张图片的宽度，或默认1920

    try {
      // 创建一个新的图片画布
      const composite = await sharp({
        create: {
          width,
          height: totalHeight,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        }
      })
        .composite(
          buffers.map((buffer, index) => ({
            input: buffer,
            top: dimensions.slice(0, index).reduce((sum, dim) => sum + (dim.height || 0), 0),
            left: 0,
          }))
        )
        .png()
        .toBuffer()

      // 将合并后的图片转换为base64
      const mergedImage = composite.toString('base64')

      return NextResponse.json({
        success: true,
        mergedImage,
      })
    } catch (error) {
      console.error('Error during image composition:', error)
      return NextResponse.json({
        success: false,
        error: 'Failed to compose images',
      })
    }
  } catch (error) {
    console.error('Merge error:', error)
    return NextResponse.json({
      success: false,
      error: `Merge error: ${error}`,
    })
  }
} 