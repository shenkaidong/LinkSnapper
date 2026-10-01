#!/usr/bin/env node
/**
 * 安装与 puppeteer-core 锁定版本匹配的 Chrome-for-Testing。
 *
 * 为什么需要这个脚本？
 * -------------------
 * 本项目用 puppeteer-core 驱动外部 Chrome，而 puppeteer-core 在
 * `node_modules/puppeteer-core/lib/.../revisions.js` 里**写死**了它配套的
 * Chrome 版本（21.11.0 → 121.0.6167.85）。如果环境里的 Chrome 版本对不上，
 * 轻则「页面能开但等待超时」，重则 DevTools 协议某些能力缺失、截图直接失败。
 *
 * 以前 Docker 用 Alpine 自带的 `chromium` 包、CI 用 `apt-get install chromium`，
 * 这些发行版包的版本会随基础镜像滚动，跟 puppeteer-core 错位只是时间问题。
 * 这里改成**显式下载与 puppeteer-core 锁定的同一个 Chrome 构建**，
 * 本地开发、CI、Docker、k8s 全部用同一个版本，从根本上消除版本耦合。
 *
 * 用法：
 *   node scripts/install-chrome.mjs                 # 装到 ~/.cache/puppeteer，并写 .chrome-executable-path
 *   CHROME_CACHE_DIR=/opt/chrome node scripts/install-chrome.mjs
 *
 * 脚本会把最终的可执行文件路径打印到 stdout（方便 CI 直接 `echo "CHROME_PATH=$(...)"`）。
 */

import { install, Browser, detectBrowserPlatform } from '@puppeteer/browsers'
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// 必须与 puppeteer-core 锁定的 Chrome 版本一致。
// 升级 puppeteer-core 时，先查 node_modules/puppeteer-core/lib/.../revisions.js 里的
// PUPPETEER_REVISIONS.chrome，再同步改这里，否则会出现协议不匹配。
const CHROME_VERSION = '121.0.6167.85'

const require = createRequire(import.meta.url)
function puppeteerPinnedChrome() {
  try {
    const pkg = require('puppeteer-core/package.json')
    return String(pkg.version)
  } catch {
    return 'unknown'
  }
}

const cacheDir = process.env.CHROME_CACHE_DIR || join(homedir(), '.cache', 'puppeteer')
const markerPath = process.env.CHROME_PATH_MARKER || join(process.cwd(), '.chrome-executable-path')

async function main() {
  const platform = detectBrowserPlatform()
  console.error(`[install-chrome] 平台=${platform} 目标 Chrome=${CHROME_VERSION}（puppeteer-core ${puppeteerPinnedChrome()}）`)

  mkdirSync(cacheDir, { recursive: true })

  const installed = await install({
    browser: Browser.CHROME,
    buildId: CHROME_VERSION,
    cacheDir,
  })

  const executablePath = installed.executablePath
  console.error(`[install-chrome] 已安装：${executablePath}`)

  // 把路径写给 chrome.ts 去发现（默认写在项目根，已被 .gitignore 忽略）。
  writeFileSync(markerPath, executablePath, 'utf8')

  // 唯一真正输出到 stdout 的是路径，方便 `CHROME_PATH=$(node scripts/install-chrome.mjs)`
  console.log(executablePath)
}

main().catch(error => {
  console.error('[install-chrome] 安装失败：', error)
  process.exit(1)
})
