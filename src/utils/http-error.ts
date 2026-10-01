/** 带 HTTP 状态码的错误，方便在接口层统一映射成响应 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

const MAX_BODY_BYTES = 16 * 1024

/**
 * 带大小上限地读取请求体。
 *
 * 不能直接用 `request.json()`：它会无条件把整个 body 读进内存，
 * 一个几百 MB 的请求就能把进程打满。这里边读边计数，超限立刻中止。
 */
export async function readJsonBody(request: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') || 0)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, '请求体过大')
  }

  const body = request.body
  if (!body) return {}

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new HttpError(413, '请求体过大')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }

  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}

  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON')
  }
}
