/**
 * 仅用于端到端验证「重定向型 SSRF 是否被拦住」的辅助接口。
 *
 * 为什么需要它：请求拦截这道防线的价值就在于「页面自己跳去内网」，
 * 而这种跳转必须由服务端真实发出一个 302 才能复现 —— 静态页面做不到。
 *
 * 安全性考虑（这个接口默认是关闭且受限的）：
 *   - 未设置 ENABLE_TEST_ENDPOINTS=1 时直接返回 404，生产环境不会暴露；
 *   - 即使被打开，也只允许跳到固定的几个内网探针地址，
 *     不是任意 open redirect，误开的代价被限制在最小范围。
 */

const ALLOWED_PROBE_TARGETS = ['http://169.254.169.254/', 'http://10.0.0.5/', 'http://127.0.0.2/']

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  if (process.env.ENABLE_TEST_ENDPOINTS !== '1') {
    return new Response('Not Found', { status: 404 })
  }

  const raw = new URL(request.url).searchParams.get('to')
  if (!raw) {
    return new Response('Missing "to" parameter', { status: 400 })
  }

  // 允许两类目标：固定的内网探针（用来验证会被拦），
  // 以及站内相对路径（用来做反向对照，证明 302 本身确实被正常跟随了）。
  // 除此之外一律拒绝，避免变成一个开放的任意跳转。
  const allowed = raw.startsWith('/') || ALLOWED_PROBE_TARGETS.some(prefix => raw.startsWith(prefix))
  if (!allowed) {
    return new Response('Only internal probes and same-origin paths are allowed', { status: 403 })
  }

  return new Response(null, {
    status: 302,
    headers: { Location: raw, 'Cache-Control': 'no-store' },
  })
}
