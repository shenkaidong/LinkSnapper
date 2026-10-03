/**
 * 页面修饰：拦截广告请求、隐藏 Cookie 弹窗。
 *
 * 这是同类截图服务几乎人人都有、而本项目原先完全缺失的一类能力。
 * 不做它，截图里会塞满广告位和"接受 Cookie"横幅 —— 尤其当截图是给
 * AI 视觉模型看的时候，这些噪声会直接干扰判断。
 *
 * 实现方式刻意选了最轻的两种：
 *   - 广告：在请求拦截层直接 abort（连字节都不下载，最快也最省带宽）；
 *   - Cookie 弹窗：注入 CSS 隐藏（DOM 里元素还在，但视觉上消失）。
 * 没有引入 uBlock Origin 之类的完整过滤列表：那需要维护一份
 * 几十 MB 的规则集并定期更新，对一个截图服务来说维护成本远大于收益。
 */

/** 广告 / 统计 / 追踪相关的域名片段。命中即拦截整条请求。 */
const AD_HOST_FRAGMENTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  'googletagmanager.com',
  'google-analytics.com',
  'analytics.google.com',
  'googletagservices.com',
  'amazon-adsystem.com',
  'adsrvr.org',
  'adnxs.com',
  'criteo.com',
  'pubmatic.com',
  'rubiconproject.com',
  'openx.net',
  'taboola.com',
  'outbrain.com',
  'scorecardresearch.com',
  'quantserve.com',
  'hotjar.com',
  'segment.io',
  'mixpanel.com',
  'facebook.net',
  'connect.facebook.net',
  'bat.bing.com',
]

/** 路径层面的广告特征。用于兜住那些域名看不出问题、但路径很明显的请求。 */
const AD_PATH_FRAGMENTS = [
  '/ads?',
  '/ad?',
  '/advertisement',
  '/doubleclick',
  '/googleads',
  '/adserver',
  '/adview',
  '/banner-ads',
  '/tracking',
  '/pixel.gif',
  '/track.gif',
]

/** 判断一条请求是否属于广告 / 追踪。 */
export function isAdRequest(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }

  const host = parsed.hostname.toLowerCase()
  if (AD_HOST_FRAGMENTS.some(fragment => host === fragment || host.endsWith(`.${fragment}`))) {
    return true
  }

  const path = `${parsed.pathname}${parsed.search}`.toLowerCase()
  return AD_PATH_FRAGMENTS.some(fragment => path.includes(fragment))
}

/**
 * Cookie 同意横幅的常见选择器。
 *
 * 用 `[attribute*="value" i]` 这种大小写不敏感的子串匹配，
 * 是为了覆盖各家站点千奇百怪的类名（CookieConsent / cookie-banner / ckies 等）。
 * 全是 `display:none`，即使某些选择器误伤了非弹窗元素，影响也仅限于视觉隐藏。
 */
export const COOKIE_BANNER_SELECTORS = [
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
  '[class*="gdpr" i]',
  '[id*="gdpr" i]',
  '[class*="cc-banner" i]',
  '[class*="privacy-policy-banner" i]',
  '[aria-label*="cookie" i]',
  '[aria-label*="consent" i]',
]

/** 把选择器列表拼成隐藏用的 CSS 规则 */
export function hideRules(selectors: string[]): string {
  if (selectors.length === 0) return ''
  return `${selectors.join(',\n')} {\n  display: none !important;\n  visibility: hidden !important;\n}\n`
}
