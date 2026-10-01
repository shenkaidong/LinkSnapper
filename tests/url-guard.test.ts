/**
 * url-guard 的单元测试。
 *
 * 这些函数是纯逻辑（不发网络请求、不起浏览器），所以可以秒级跑完，
 * 适合放进 CI 每次必跑 —— 冒烟测试要依赖真实浏览器，代价高得多。
 *
 * 运行：npm run test:unit
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertSafeUrl,
  isBlockedHostname,
  isPrivateIP,
  isPrivateIPv4,
  isPrivateIPv6,
  clearDnsCache,
} from '../src/utils/url-guard.ts'

let savedAllowedHosts: string | undefined
let savedAllowPrivate: string | undefined

beforeEach(() => {
  savedAllowedHosts = process.env.ALLOWED_INTERNAL_HOSTS
  savedAllowPrivate = process.env.ALLOW_PRIVATE_NETWORK
  delete process.env.ALLOWED_INTERNAL_HOSTS
  delete process.env.ALLOW_PRIVATE_NETWORK
  clearDnsCache()
})

afterEach(() => {
  if (savedAllowedHosts === undefined) delete process.env.ALLOWED_INTERNAL_HOSTS
  else process.env.ALLOWED_INTERNAL_HOSTS = savedAllowedHosts

  if (savedAllowPrivate === undefined) delete process.env.ALLOW_PRIVATE_NETWORK
  else process.env.ALLOW_PRIVATE_NETWORK = savedAllowPrivate

  clearDnsCache()
})

function expectRejected(input: unknown) {
  assert.throws(() => assertSafeUrl(input), Error, `应当拒绝该输入：${String(input)}`)
}

function expectAccepted(input: string): string {
  return assertSafeUrl(input).toString()
}

describe('IPv4 私有网段判定', () => {
  const privateAddresses = [
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254', // 云厂商元数据接口，SSRF 的头号目标
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.0.0.1',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
  ]

  const publicAddresses = ['1.1.1.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.63.0.1', '223.5.5.5']

  for (const ip of privateAddresses) {
    test(`${ip} 属于内网/保留地址`, () => {
      assert.equal(isPrivateIPv4(ip), true)
    })
  }

  for (const ip of publicAddresses) {
    test(`${ip} 属于公网地址`, () => {
      assert.equal(isPrivateIPv4(ip), false)
    })
  }
})

describe('IPv6 私有地址判定', () => {
  const privateAddresses = [
    '::1', // 回环
    '::', // 未指定
    'fc00::1', // 唯一本地 fc00::/7
    'fd12:3456::1',
    'fe80::1', // 链路本地
    'fec0::1', // 已废弃的站点本地
    'ff02::1', // 组播
    '::ffff:127.0.0.1', // IPv4 映射（点分形式）
    '::ffff:7f00:1', // IPv4 映射 —— WHATWG URL 规范化后的实际形态
    '::7f00:1', // IPv4 兼容形式
    '64:ff9b::127.0.0.1', // NAT64
    '64:ff9b::7f00:1',
    '2002:7f00:1::', // 6to4 内嵌 127.0.0.1
    '2002:a00:1::', // 6to4 内嵌 10.0.0.1
  ]

  const publicAddresses = [
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
    '64:ff9b::1.1.1.1',
    '2002:808:808::', // 6to4 内嵌 8.8.8.8
    'not-an-ipv6',
  ]

  for (const ip of privateAddresses) {
    test(`${ip} 属于内网/保留地址`, () => {
      assert.equal(isPrivateIPv6(ip), true)
    })
  }

  for (const ip of publicAddresses) {
    test(`${ip} 不属于内网地址`, () => {
      assert.equal(isPrivateIPv6(ip), false)
    })
  }
})

describe('isPrivateIP 按地址族分派', () => {
  test('IPv4 走 IPv4 分支', () => {
    assert.equal(isPrivateIP('10.0.0.1'), true)
    assert.equal(isPrivateIP('1.1.1.1'), false)
  })

  test('IPv6 走 IPv6 分支', () => {
    assert.equal(isPrivateIP('::1'), true)
    assert.equal(isPrivateIP('2001:4860::8888'), false)
  })

  test('非 IP 字面量返回 false', () => {
    assert.equal(isPrivateIP('example.com'), false)
  })
})

describe('assertSafeUrl —— 应放行', () => {
  test('自动补全协议头', () => {
    assert.equal(expectAccepted('example.com'), 'https://example.com/')
  })

  test('保留 http 协议', () => {
    assert.equal(expectAccepted('http://example.com/path'), 'http://example.com/path')
  })

  test('普通公网域名', () => {
    expectAccepted('https://en.wikipedia.org/wiki/Screenshot')
    expectAccepted('https://sub.domain.example.co.uk/a?b=1#c')
  })

  test('回环地址的文本前缀不应误伤真实域名', () => {
    // 早期实现用 /^f[cd]/ 判断 IPv6，把 fda.gov 也拦了
    expectAccepted('https://fda.gov/')
    expectAccepted('https://fcbarcelona.com/')
    expectAccepted('https://fcanet.example.com/')
  })

  test('ALLOWED_INTERNAL_HOSTS 可精确放行内网主机', () => {
    process.env.ALLOWED_INTERNAL_HOSTS = '127.0.0.1,internal.example'
    assert.equal(expectAccepted('http://127.0.0.1:3000/x'), 'http://127.0.0.1:3000/x')
    assert.equal(expectAccepted('http://internal.example/'), 'http://internal.example/')
  })

  test('ALLOW_PRIVATE_NETWORK=true 时全部放行', () => {
    process.env.ALLOW_PRIVATE_NETWORK = 'true'
    expectAccepted('http://10.0.0.1/')
    expectAccepted('http://169.254.169.254/')
  })
})

describe('assertSafeUrl —— 应拒绝', () => {
  test('缺失或非法的入参', () => {
    expectRejected(undefined)
    expectRejected(null)
    expectRejected('')
    expectRejected('   ')
    expectRejected(123)
    expectRejected({})
    expectRejected([])
  })

  test('危险协议（必须在补 https 之前拦下）', () => {
    expectRejected('file:///etc/passwd')
    expectRejected('file://localhost/etc/passwd')
    expectRejected('javascript:alert(1)')
    expectRejected('data:text/html,<script>alert(1)</script>')
    expectRejected('vbscript:msgbox(1)')
    expectRejected('ftp://example.com/x')
    expectRejected('gopher://example.com/')
    expectRejected('blob:https://example.com/uuid')
    expectRejected('about:blank')
  })

  test('内网与本机地址', () => {
    expectRejected('http://127.0.0.1:8080/admin')
    expectRejected('http://localhost/')
    expectRejected('http://localhost.localdomain/')
    expectRejected('http://10.0.0.5/')
    expectRejected('http://172.16.0.1/')
    expectRejected('http://192.168.1.1/')
    expectRejected('http://169.254.169.254/latest/meta-data/')
    expectRejected('http://[::1]/')
    expectRejected('http://[fe80::1]/')
  })

  test('内部专用后缀', () => {
    expectRejected('http://router.local/')
    expectRejected('http://db.internal/')
    expectRejected('http://printer.home.arpa/')
  })

  test('IPv4 的畸形写法同样会被规范化后拦下', () => {
    // new URL 会把十进制 / 十六进制写法规范化成点分十进制，不能有漏网之鱼
    expectRejected('http://2130706433/')
    expectRejected('http://0x7f000001/')
    expectRejected('http://0177.0.0.1/')
    expectRejected('http://127.1/')
  })

  test('IPv4 映射形式的 IPv6 回环', () => {
    // 注意：new URL 会把它规范化成 [::ffff:7f00:1]，只做字符串前缀匹配会漏掉
    expectRejected('http://[::ffff:127.0.0.1]/')
    expectRejected('http://[::ffff:7f00:1]/')
    expectRejected('http://[::ffff:a00:1]/')
  })

  test('NAT64 与 6to4 内嵌的内网 IPv4 也要拦下', () => {
    expectRejected('http://[64:ff9b::127.0.0.1]/')
    expectRejected('http://[2002:7f00:1::]/')
  })

  test('localhost 的别名同样拦截', () => {
    expectRejected('http://localhost.localdomain/')
  })

  test('URL 中携带凭据', () => {
    expectRejected('http://user:pass@example.com/')
    expectRejected('https://admin@example.com/')
  })
})

describe('isBlockedHostname', () => {
  test('大小写与结尾的点不影响判定', () => {
    assert.equal(isBlockedHostname('LocalHost'), true)
    assert.equal(isBlockedHostname('localhost.'), true)
  })

  test('IPv6 带方括号的形式', () => {
    assert.equal(isBlockedHostname('[::1]'), true)
    assert.equal(isBlockedHostname('[2001:4860::8888]'), false)
  })

  test('空主机名按拦截处理', () => {
    assert.equal(isBlockedHostname(''), true)
  })
})
