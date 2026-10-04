/**
 * 单测用的路径别名解析钩子：把 `@/xxx` 映射到 `src/xxx`。
 *
 * 为什么需要它：Next.js 在编译期处理 `@/`，而 `npm run test:unit` 是直接
 * 用 node 裸跑 ts 文件。此前所有单测都只覆盖「不依赖 src 内部模块」的纯函数
 * （url-guard / screenshot-params / startup），一旦要测服务层就会撞上别名。
 *
 * 与其让测试文件用相对路径去摸 `../../src/...`，不如一次把别名接上，
 * 以后新写的单测可以直接引用真实模块路径。
 */

const srcRoot = new URL('../src/', import.meta.url)

const candidates = specifier => {
  const target = new URL(specifier, srcRoot)
  return [`${target.href}.ts`, `${target.href}.tsx`, `${target.href}.js`, target.href]
}

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@/')) return nextResolve(specifier, context)

  for (const candidate of candidates(specifier.slice(2))) {
    try {
      return await nextResolve(candidate, context)
    } catch {
      /* 试下一个后缀，都不行就交给默认解析去报错 */
    }
  }

  return nextResolve(specifier, context)
}
