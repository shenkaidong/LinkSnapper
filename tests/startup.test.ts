import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseMajorVersion } from '../src/utils/startup.ts'

describe('parseMajorVersion', () => {
  test('解析纯版本号', () => {
    assert.equal(parseMajorVersion('121.0.6167.85'), 121)
    assert.equal(parseMajorVersion('154.0.8037.94'), 154)
  })

  // 这条是回归用例：chrome --version 的输出带 "Google Chrome " 前缀，
  // 早期实现用 split('.')[0] 会取到 "Google Chrome 154" → parseInt 得 NaN，
  // 导致版本不一致的告警被静默跳过，检查等于没生效。
  test('解析带前缀的版本输出', () => {
    assert.equal(parseMajorVersion('Google Chrome 154.0.8037.94'), 154)
    assert.equal(parseMajorVersion('Chromium 120.0.6099.109'), 120)
  })

  test('输入为空或无法解析时返回 null', () => {
    assert.equal(parseMajorVersion(null), null)
    assert.equal(parseMajorVersion(''), null)
    assert.equal(parseMajorVersion('unknown'), null)
  })
})
