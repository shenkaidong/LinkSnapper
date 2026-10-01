import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { getInvalidEnvChromePaths } from '../src/utils/chrome.ts'

const KEYS = ['CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH', 'CHROME_BIN'] as const

describe('getInvalidEnvChromePaths', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = {}
    for (const key of KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  test('未设置任何环境变量时返回空数组', () => {
    assert.deepEqual(getInvalidEnvChromePaths(), [])
  })

  test('指向真实存在的文件时不算无效', () => {
    // process.execPath 是当前 node 可执行文件，必然存在
    process.env.CHROME_PATH = process.execPath
    assert.deepEqual(getInvalidEnvChromePaths(), [])
  })

  // 这条是核心回归用例：以前这种「显式配置写错」会被静默忽略，
  // 服务照常启动、只是悄悄换了个浏览器，问题极难排查。
  test('环境变量已设置但文件不存在时会被列出', () => {
    process.env.CHROME_PATH = '/definitely/not/here/chrome'
    assert.deepEqual(getInvalidEnvChromePaths(), ['CHROME_PATH=/definitely/not/here/chrome'])
  })

  test('多个无效配置都会被列出', () => {
    process.env.CHROME_PATH = '/not/here/chrome'
    process.env.CHROME_BIN = '/also/not/here/chrome'
    const invalid = getInvalidEnvChromePaths()
    assert.equal(invalid.length, 2)
    assert.ok(invalid.includes('CHROME_PATH=/not/here/chrome'))
    assert.ok(invalid.includes('CHROME_BIN=/also/not/here/chrome'))
  })
})
