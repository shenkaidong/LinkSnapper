/**
 * Next.js 启动钩子（需要在 next.config 里开启 experimental.instrumentationHook）。
 *
 * 这里是整个进程唯一的「启动入口」，适合做两件必须在接收请求之前完成的事：
 *   1) 注册优雅退出：把「关闭常驻 Chromium」挂到关机钩子上，并排空在途请求；
 *   2) 启动自检：Chrome 是否就绪、版本是否匹配、安全开关状态。
 *
 * 之所以不放进路由模块：路由是懒加载的，第一个请求进来才执行，
 * 那时再自检、再注册退出钩子就已经晚了（首个请求可能已经失败）。
 */

export async function register(): Promise<void> {
  // 必须用这种「正向判断 + 块内动态导入」的写法，不能写成
  // `if (runtime !== 'nodejs') return` 再在后面导入。
  //
  // 原因：instrumentation 会被 Node 与 Edge 两套编译各处理一次，而 Next 会在
  // 构建期把 process.env.NEXT_RUNTIME 常量折叠成具体值。正向判断时，edge 那次
  // 编译里整个 if 块是死代码，动态导入会被消除，Node 专属模块（puppeteer-core、
  // node:module 等）就不会进入 edge 产物；写成提前 return 则消不掉，
  // edge 编译会去解析 node:module 并报 UnhandledSchemeError。
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installLifecycleHooks, onShutdown } = await import('@/utils/lifecycle')
    const { closeSharedBrowser } = await import('@/services/browser')
    const { runStartupChecks } = await import('@/utils/startup')

    installLifecycleHooks()
    onShutdown(() => closeSharedBrowser())

    await runStartupChecks()
  }
}
