import { existsSync } from 'fs'
import { join } from 'path'

/**
 * 按优先级列出候选的 Chrome / Chromium 可执行文件路径。
 * 注意 Windows 路径必须用 path.join 拼接 —— 手写反斜杠在 JS 字符串里会被当成转义符吞掉。
 */
function candidates(): string[] {
  const list: string[] = []

  // 显式指定的路径优先级最高（Docker / CI 场景靠这个）
  const fromEnv = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH
  if (fromEnv) list.push(fromEnv)

  if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    )
  } else if (process.platform === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    const localAppData = process.env['LOCALAPPDATA']

    list.push(
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe')
    )
    if (localAppData) {
      list.push(join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    }
  } else {
    list.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    )
  }

  return list
}

export default async function getChromePath(): Promise<string> {
  for (const candidate of candidates()) {
    if (candidate && existsSync(candidate)) {
      return candidate
    }
  }

  const tried = candidates().map(p => `  - ${p}`).join('\n')
  throw new Error(
    `未找到可用的 Chrome / Chromium 可执行文件。\n` +
      `已尝试以下路径：\n${tried}\n` +
      `请安装 Chrome，或通过环境变量 CHROME_PATH 指定可执行文件路径。`
  )
}
