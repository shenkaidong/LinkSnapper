import puppeteer, { Browser, Page } from 'puppeteer-core'
import chrome from '@/utils/chrome'

const MAX_RETRIES = 3
const RETRY_DELAY = 1000

// 使用全局对象存储滚动位置
const globalScrollPositions: { [key: string]: number } = {}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForDynamicContent(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    let previousHeight = document.documentElement.scrollHeight
    let stabilityCount = 0
    const maxStabilityChecks = 5

    // 等待内容稳定
    while (stabilityCount < maxStabilityChecks) {
      await new Promise(resolve => setTimeout(resolve, 500))
      
      // 检查高度变化
      const currentHeight = document.documentElement.scrollHeight
      if (currentHeight === previousHeight) {
        stabilityCount++
      } else {
        stabilityCount = 0
        previousHeight = currentHeight
      }

      // 检查动态加载指示器
      const loadingElements = document.querySelectorAll([
        '.loading', // 常见的加载类名
        '[data-loading]',
        '.infinite-loading',
        '.spinner',
        // B站特定的加载指示器
        '.bili-spinner',
        '.loading-state'
      ].join(','))

      if (loadingElements.length > 0) {
        stabilityCount = 0 // 重置稳定计数
      }
    }

    return true
  })
}

async function scrollAndWaitForContent(page: Page, targetPosition: number): Promise<boolean> {
  return page.evaluate(async (target: number) => {
    // 定义平滑滚动函数
    const smoothScroll = async () => {
      const startPosition = window.pageYOffset
      const distance = target - startPosition
      const duration = 1000
      const steps = 20
      const stepTime = duration / steps

      for (let i = 0; i <= steps; i++) {
        const progress = i / steps
        const currentPosition = startPosition + (distance * progress)
        window.scrollTo(0, currentPosition)
        
        // 触发滚动事件
        window.dispatchEvent(new Event('scroll'))
        
        await new Promise(resolve => setTimeout(resolve, stepTime))
      }
    }

    // 执行滚动
    await smoothScroll()

    // 检查是否到达目标位置
    const finalPosition = window.pageYOffset
    const viewportHeight = window.innerHeight
    const pageHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      document.documentElement.offsetHeight
    )

    // 更宽松的滚动检查条件
    const isNearBottom = finalPosition + viewportHeight >= pageHeight - viewportHeight
    // 如果未能达到目标位置，但仍在可接受范围内
    const reachedTarget = Math.abs(finalPosition - target) < viewportHeight

    // 对于静态网站，只要没到底部就继续
    return !isNearBottom
  }, targetPosition)
}

// 添加网站类型检测函数
async function detectWebsiteType(page: Page, url: string): Promise<'dynamic' | 'static' | 'spa'> {
  // 检查是否为已知的动态网站
  const dynamicSites = [
    'bilibili.com',
    'zhihu.com',
    'weibo.com',
    'douyin.com'
  ]
  
  if (dynamicSites.some(site => url.includes(site))) {
    return 'dynamic'
  }

  // 检查是否为单页应用
  const isSPA = await page.evaluate(() => {
    return (
      typeof window.history.pushState === 'function' &&
      !!document.querySelector('div[id="app"], div[id="root"]')
    )
  })
  
  if (isSPA) {
    return 'spa'
  }

  return 'static'
}

// 添加页面加载完成检测函数
async function waitForPageLoad(page: Page, websiteType: 'dynamic' | 'static' | 'spa'): Promise<void> {
  switch (websiteType) {
    case 'dynamic':
      // 动态网站需要等待更长时间和更多条件
      await Promise.race([
        Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => {}),
          page.waitForFunction(() => {
            const loadingElements = document.querySelectorAll(
              '.loading, .loader, .spinner, [data-loading], .infinite-loading, .bili-spinner, .loading-state'
            )
            return loadingElements.length === 0
          }, { timeout: 15000 }).catch(() => {})
        ]),
        page.waitForTimeout(15000) // 最大等待时间
      ])
      break
      
    case 'spa':
      // SPA 需要等待前端路由和数据加载
      await Promise.race([
        Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {}),
          page.waitForFunction(() => {
            return !document.querySelector('.loading, .loader, .spinner')
          }, { timeout: 10000 }).catch(() => {})
        ]),
        page.waitForTimeout(10000)
      ])
      break
      
    case 'static':
      // 静态网站只需等待基本加载
      await page.waitForNavigation({ 
        waitUntil: ['domcontentloaded', 'networkidle0'],
        timeout: 8000 
      }).catch(() => {})
      break
  }
}

async function takeScreenshot(url: string, fullPage: boolean, retryCount = 0): Promise<{ screenshot: string; isEnd: boolean }> {
  let browser: Browser | null = null
  
  try {
    const executablePath = await chrome()
    browser = await puppeteer.launch({
      executablePath,
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-extensions-with-background-pages',
        '--disable-extensions',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--enable-features=NetworkService,NetworkServiceInProcess',
        '--force-color-profile=srgb',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-experiments',
        '--no-pings',
        '--ignore-certificate-errors',
        '--ignore-ssl-errors',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ],
      defaultViewport: {
        width: 1920,
        height: 1080,
        deviceScaleFactor: 1,
      },
      protocolTimeout: 30000,
    })

    const page = await browser.newPage()
    
    // 设置更长的导航超时
    await page.setDefaultNavigationTimeout(30000)
    await page.setDefaultTimeout(30000)

    // 设置额外的请求头
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    })

    // 启用 JavaScript
    await page.setJavaScriptEnabled(true)

    // 设置 cookie
    await page.setCookie({
      name: 'CONSENT',
      value: 'YES+',
      domain: '.bilibili.com',
    })

    // 访问页面
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    // 检测网站类型
    const websiteType = await detectWebsiteType(page, url)
    console.log('Detected website type:', websiteType)

    // 等待页面加载完成
    await waitForPageLoad(page, websiteType)

    // 获取上次滚动位置
    const lastPosition = globalScrollPositions[url] || 0
    console.log('Last scroll position:', lastPosition)

    // 获取初始页面信息
    const { viewportHeight, initialHeight } = await page.evaluate(() => ({
      viewportHeight: window.innerHeight,
      initialHeight: document.documentElement.scrollHeight
    }))

    // 根据网站类型采用不同的截图策略
    if (websiteType === 'dynamic') {
      // 动态网站需要预加载内容
      await page.evaluate(async () => {
        const scrollStep = 200
        let lastScroll = 0
        
        while (true) {
          window.scrollBy(0, scrollStep)
          await new Promise(resolve => setTimeout(resolve, 100))
          
          const currentScroll = window.pageYOffset
          if (currentScroll === lastScroll) {
            break
          }
          lastScroll = currentScroll
        }
        
        window.scrollTo(0, 0)
      })
      
      // 等待动态内容加载
      await waitForDynamicContent(page)
    }

    // 计算新的滚动位置
    const newPosition = lastPosition + viewportHeight
    console.log('New scroll position:', newPosition)

    // 根据网站类型执行滚动
    if (websiteType === 'dynamic' || websiteType === 'spa') {
      await scrollAndWaitForContent(page, lastPosition)
      await waitForDynamicContent(page)
      const canContinueScroll = await scrollAndWaitForContent(page, newPosition)
      await waitForDynamicContent(page)

      if (!canContinueScroll) {
        console.log('Reached the bottom of dynamic/spa content')
        await browser.close()
        return {
          screenshot: '',
          isEnd: true
        }
      }
    } else {
      // 静态网站使用简单的滚动检查
      await page.evaluate((pos) => window.scrollTo(0, pos), newPosition)
      await page.waitForTimeout(500)
      
      // 检查是否到达页面底部
      const isAtBottom = await page.evaluate(() => {
        const scrollPosition = window.pageYOffset + window.innerHeight
        const totalHeight = document.documentElement.scrollHeight
        const isAtVeryBottom = scrollPosition >= totalHeight - 10
        const hasScrolled = window.pageYOffset > 0
        // 只有当真正到达底部并且已经滚动过才返回true
        return isAtVeryBottom && hasScrolled
      })
      
      if (isAtBottom) {
        console.log('Reached the bottom of static content')
        await browser.close()
        return {
          screenshot: '',
          isEnd: true
        }
      }
    }

    // 获取最终页面高度和当前滚动位置
    const { finalHeight, currentScrollY } = await page.evaluate(() => ({
      finalHeight: document.documentElement.scrollHeight,
      currentScrollY: window.pageYOffset
    }))

    // 静态页面不检查内容变化
    if (websiteType !== 'static' && (finalHeight < initialHeight || finalHeight === 0)) {
      console.log('No valid content detected')
      await browser.close()
      return {
        screenshot: '',
        isEnd: true
      }
    }

    // 保存新的滚动位置
    globalScrollPositions[url] = newPosition
    console.log('Saved new scroll position:', newPosition)

    // 截图当前视口
    const screenshot = await page.screenshot({
      fullPage: false,
      type: 'png',
      optimizeForSpeed: true,
      encoding: 'base64',
      clip: {
        x: 0,
        y: lastPosition === 0 ? 0 : currentScrollY, // 如果是第一次截图，从顶部开始；否则使用当前滚动位置
        width: 1920,
        height: viewportHeight
      }
    })

    await browser.close()
    return {
      screenshot: screenshot as string,
      isEnd: false
    }

  } catch (error) {
    if (browser) {
      await browser.close()
    }

    if (retryCount < MAX_RETRIES) {
      console.log(`Retrying screenshot (${retryCount + 1}/${MAX_RETRIES})...`)
      await sleep(RETRY_DELAY)
      return takeScreenshot(url, fullPage, retryCount + 1)
    }

    throw error
  }
}

export async function POST(request: Request) {
  const { url, fullPage = false } = await request.json()
  
  try {
    const result = await takeScreenshot(url, fullPage)
    return Response.json({ 
      success: true, 
      screenshot: result.screenshot,
      isEnd: result.isEnd 
    })
  } catch (error: any) {
    console.error('Screenshot error:', error)
    return Response.json({ success: false, error: error.message })
  }
}

export async function DELETE(request: Request) {
  // 清除滚动位置记录
  Object.keys(globalScrollPositions).forEach(key => {
    delete globalScrollPositions[key]
  })
  return Response.json({ success: true })
} 