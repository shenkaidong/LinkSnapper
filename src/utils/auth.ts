/**
 * 访问令牌校验。
 *
 * 抽成独立模块有两个原因：
 *   1. 可以脱离浏览器做纯函数测试（鉴权是安全控制，必须能自动验证）；
 *   2. 原来的实现用的是 `provided !== expected` 字符串比较 —— 这会在第一个
 *      不同的字符处提前返回，理论上可以按响应耗时逐位猜出令牌。
 *      这里改为先做 SHA-256 再常量时间比较，既消除了长度差异带来的信息泄露，
 *      也消除了比较过程本身的时间差异。
 */

import { createHash, timingSafeEqual } from 'node:crypto'

const BEARER_PREFIX = 'bearer '

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/** 常量时间字符串比较（对长度差异也不敏感，因为比较的是固定长度的摘要） */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b))
}

/** 从请求头里取出调用方提供的令牌，支持 Authorization: Bearer 与 x-api-token 两种写法 */
export function extractToken(request: Request): string {
  const authorization = request.headers.get('authorization') || ''
  if (authorization.toLowerCase().startsWith(BEARER_PREFIX)) {
    return authorization.slice(BEARER_PREFIX.length).trim()
  }

  return (request.headers.get('x-api-token') || '').trim()
}

/**
 * 判断请求是否通过鉴权。
 * 未配置 SCREENSHOT_API_TOKEN 时一律放行（本地开发、内网部署的默认状态）。
 */
export function isAuthorized(request: Request, expectedToken = process.env.SCREENSHOT_API_TOKEN): boolean {
  const expected = (expectedToken || '').trim()
  if (!expected) return true

  const provided = extractToken(request)
  if (!provided) return false

  return safeEqual(provided, expected)
}
