/**
 * 启动自检。
 *
 * 目的：把「环境没配好」这件事尽量提前到进程启动时暴露，而不是等第一个
 * 请求进来才 503。截图服务的依赖（Chrome 可执行文件、版本匹配、限流后端）
 * 都是静态的，启动时就能判断，没必要拿线上请求去试错。
 *
 * 默认只打印诊断、不阻断启动（fail-fast 是可选开关）—— 因为有些部署场景
 * 下 Chrome 是在容器启动后才挂载进来的，直接退出会让容器起不来。
 * 需要严格校验时设 STARTUP_FAIL_FAST=true。
 */

import { getChromeStatus } from './chrome.ts'

export interface StartupReport {
  chromeReady: boolean
  chromePath: string | null
  actualVersion: string | null
  expectedVersion: string
  versionMismatch: boolean
  failedFast: boolean
}

export function parseMajorVersion(version: string | null): number | null {
  if (!version) return null
  // 不能直接 split('.')[0]：chrome --version 的输出是
  // "Google Chrome 154.0.8037.94"，带前缀，那样取到的是 "Google Chrome 154"，
  // parseInt 得到 NaN，版本不一致的告警会被静默跳过（等于这个检查没生效）。
  // 这里取字符串里第一段连续数字。
  const matched = /(\d+)/.exec(version)
  if (!matched) return null
  const parsed = Number.parseInt(matched[1], 10)
  return Number.isFinite(parsed) ? parsed : null
}

export async function runStartupChecks(): Promise<StartupReport> {
  const chrome = await getChromeStatus()

  const report: StartupReport = {
    chromeReady: chrome.ready,
    chromePath: chrome.path,
    actualVersion: chrome.actualVersion,
    expectedVersion: chrome.expectedVersion,
    versionMismatch: false,
    failedFast: false,
  }

  if (chrome.ready) {
    console.log(`[startup] Chrome 就绪：${chrome.path}`)

    const actualMajor = parseMajorVersion(chrome.actualVersion)
    const expectedMajor = parseMajorVersion(chrome.expectedVersion)
    if (actualMajor !== null && expectedMajor !== null && actualMajor !== expectedMajor) {
      report.versionMismatch = true
      // 大版本不一致不必然失败（CDP 向后兼容性不错），但这是最容易埋雷的地方：
      // 典型症状是「服务能起来、截图偶发超时」，很难联想到版本问题，所以显式告警。
      console.warn(
        `[startup] Chrome 版本与 puppeteer-core 期望值不一致（实际 ${chrome.actualVersion}，` +
          `期望 ${chrome.expectedVersion}）。CDP 通常向后兼容，但建议执行 ` +
          `node scripts/install-chrome.mjs 安装匹配版本`
      )
    }
  } else {
    console.error(
      `[startup] 未找到可用的 Chrome，截图接口将返回 503。\n` +
        `[startup] 原因：${chrome.error ?? '未知'}\n` +
        `[startup] 修复：node scripts/install-chrome.mjs（安装与本项目匹配的 Chrome for Testing）\n` +
        `[startup]   或设置 CHROME_PATH=/path/to/chrome 指向已有浏览器`
    )
  }

  // 关键配置的可见性：这些开关决定服务的安全边界，启动时打出来便于审计
  const guards = {
    tokenRequired: Boolean(process.env.SCREENSHOT_API_TOKEN),
    privateNetworkBlocked: process.env.ALLOW_PRIVATE_NETWORK !== 'true',
    allowedInternalHosts: process.env.ALLOWED_INTERNAL_HOSTS || '',
    rateLimitMode: process.env.REDIS_URL ? 'redis' : 'memory',
    maxConcurrentCaptures: Number(process.env.MAX_CONCURRENT_CAPTURES) || 3,
  }
  console.log(`[startup] 运行时配置：${JSON.stringify(guards)}`)

  if (!chrome.ready && process.env.STARTUP_FAIL_FAST === 'true') {
    report.failedFast = true
    console.error('[startup] STARTUP_FAIL_FAST=true 且 Chrome 不可用，启动中止')
    process.exit(1)
  }

  return report
}
