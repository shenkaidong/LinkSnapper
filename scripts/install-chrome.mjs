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
 * ⚠️ 架构自愈（重要）
 * -------------------
 * Chrome-for-Testing **并不是每个版本都提供全部平台**的构建。实测：
 *   - 121.0.6167.85（puppeteer-core 21 锁定）：linux64 / mac-arm64 / mac-x64 / win32 / win64
 *   - 148.0.7778.97（puppeteer-core 24 锁定）：同样**没有** linux-arm64
 *   - 153+ 才开始提供 linux-arm64
 * 也就是说在 Linux ARM64（Apple Silicon 容器、AWS Graviton）上，
 * 「跟着 puppeteer 锁定版本走」是**无解**的 —— 下载器会把 x86_64 的二进制
 * 放进名为 linux_arm 的目录里，构建期看不出问题，运行时才报
 * `rosetta error: failed to open elf at /lib64/ld-linux-x86-64.so.2`。
 *
 * 所以这里做两件事：
 *   1. 显式把 platform 传给 install()（不传会走下载器自己的默认，可能下错架构）；
 *   2. 下载完成后**校验二进制的真实架构**，不匹配就自动回退到该平台确实存在的
 *      最新稳定版，并大声告警。
 *
 * 用法：
 *   node scripts/install-chrome.mjs                 # 装到 ~/.cache/puppeteer，并写 .chrome-executable-path
 *   CHROME_CACHE_DIR=/opt/chrome node scripts/install-chrome.mjs
 *
 * 脚本会把最终的可执行文件路径打印到 stdout（方便 CI 直接 `echo "CHROME_PATH=$(...)"`）。
 */

import { install, resolveBuildId, Browser, detectBrowserPlatform } from '@puppeteer/browsers'
import { writeFileSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// 必须与 puppeteer-core 锁定的 Chrome 版本一致。
// 升级 puppeteer-core 时，先查 node_modules/puppeteer-core/lib/.../revisions.js 里的
// PUPPETEER_REVISIONS.chrome，再同步改这里，否则会出现协议不匹配。
const CHROME_VERSION = process.env.CHROME_VERSION || '121.0.6167.85'

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

const ELF_MACHINE_X86_64 = 0x3e
const ELF_MACHINE_AARCH64 = 0xb7

/**
 * 读 Linux ELF 头里的 machine 字段，判断二进制的真实架构。
 * 只看目录名是不可靠的：观测到过目录叫 linux_arm-121... 但里面装的是 x86_64。
 */
function linuxElfMachine(executablePath) {
  let fd = -1
  try {
    fd = openSync(executablePath, 'r')
    const header = Buffer.alloc(20)
    readSync(fd, header, 0, 20, 0)

    // 不是 ELF（例如是个 shell 脚本包装器）就无法判断
    if (header.subarray(0, 4).toString('hex') !== '7f454c46') return null
    return header.readUInt16LE(18)
  } catch {
    return null
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

/** 当前进程期望的 ELF machine；非 Linux 返回 null（macOS 有 Rosetta 兜底，不校验） */
function expectedElfMachine() {
  if (process.platform !== 'linux') return null
  return process.arch === 'arm64' || process.arch === 'aarch64'
    ? ELF_MACHINE_AARCH64
    : ELF_MACHINE_X86_64
}

function machineName(machine) {
  if (machine === ELF_MACHINE_X86_64) return 'x86_64'
  if (machine === ELF_MACHINE_AARCH64) return 'arm64'
  return `未知(0x${machine?.toString(16)})`
}

async function main() {
  // 必须显式传给 install()：不传时下载器会用自己的默认平台，
  // 在跨架构构建（如在 arm64 机器上构建 amd64 镜像，或反之）时会下错架构。
  const platform = detectBrowserPlatform()
  console.error(
    `[install-chrome] 平台=${platform} 目标 Chrome=${CHROME_VERSION}（puppeteer-core ${puppeteerPinnedChrome()}）`
  )

  mkdirSync(cacheDir, { recursive: true })

  let installed = await install({
    browser: Browser.CHROME,
    buildId: CHROME_VERSION,
    cacheDir,
    platform,
  })

  // 架构校验 + 自愈回退
  const expected = expectedElfMachine()
  if (expected !== null) {
    let actual = linuxElfMachine(installed.executablePath)
    if (actual !== null && actual !== expected) {
      console.error(
        `[install-chrome] ⚠️ Chrome ${CHROME_VERSION} 在 ${platform} 上没有匹配当前架构的构建：` +
          `下载到的是 ${machineName(actual)}，但本机是 ${machineName(expected)}。` +
          `（Chrome-for-Testing 并非每个版本都提供全部平台，linux-arm64 是较晚才有的。）`
      )

      const fallback = await resolveBuildId(Browser.CHROME, platform, 'stable')
      console.error(`[install-chrome] 自动回退到该平台可用的稳定版：${fallback}`)
      installed = await install({
        browser: Browser.CHROME,
        buildId: fallback,
        cacheDir,
        platform,
      })

      actual = linuxElfMachine(installed.executablePath)
      if (actual !== null && actual !== expected) {
        throw new Error(
          `回退后的 Chrome ${fallback} 仍是 ${machineName(actual)}，与本机 ${machineName(expected)} 不匹配。` +
            `请检查 detectBrowserPlatform() 的判定，或用 CHROME_PATH 指定一个已装好的浏览器。`
        )
      }
      console.error(`[install-chrome] 回退成功，使用 ${fallback}`)
    }
  }

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
