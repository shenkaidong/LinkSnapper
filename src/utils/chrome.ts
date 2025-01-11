import { join } from 'path'
import { existsSync } from 'fs'

const chromePaths = [
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable'
]

export default async function getChromePath(): Promise<string> {
  // 首先检查环境变量
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH
  }

  // 检查常见路径
  for (const path of chromePaths) {
    if (existsSync(path)) {
      return path
    }
  }

  throw new Error('Could not find Chrome installation. Please set CHROME_PATH environment variable.')
} 