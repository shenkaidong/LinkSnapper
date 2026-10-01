/**
 * 进程生命周期：优雅退出与在途请求排空。
 *
 * 为什么需要它：截图请求是「长任务」——一个请求要占用 Chromium 几十秒。
 * 容器滚动更新 / 缩容时编排系统发的是 SIGTERM，如果立即退出，在途的
 * 长任务会被直接掐断，客户端拿到的是连接重置而不是一张图。
 *
 * 正确顺序是：
 *   1) 置 shuttingDown，立刻拒绝新请求（让编排系统的就绪探针把本实例摘流）
 *   2) 等已有请求跑完（有上限，不能无限等）
 *   3) 关闭常驻浏览器等资源
 *   4) 显式退出进程
 *
 * 第 4 步容易被漏掉，而且漏掉的后果很隐蔽：在 Node 里注册 SIGTERM 监听会
 * **覆盖默认的终止行为**，如果监听器不调用 process.exit()，进程就永远不会
 * 退出，只能等编排系统的 grace period 到了被 SIGKILL —— 表现是「停止容器
 * 要卡 10 秒，且在途请求照样全丢」。这里显式退出就是为了杜绝这种情况。
 */

type ShutdownHook = () => Promise<void> | void

/** 排空等待上限。超过就强制结束，避免停机被某个卡死的长任务拖住 */
const DRAIN_TIMEOUT_MS = Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS) || 30_000

const hooks: ShutdownHook[] = []
const drainWaiters: Array<() => void> = []

let installed = false
let shuttingDown = false
let inFlight = 0
let shutdownPromise: Promise<void> | null = null

/** 是否正在停机。就绪探针据此返回 503，让编排系统把流量摘走 */
export function isShuttingDown(): boolean {
  return shuttingDown
}

/** 当前在途的截图请求数 */
export function inFlightCount(): number {
  return inFlight
}

/** 注册关机时要执行的清理动作（如关闭浏览器） */
export function onShutdown(hook: ShutdownHook): void {
  hooks.push(hook)
}

/**
 * 请求进入时登记。正在停机则返回 false —— 调用方应直接回 503 而不是排队，
 * 否则新请求会在排空阶段被接受，然后立刻被掐断，比直接拒绝更糟。
 */
export function tryBeginRequest(): boolean {
  if (shuttingDown) return false
  inFlight += 1
  return true
}

/** 请求结束时注销。若正处于排空阶段且已清空，唤醒等待者 */
export function endRequest(): void {
  inFlight = Math.max(0, inFlight - 1)
  if (shuttingDown && inFlight === 0) {
    const waiters = drainWaiters.splice(0)
    waiters.forEach(resolve => resolve())
  }
}

function waitForDrain(timeoutMs: number): Promise<boolean> {
  if (inFlight === 0) return Promise.resolve(true)

  return new Promise<boolean>(resolve => {
    let settled = false
    const finish = (drained: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(drained)
    }

    // 这里**不能** unref()：排空阶段要靠这个定时器兜底唤醒，
    // 否则在途请求的 I/O 已结束但计数未归零时，进程会一直挂住。
    const timer = setTimeout(() => finish(false), timeoutMs)
    drainWaiters.push(() => finish(true))
  })
}

/**
 * 执行停机流程。exit=false 时不退出进程（测试用）。
 */
export function shutdown(signal: string, options: { exit?: boolean } = {}): Promise<void> {
  if (shutdownPromise) return shutdownPromise

  shuttingDown = true
  const shouldExit = options.exit !== false

  shutdownPromise = (async () => {
    console.log(
      `[lifecycle] 收到 ${signal}：停止接收新请求，开始排空 ${inFlight} 个在途请求（上限 ${DRAIN_TIMEOUT_MS}ms）`
    )

    const drained = await waitForDrain(DRAIN_TIMEOUT_MS)
    console.log(
      `[lifecycle] 在途请求${drained ? '已全部完成' : `未在 ${DRAIN_TIMEOUT_MS}ms 内排空，强制结束`}`
    )

    for (const hook of hooks) {
      try {
        await hook()
      } catch (error) {
        console.error('[lifecycle] 关机钩子执行失败：', error)
      }
    }

    console.log('[lifecycle] 清理完成，退出进程')
    if (shouldExit) {
      process.exit(0)
    }
  })()

  return shutdownPromise
}

/** 注册信号监听。幂等 */
export function installLifecycleHooks(): void {
  if (installed) return
  installed = true

  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

/** 仅测试用：把模块状态恢复到初始值 */
export function __resetForTests(): void {
  hooks.length = 0
  drainWaiters.length = 0
  installed = false
  shuttingDown = false
  inFlight = 0
  shutdownPromise = null
}
