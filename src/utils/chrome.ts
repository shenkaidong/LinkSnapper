import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'

/**
 * 按优先级列出候选的 Chrome / Chromium 可执行文件路径。
 *
 * 解析顺序（见 getChromePath）：
 *   1. 显式环境变量（CHROME_PATH / PUPPETEER_EXECUTABLE_PATH / CHROME_BIN）
 *      —— Docker / CI / 自建部署靠这个，最稳。
 *   2. 由 scripts/install-chrome.mjs 写出的 .chrome-executable-path 标记文件
 *      —— 保证「装哪个版本就用哪个版本」，不被系统里其它 Chrome 抢走。
 *   3. 各操作系统的常见安装位置（含 Chrome for Testing、Chromium、snap 等）。
 *
 * 注意 Windows 路径必须用 path.join 拼接 —— 手写反斜杠在 JS 字符串里会被当成转义符吞掉。
 */

// 与 scripts/install-chrome.mjs / puppeteer-core 锁定的一致；用于出错提示。
const EXPECTED_CHROME_VERSION = '121.0.6167.85'

const ENV_KEYS = ['CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH', 'CHROME_BIN'] as const

/** 显式环境变量里能指向 Chrome 的几个键 */
function envChromePath(): string | null {
  for (const key of ENV_KEYS) {
    const value = process.env[key]
    if (value && existsSync(value)) return value
  }
  return null
}

/**
 * 已设置、但指向的文件并不存在的环境变量。
 *
 * 这些是「显式配置写错了」。以前的做法是静默忽略并回退到系统 Chrome，
 * 后果很隐蔽：比如运维想通过 CHROME_PATH 钉死版本，路径打错之后服务照常启动，
 * 只是悄悄换成了系统里另一个版本的浏览器 —— 表现为「偶发截图异常」，
 * 很难联想到配置错误。现在的策略是照常回退（保证可用性），但必须大声告警。
 */
export function getInvalidEnvChromePaths(): string[] {
  const invalid: string[] = []
  for (const key of ENV_KEYS) {
    const value = process.env[key]
    if (value && !existsSync(value)) invalid.push(`${key}=${value}`)
  }
  return invalid
}

let warnedInvalidEnv = false

/** 回退前告警一次。返回当前仍然无效的配置项 */
function warnInvalidEnvOnce(): string[] {
  const invalid = getInvalidEnvChromePaths()
  if (invalid.length && !warnedInvalidEnv) {
    warnedInvalidEnv = true
    console.warn(
      `[chrome] 以下环境变量已设置但指向的文件不存在，已忽略并回退到其他候选路径：` +
        `${invalid.join(', ')}。若这是笔误，实际使用的可能是另一个版本的浏览器。`
    )
  }
  return invalid
}

/** 读 install-chrome.mjs 写出的标记文件 */
function markerChromePath(): string | null {
  try {
    const marker = join(process.cwd(), '.chrome-executable-path')
    if (existsSync(marker)) {
      const path = readFileSync(marker, 'utf8').trim()
      if (path && existsSync(path)) return path
    }
  } catch {
    // 标记文件缺失或损坏都不影响后续兜底逻辑
  }
  return null
}

function osCandidates(): string[] {
  const list: string[] = []

  if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    )
  } else if (process.platform === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    const localAppData = process.env['LOCALAPPDATA']

    list.push(
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFiles, 'Google', 'Chrome for Testing', 'Application', 'chrome.exe'),
      join(programFiles, 'Chromium', 'Application', 'chrome.exe')
    )
    if (localAppData) {
      list.push(
        join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(localAppData, 'Chromium', 'Application', 'chrome.exe')
      )
    }
  } else {
    list.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome-for-testing',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/opt/google/chrome/chrome',
      '/opt/chrome-for-testing/chrome'
    )
  }

  return list
}

export default async function getChromePath(): Promise<string> {
  // 1) 显式环境变量
  const fromEnv = envChromePath()
  if (fromEnv) return fromEnv

  // 显式配置存在但不可用：照常回退，但必须告警（见 warnInvalidEnvOnce 的说明）
  warnInvalidEnvOnce()

  // 2) install-chrome.mjs 的标记文件
  const fromMarker = markerChromePath()
  if (fromMarker) return fromMarker

  // 3) 操作系统常见位置
  for (const candidate of osCandidates()) {
    if (candidate && existsSync(candidate)) {
      return candidate
    }
  }

  const tried = [
    ...(envChromePath() ? ['（环境变量已设置但文件不存在）'] : []),
    ...osCandidates().map(p => `  - ${p}`),
  ].join('\n')

  throw new Error(
    `未找到可用的 Chrome / Chromium 可执行文件。\n` +
      `已尝试以下路径：\n${tried}\n\n` +
      `任选一种解决方式：\n` +
      `  1) 安装 Chrome，并通过环境变量指定路径：\n` +
      `     export CHROME_PATH=/path/to/chrome\n` +
      `  2) 或直接安装与本项目配套的 Chrome for Testing（推荐，版本锁定为 ${EXPECTED_CHROME_VERSION}）：\n` +
      `     node scripts/install-chrome.mjs\n`
  )
}

export interface ChromeStatus {
  /** 是否找到了可用的 Chrome 可执行文件 */
  ready: boolean
  /** 解析到的可执行文件路径（找不到时为 null） */
  path: string | null
  /** 本项目配套的 Chrome 版本（puppeteer-core 锁定） */
  expectedVersion: string
  /** 实际可执行文件的版本（探测失败时 null）；与 expectedVersion 不完全一致不一定致命 */
  actualVersion: string | null
  /** 已设置但文件不存在的环境变量（如 CHROME_PATH 写错），用于暴露「配置被静默忽略」 */
  invalidEnvPaths: string[]
  /** 不可用时的人类可读原因 */
  error: string | null
}

/** 读 Chrome 自报的版本号（best-effort，5s 超时） */
function readChromeVersion(executablePath: string): Promise<string | null> {
  return new Promise(resolve => {
    const proc = spawn(executablePath, ['--version'], { timeout: 5000 })
    let out = ''
    proc.stdout.on('data', chunk => {
      out += String(chunk)
    })
    proc.on('error', () => resolve(null))
    proc.on('close', () => resolve(out.trim() || null))
  })
}

/**
 * 供 /api/health 之类观测接口使用：在不拉起浏览器的情况下，
 * 报告 Chrome 是否就绪、实际路径与版本，方便编排系统在「没装 Chrome」时
 * 不把流量路由过来（而不是等首请求才 503）。
 */
export async function getChromeStatus(): Promise<ChromeStatus> {
  let path: string | null = null
  try {
    path = await getChromePath()
  } catch (error) {
    return {
      ready: false,
      path: null,
      expectedVersion: EXPECTED_CHROME_VERSION,
      actualVersion: null,
      invalidEnvPaths: getInvalidEnvChromePaths(),
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const actualVersion = await readChromeVersion(path)
  return {
    ready: true,
    path,
    expectedVersion: EXPECTED_CHROME_VERSION,
    actualVersion,
    invalidEnvPaths: getInvalidEnvChromePaths(),
    error: null,
  }
}
