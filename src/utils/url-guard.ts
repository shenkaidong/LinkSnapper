/**
 * 截图目标 URL 的安全校验。
 *
 * 截图服务本质上是一个「让服务器去访问任意地址」的能力，如果不做限制，
 * 任何人都可以用它去探测内网、读取云厂商元数据接口（如 169.254.169.254），
 * 也就是典型的 SSRF。
 *
 * 这里分成两层，缺一不可：
 *
 *   1. 字面量校验（同步）—— 看用户填进来的那串字符本身是否合法、是否直指内网 IP。
 *   2. 解析后校验（异步）—— 域名语法上完全合法，但 DNS 记录可能指向内网，
 *      或者页面在跳转 / 加载子资源时才暴露真实目标。这一层必须放在浏览器
 *      的请求拦截里做，否则拦不住重定向与子资源。
 *
 * 只做第 1 层是最常见的错误做法：它挡得住 `http://10.0.0.1/`，
 * 但挡不住 `https://evil.com/r` → 302 → `http://169.254.169.254/`。
 */

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

// 显式带协议头（scheme://）的输入
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

// 明确危险的协议。必须在「自动补 https://」之前拦掉，
// 否则 file:///etc/passwd 会被改写成 https://file///etc/passwd，
// 最后只是碰巧因为域名解析失败而报错 —— 那不是护栏生效。
const DANGEROUS_SCHEME =
  /^(javascript|data|vbscript|file|blob|about|chrome|chrome-extension|ftp|ftps|ws|wss|gopher|dict|telnet|ldap|jar|view-source):/i

/** 常见的内部专用后缀，正常公网域名不会用 */
const INTERNAL_SUFFIXES = ['.local', '.internal', '.home.arpa', '.lan', '.corp', '.intranet']

/** 浏览器内部可能产生的伪协议，请求拦截时需要放行 */
export const SAFE_INTERNAL_PROTOCOLS = new Set(['data:', 'blob:', 'about:', 'filesystem:'])

/** 是否彻底放开内网访问（自建部署、确实需要截图内网站点时用） */
export function isPrivateNetworkAllowed(): boolean {
  return process.env.ALLOW_PRIVATE_NETWORK === 'true'
}

/**
 * 白名单放行的内网主机。
 * 兼顾两个场景：自建部署要截内网站点，以及测试时需要在 127.0.0.1 上起一个
 * 被测页面 —— 后者不应该把整个内网都放开。
 */
function allowedInternalHosts(): Set<string> {
  const raw = process.env.ALLOWED_INTERNAL_HOSTS || ''
  return new Set(
    raw
      .split(',')
      .map(item => item.trim().toLowerCase())
      .filter(Boolean)
  )
}

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map(part => Number(part))
  if (nums.some(num => !Number.isInteger(num) || num < 0 || num > 255)) return null
  return nums
}

/** 私有 / 保留 / 回环 IPv4 网段 */
export function isPrivateIPv4(ip: string): boolean {
  const nums = parseIPv4(ip)
  if (!nums) return false

  const [a, b] = nums

  if (a === 0) return true // 0.0.0.0/8 「本网络」
  if (a === 10) return true // 私有 10.0.0.0/8
  if (a === 127) return true // 回环 127.0.0.0/8
  if (a === 169 && b === 254) return true // 链路本地，含云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true // 私有 172.16.0.0/12
  if (a === 192 && b === 168) return true // 私有 192.168.0.0/16
  if (a === 192 && b === 0) return true // 保留 192.0.0.0/24 等
  if (a === 100 && b >= 64 && b <= 127) return true // 运营商级 NAT 100.64.0.0/10
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试网段 198.18.0.0/15
  if (a >= 224) return true // 组播 224/4 与保留 240/4

  return false
}

/**
 * 把 IPv6 地址展开成 8 组 16 位整数。
 *
 * 之所以不能靠字符串前缀判断：`::ffff:127.0.0.1` 经过 WHATWG URL 解析后
 * 会变成 `::ffff:7f00:1`（十六进制形式），前缀匹配完全看不出来，
 * 但它访问的就是 127.0.0.1。必须按数值展开后再判断。
 */
function expandIPv6(ip: string): number[] | null {
  let value = ip.toLowerCase().split('%')[0] // 去掉可能的 zone id

  // 尾部内嵌的 IPv4 写法（::ffff:127.0.0.1）先换算成两组十六进制
  const embedded = value.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (embedded) {
    const nums = parseIPv4(embedded[1])
    if (!nums) return null
    const hex = `${(((nums[0] << 8) | nums[1]) >>> 0).toString(16)}:${(((nums[2] << 8) | nums[3]) >>> 0).toString(16)}`
    value = value.slice(0, value.length - embedded[1].length) + hex
  }

  const halves = value.split('::')
  if (halves.length > 2) return null

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return []
    const groups = part.split(':')
    const nums: number[] = []
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      nums.push(Number.parseInt(group, 16))
    }
    return nums
  }

  const head = parseGroups(halves[0])
  const tail = halves.length === 2 ? parseGroups(halves[1]) : []
  if (!head || !tail) return null

  if (halves.length === 1) {
    return head.length === 8 ? head : null
  }

  const missing = 8 - head.length - tail.length
  if (missing < 0) return null

  const zeros: number[] = []
  for (let i = 0; i < missing; i++) zeros.push(0)

  return head.concat(zeros, tail)
}

function groupsToIPv4(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

/** 私有 / 保留 IPv6 地址 */
export function isPrivateIPv6(ip: string): boolean {
  const groups = expandIPv6(ip)
  if (!groups) return false

  const prefixAllZero = (count: number) => groups.slice(0, count).every(group => group === 0)

  // :: （未指定）与 ::1 （回环）
  if (groups.every(group => group === 0)) return true
  if (prefixAllZero(7) && groups[7] === 1) return true

  // ::ffff:0:0/96 IPv4 映射地址
  if (prefixAllZero(5) && groups[5] === 0xffff) {
    return isPrivateIPv4(groupsToIPv4(groups[6], groups[7]))
  }

  // ::/96 IPv4 兼容地址（已废弃，但仍可解析）
  if (prefixAllZero(6)) {
    return isPrivateIPv4(groupsToIPv4(groups[6], groups[7]))
  }

  // 64:ff9b::/96 NAT64，同样内嵌 IPv4
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    return isPrivateIPv4(groupsToIPv4(groups[6], groups[7]))
  }

  // 2002::/16 6to4，内嵌的 IPv4 位于第 2、3 组
  if (groups[0] === 0x2002) {
    return isPrivateIPv4(groupsToIPv4(groups[1], groups[2]))
  }

  // fc00::/7 唯一本地地址
  if ((groups[0] & 0xfe00) === 0xfc00) return true
  // fe80::/10 链路本地
  if ((groups[0] & 0xffc0) === 0xfe80) return true
  // fec0::/10 已废弃的站点本地地址
  if ((groups[0] & 0xffc0) === 0xfec0) return true
  // ff00::/8 组播
  if ((groups[0] & 0xff00) === 0xff00) return true

  return false
}

/** 统一入口：给一个 IP 字面量，判断是否属于内网 / 保留地址 */
export function isPrivateIP(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isPrivateIPv4(ip)
  if (version === 6) return isPrivateIPv6(ip)
  return false
}

/**
 * 同步判断主机名是否指向内网。
 * 只做字面量判断，不看 DNS —— 请求拦截里每个资源都要跑，必须够快。
 */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')

  if (!host) return true
  if (allowedInternalHosts().has(host)) return false

  // localhost 本身、*.localhost，以及某些发行版里作为本机别名的 localhost.localdomain
  if (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('localhost.')) return true
  if (INTERNAL_SUFFIXES.some(suffix => host.endsWith(suffix))) return true

  const version = isIP(host)
  if (version === 4) return isPrivateIPv4(host)
  if (version === 6) return isPrivateIPv6(host)

  // 不是 IP 也不是明显的内部域名，交给 DNS 层判断
  return false
}

// ---------------------------------------------------------------------------
// DNS 层：域名语法合法，但解析结果可能是内网地址（DNS 重绑定）
// ---------------------------------------------------------------------------

const DNS_CACHE_TTL_MS = 60_000
const DNS_CACHE_MAX_ENTRIES = 500
const DNS_LOOKUP_TIMEOUT_MS = 3_000
const dnsCache = new Map<string, { expiresAt: number; isPrivate: boolean }>()

/**
 * 解析主机名，判断它最终指向的地址是否落在内网。
 *
 * 注意两点：
 *  - 结果做 60s 缓存，因为请求拦截会对每个资源调用，不能每次都真去查 DNS。
 *  - 解析失败时返回 false（不拦截）。DNS 抖动、域名打错这些情况，
 *    后面的导航自己会失败并给出更准确的错误信息；在这里拦会把正常故障
 *    误报成安全拦截，反而误导用户。
 */
export async function isHostnameResolvingToPrivate(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (!host) return true

  // 显式白名单的主机直接放行，不必再查 DNS
  if (allowedInternalHosts().has(host)) return false

  const version = isIP(host)
  if (version === 4) return isPrivateIPv4(host)
  if (version === 6) return isPrivateIPv6(host)

  const cached = dnsCache.get(host)
  if (cached && cached.expiresAt > Date.now()) return cached.isPrivate

  let isPrivate = false
  try {
    // 加超时：请求拦截会等这个结果，DNS 卡住时不能把整个页面一起拖死。
    // 超时按「未发现内网地址」处理，此时导航本身大概率也会失败。
    const records = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('DNS_LOOKUP_TIMEOUT')), DNS_LOOKUP_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
    isPrivate = records.some(record => isPrivateIP(record.address))
  } catch {
    isPrivate = false
  }

  if (dnsCache.size >= DNS_CACHE_MAX_ENTRIES) {
    // 简单粗暴地清理过期项，避免缓存无限增长
    const now = Date.now()
    const expired: string[] = []
    // 用 forEach 而不是 for...of：tsconfig 的 target 是 es5，直接迭代 Map 编译不过
    dnsCache.forEach((entry, key) => {
      if (entry.expiresAt <= now) expired.push(key)
    })
    expired.forEach(key => dnsCache.delete(key))

    if (dnsCache.size >= DNS_CACHE_MAX_ENTRIES) dnsCache.clear()
  }

  dnsCache.set(host, { expiresAt: Date.now() + DNS_CACHE_TTL_MS, isPrivate })
  return isPrivate
}

/** 仅供测试使用：清空 DNS 缓存，避免用例之间互相影响 */
export function clearDnsCache(): void {
  dnsCache.clear()
}

// ---------------------------------------------------------------------------
// 对外主入口
// ---------------------------------------------------------------------------

/**
 * 校验用户传入的 URL，不通过则直接抛错。
 * 这里只做字面量与协议判断，DNS 与重定向层面由浏览器请求拦截兜底。
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

  // new URL 会把 http://2130706433/ 这类畸形写法规范成 http://127.0.0.1/，
  // 所以走到这里再做 IP 判断是安全的，不会有漏网的十进制 / 八进制写法。
  if (!isPrivateNetworkAllowed() && isBlockedHostname(parsed.hostname)) {
    throw new Error('出于安全考虑，禁止截图内网或本机地址')
  }

  return parsed
}
