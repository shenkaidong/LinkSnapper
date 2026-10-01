/**
 * 访问令牌校验的单元测试。
 *
 * 鉴权是安全控制，抽成纯函数就是为了能在这里自动验证，
 * 而不是靠「手工 curl 一遍看着像是对的」。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { isAuthorized, extractToken, safeEqual } from '../src/utils/auth.ts'

function requestWith(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/screenshot', { method: 'POST', headers })
}

describe('未配置令牌时一律放行', () => {
  test('expectedToken 为空字符串 → 放行', () => {
    assert.equal(isAuthorized(requestWith(), ''), true)
  })

  test('expectedToken 为 undefined → 放行', () => {
    assert.equal(isAuthorized(requestWith(), undefined), true)
  })

  test('expectedToken 只有空白 → 放行', () => {
    assert.equal(isAuthorized(requestWith(), '   '), true)
  })
})

describe('配置令牌后必须校验', () => {
  const TOKEN = 'test-token-value'

  test('无任何令牌头 → 拒绝', () => {
    assert.equal(isAuthorized(requestWith(), TOKEN), false)
  })

  test('Authorization: Bearer 正确 → 放行', () => {
    assert.equal(isAuthorized(requestWith({ authorization: `Bearer ${TOKEN}` }), TOKEN), true)
  })

  test('Bearer 前缀大小写不敏感 → 放行', () => {
    assert.equal(isAuthorized(requestWith({ authorization: `bearer ${TOKEN}` }), TOKEN), true)
    assert.equal(isAuthorized(requestWith({ authorization: `BEARER ${TOKEN}` }), TOKEN), true)
  })

  test('x-api-token 正确 → 放行', () => {
    assert.equal(isAuthorized(requestWith({ 'x-api-token': TOKEN }), TOKEN), true)
  })

  test('令牌错误 → 拒绝', () => {
    assert.equal(isAuthorized(requestWith({ authorization: 'Bearer wrong-token-value' }), TOKEN), false)
    assert.equal(isAuthorized(requestWith({ 'x-api-token': 'wrong' }), TOKEN), false)
  })

  test('令牌只差一个字符也要拒绝', () => {
    // 防止退化成前缀匹配之类的错误实现
    assert.equal(isAuthorized(requestWith({ 'x-api-token': TOKEN.slice(0, -1) }), TOKEN), false)
    assert.equal(isAuthorized(requestWith({ 'x-api-token': `${TOKEN}x` }), TOKEN), false)
  })

  test('空令牌头 → 拒绝', () => {
    assert.equal(isAuthorized(requestWith({ 'x-api-token': '' }), TOKEN), false)
    assert.equal(isAuthorized(requestWith({ authorization: 'Bearer ' }), TOKEN), false)
    assert.equal(isAuthorized(requestWith({ authorization: 'Bearer' }), TOKEN), false)
  })

  test('x-api-token 优先于非 Bearer 的 Authorization', () => {
    const request = requestWith({ authorization: 'Basic abc', 'x-api-token': TOKEN })
    assert.equal(isAuthorized(request, TOKEN), true)
  })

  test('两种头都错时拒绝', () => {
    const request = requestWith({ authorization: 'Bearer bad', 'x-api-token': 'also-bad' })
    assert.equal(isAuthorized(request, TOKEN), false)
  })
})

describe('extractToken', () => {
  test('去掉 Bearer 前缀与两侧空白', () => {
    assert.equal(extractToken(requestWith({ authorization: 'Bearer   abc  ' })), 'abc')
  })

  test('无令牌时返回空字符串而不是抛错', () => {
    assert.equal(extractToken(requestWith()), '')
  })
})

describe('safeEqual', () => {
  test('相同字符串为真', () => {
    assert.equal(safeEqual('abc', 'abc'), true)
  })

  test('不同内容为假', () => {
    assert.equal(safeEqual('abc', 'abd'), false)
  })

  test('长度不同不会抛错（摘要长度固定，所以能安全比较）', () => {
    assert.equal(safeEqual('a', 'aaaaaaaaaaaaaaaaaaaa'), false)
  })

  test('空字符串与空字符串为真', () => {
    assert.equal(safeEqual('', ''), true)
  })
})
