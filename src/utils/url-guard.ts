/**
 * 截图目标 URL 的安全校验。
 *
 * 截图服务本质上是一个「让服务器去访问任意地址」的能力，如果不做限制，
 * 任何人都可以用它去探测内网、读取云厂商元数据接口（如 169.254.169.254），
 * 也就是典型的 SSRF。这里做最小必要的拦截。
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

// 显式带协议头（scheme://）的输入
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

// 明确危险的协议。必须在「自动补 https://」之前拦掉，
// 否则 file:///etc/passwd 会被改写成 https://file///etc/passwd，
// 最后只是碰巧因为域名解析失败而报错 —— 那不是护栏生效。
const DANGEROUS_SCHEME =
  /^(javascript|data|vbscript|file|blob|about|chrome|chrome-extension|ftp|ftps|ws|wss|gopher|dict|telnet):/i

// 私有 / 保留网段与回环地址（针对域名或 IPv4，注意这里不能放 IPv6 前缀，
// 否则 fda.gov、fcbarcelona.com 这类正常域名会被误杀）
const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^.*\.localhost$/i,
  /^127\./,                  // IPv4 回环 127.0.0.0/8
  /^0\./,                    // 0.0.0.0/8
  /^10\./,                   // 私有 10.0.0.0/8
  /^169\.254\./,             // 链路本地，含云元数据 169.254.169.254
  /^172\.(1[6-9]|2\d|3[01])\./, // 私有 172.16.0.0/12
  /^192\.168\./,             // 私有 192.168.0.0/16
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 运营商级 NAT 100.64.0.0/10
]

// 这些前缀只在确认对方是 IPv6 字面量时才使用
const BLOCKED_IPV6_PREFIXES = [
  '::1',      // 回环
  'fc',       // 唯一本地地址 fc00::/7
  'fd',
  'fe80',     // 链路本地
]

/** 是否允许访问内网地址（自建部署时可能确实需要截图内网站点） */
function isPrivateNetworkAllowed(): boolean {
  return process.env.ALLOW_PRIVATE_NETWORK === 'true'
}

/**
 * 校验 URL 是否可以被截图服务访问，不通过则直接抛错。
 */
export function assertSafeUrl(input: unknown): URL {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('缺少有效的 url 参数')
  }

  const raw = input.trim()

  if (DANGEROUS_SCHEME.test(raw)) {
    throw new Error('仅支持 http 与 https 协议的地址')
  }

  // 容忍用户不写协议头的情况，但已经是 scheme:// 形式的原样保留，
  // 交给下面的协议白名单判断，避免把非法协议悄悄改写成 https。
  const normalized = HAS_SCHEME.test(raw) ? raw : `https://${raw}`

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error('URL 格式不正确，请检查后重试')
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('仅支持 http 与 https 协议的地址')
  }

  if (!parsed.hostname || !parsed.hostname.replace(/^\[|\]$/g, '')) {
    throw new Error('URL 缺少有效的主机名')
  }

  if (parsed.username || parsed.password) {
    throw new Error('URL 中不允许携带用户名或密码')
  }

  if (!isPrivateNetworkAllowed()) {
    // URL.hostname 对 IPv6 会带方括号，这里剥掉方括号拿到裸主机名
    const host = parsed.hostname.replace(/^\[|\]$/g, '')
    const isIpv6Literal = parsed.hostname.startsWith('[') || host.includes(':')

    const blocked =
      BLOCKED_HOST_PATTERNS.some(pattern => pattern.test(host)) ||
      (isIpv6Literal && BLOCKED_IPV6_PREFIXES.some(prefix => host.toLowerCase().startsWith(prefix)))

    if (blocked) {
      throw new Error('出于安全考虑，禁止截图内网或本机地址')
    }
  }

  return parsed
}
