'use client'

import React, { useState, useCallback } from 'react'
import { useTheme } from 'next-themes'

const PROCESS_STEPS = [
  '正在启动浏览器...',
  '正在打开页面...',
  '正在等待内容加载...',
  '正在截取画面...',
]

// 加载动画组件
const LoadingAnimation = ({ onClose, progress = 0 }: { onClose: () => void; progress?: number }) => (
  <div
    className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50"
    onClick={e => {
      if (e.target === e.currentTarget) onClose()
    }}
  >
    <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 max-w-2xl w-full mx-4 text-center relative">
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
      >
        ✕
      </button>
      <div className="space-y-8">
        <div className="flex flex-col items-center gap-6">
          <div className="relative w-32 h-32">
            <div className="absolute inset-0 flex items-center justify-center animate-bounce">
              <span className="text-6xl">🐰</span>
            </div>
            <div className="absolute inset-0 flex items-center justify-center animate-pulse opacity-50">
              <span className="text-6xl">✨</span>
            </div>
          </div>
          <div className="w-full h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="text-primary font-medium">{progress}%</div>
        </div>
        <div className="space-y-4">
          <h3 className="text-xl font-bold text-gray-800 dark:text-gray-200">正在处理中...</h3>
          <p className="text-gray-600 dark:text-gray-400">请稍候，我们正在为您准备截图</p>
        </div>
      </div>
    </div>
  </div>
)

// 截图等待组件
const ScreenshotLoading = ({ message = '正在截取网页...', progress }: { message?: string; progress: number }) => (
  <div className="p-8 space-y-6 bg-white dark:bg-gray-800 rounded-lg shadow-lg transform transition-all duration-500 animate-slideIn">
    <div className="relative w-24 h-24 mx-auto">
      <div className="absolute inset-0 flex items-center justify-center animate-bounce">
        <span className="text-5xl">🐼</span>
      </div>
      <div className="absolute inset-0 flex items-center justify-center animate-pulse opacity-50">
        <span className="text-5xl">✨</span>
      </div>
    </div>
    <div className="w-full h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
      <div
        className="h-full bg-primary transition-all duration-300 ease-out"
        style={{ width: `${progress}%` }}
      />
    </div>
    <div className="text-center space-y-2">
      <div className="text-primary font-medium">{progress}%</div>
      <p className="text-gray-600 dark:text-gray-400">{message}</p>
    </div>
  </div>
)

export default function Home() {
  const [url, setUrl] = useState('')
  const [screenshots, setScreenshots] = useState<string[]>([])
  const [isCapturing, setIsCapturing] = useState(false)
  const [showGame, setShowGame] = useState(false)
  const [captureProgress, setCaptureProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState(PROCESS_STEPS[0])
  // 分段截图的下一个起点由服务端回传，前端持有，服务端保持无状态
  const [nextOffset, setNextOffset] = useState(0)
  const [reachedEnd, setReachedEnd] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const { theme, setTheme } = useTheme()

  const startProgress = useCallback(() => {
    setCaptureProgress(0)
    setProgressMessage(PROCESS_STEPS[0])

    let step = 0
    const interval = setInterval(() => {
      step += 1
      setProgressMessage(PROCESS_STEPS[Math.min(step, PROCESS_STEPS.length - 1)])
      setCaptureProgress(prev => (prev >= 90 ? prev : prev + 6))
    }, 700)

    return interval
  }, [])

  const stopProgress = useCallback((interval: ReturnType<typeof setInterval>) => {
    clearInterval(interval)
    setCaptureProgress(100)
    window.setTimeout(() => {
      setCaptureProgress(0)
      setIsCapturing(false)
      setShowGame(false)
    }, 500)
  }, [])

  const downloadImage = (base64: string, filename: string) => {
    const link = document.createElement('a')
    link.href = `data:image/png;base64,${base64}`
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  /** 分段／普通截图共用的请求逻辑 */
  const captureScreenshot = async (payload: Record<string, unknown>, showOverlay: boolean) => {
    setIsCapturing(true)
    setErrorMessage(null)
    if (showOverlay) setShowGame(true)
    const progressInterval = startProgress()

    try {
      const response = await fetch('/api/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json()

      if (!data.success) {
        throw new Error(data.error || '截图失败')
      }

      // 有图就先挂上去（末段也可能带一张有效图片），再判断是否到底
      if (data.screenshot) {
        setScreenshots(prev => [...prev, data.screenshot as string])
      }
      setNextOffset(typeof data.nextOffset === 'number' ? data.nextOffset : 0)
      setReachedEnd(Boolean(data.isEnd))

      stopProgress(progressInterval)
      return true
    } catch (error) {
      clearInterval(progressInterval)
      setCaptureProgress(0)
      setIsCapturing(false)
      setShowGame(false)
      setErrorMessage(error instanceof Error ? error.message : '截图失败，请稍后重试')
      return false
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setScreenshots([])
    setNextOffset(0)
    setReachedEnd(false)
    // 服务端无状态，重置只需清空前端自己的游标
    await captureScreenshot({ url, offset: 0 }, false)
  }

  const handleContinueCapture = async () => {
    if (reachedEnd) return
    await captureScreenshot({ url, offset: nextOffset }, false)
  }

  const handleFullPageCapture = async () => {
    setIsCapturing(true)
    setShowGame(true)
    setErrorMessage(null)
    const progressInterval = startProgress()

    try {
      const response = await fetch('/api/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, fullPage: true }),
      })
      const data = await response.json()

      if (!data.success || !data.screenshot) {
        throw new Error(data.error || '截图失败')
      }

      downloadImage(data.screenshot, 'full-page-screenshot.png')
      stopProgress(progressInterval)
    } catch (error) {
      clearInterval(progressInterval)
      setCaptureProgress(0)
      setIsCapturing(false)
      setShowGame(false)
      setErrorMessage(error instanceof Error ? error.message : '整页截图失败，请稍后重试')
    }
  }

  const handleMergeSave = async () => {
    setIsCapturing(true)
    setShowGame(true)
    setErrorMessage(null)
    const progressInterval = startProgress()

    try {
      const response = await fetch('/api/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screenshots }),
      })
      const data = await response.json()

      if (!data.success || !data.mergedImage) {
        throw new Error(data.error || '合并失败')
      }

      stopProgress(progressInterval)
      downloadImage(data.mergedImage, 'merged-screenshot.png')
    } catch (error) {
      clearInterval(progressInterval)
      setCaptureProgress(0)
      setIsCapturing(false)
      setShowGame(false)
      setErrorMessage(error instanceof Error ? error.message : '长图拼接失败，请稍后重试')
    }
  }

  const toggleTheme = () => {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }

  return (
    <main className="min-h-screen bg-gradient-custom">
      {showGame && <LoadingAnimation onClose={() => setShowGame(false)} progress={captureProgress} />}

      <nav className="fixed top-0 w-full bg-card/80 backdrop-blur-md border-b border-card-foreground/10 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gradient bg-gradient-size">LinkSnapper</h1>
          <button
            onClick={toggleTheme}
            className="p-2 rounded-full hover:bg-card transition-colors"
            aria-label={theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
          >
            {theme === 'dark' ? <span className="text-xl">🌞</span> : <span className="text-xl">🌙</span>}
          </button>
        </div>
      </nav>

      <div className="min-h-screen flex flex-col items-center justify-start pt-32 px-4">
        <div className="text-center mb-16">
          <h2 className="text-6xl font-bold text-gradient bg-gradient-size mb-8">一键获取网页截图</h2>
          <p className="text-card-foreground/80 text-xl mt-6">
            简单、快速、智能的网页截图工具，让分享变得更加轻松
          </p>
        </div>

        <div className="w-full max-w-3xl mx-auto mb-16">
          <form onSubmit={handleSubmit} className="flex gap-4">
            <input
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="输入网页URL，例如 example.com"
              required
              className="flex-1 p-4 rounded-lg border border-card-foreground/10 bg-card text-card-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all text-lg"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isCapturing}
                className="relative px-6 py-4 rounded-lg btn-gradient text-primary-foreground font-medium disabled:opacity-50 text-lg overflow-hidden"
              >
                <span className="relative z-10">开始截图</span>
              </button>
              <button
                type="button"
                onClick={handleFullPageCapture}
                disabled={isCapturing}
                className="px-6 py-4 rounded-lg bg-card text-primary font-medium hover:bg-card/80 transition-colors disabled:opacity-50 text-lg border border-primary/20"
              >
                全页截图
              </button>
            </div>
          </form>

          {errorMessage && (
            <div className="mt-4 px-5 py-4 rounded-lg border border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              {errorMessage}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 w-full max-w-7xl mx-auto">
          <div className="p-6 rounded-lg bg-card shadow-lg">
            <div className="mb-4">
              <span className="text-4xl">🎯</span>
            </div>
            <h3 className="text-xl font-semibold mb-2 text-primary">精准截图</h3>
            <p className="text-card-foreground/80">支持全页面和分段截图，满足不同需求</p>
          </div>
          <div className="p-6 rounded-lg bg-card shadow-lg">
            <div className="mb-4">
              <span className="text-4xl">⚡</span>
            </div>
            <h3 className="text-xl font-semibold mb-2 text-primary">快速处理</h3>
            <p className="text-card-foreground/80">自动识别网站类型，智能等待内容加载</p>
          </div>
          <div className="p-6 rounded-lg bg-card shadow-lg">
            <div className="mb-4">
              <span className="text-4xl">🔒</span>
            </div>
            <h3 className="text-xl font-semibold mb-2 text-primary">安全可靠</h3>
            <p className="text-card-foreground/80">内置地址校验，阻止对内网服务的探测</p>
          </div>
        </div>

        {screenshots.length > 0 && (
          <div className="mt-12 space-y-6 w-full max-w-7xl">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex-1 flex items-center gap-4 flex-wrap">
                <button
                  onClick={handleContinueCapture}
                  disabled={isCapturing || reachedEnd}
                  className="flex items-center gap-2 px-6 py-3 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90 transition-colors text-lg disabled:opacity-40"
                >
                  <span>{reachedEnd ? '已到页面底部' : '继续截图下一页'}</span>
                  <span className="text-xl">📸</span>
                </button>
                <button
                  onClick={handleMergeSave}
                  disabled={isCapturing}
                  className="flex items-center gap-2 px-6 py-3 rounded-lg border-2 border-primary text-primary font-medium hover:bg-primary/5 transition-colors text-lg group disabled:opacity-40"
                >
                  <span>拼接长图</span>
                  <span className="text-xl group-hover:scale-110 transition-transform">🔗</span>
                </button>
              </div>
              <button
                onClick={handleFullPageCapture}
                disabled={isCapturing}
                className="flex items-center gap-2 px-6 py-3 rounded-lg bg-primary/10 text-primary font-medium hover:bg-primary/20 transition-colors text-lg disabled:opacity-40"
              >
                <span>重新截取整页</span>
                <span className="text-xl">📄</span>
              </button>
            </div>

            <p className="text-card-foreground/60 text-sm">
              已截取 {screenshots.length} 段（当前游标 {nextOffset}px）
            </p>

            <div className="grid gap-6">
              {screenshots.map((screenshot, index) => (
                <div
                  key={index}
                  className={`rounded-lg overflow-hidden shadow-lg transition-all duration-500 ${
                    isCapturing ? 'opacity-50' : 'opacity-100'
                  }`}
                >
                  {isCapturing ? (
                    <div className="relative">
                      <img
                        src={`data:image/png;base64,${screenshot}`}
                        alt={`截图 ${index + 1}`}
                        className="w-full filter blur-sm"
                      />
                      {index === screenshots.length - 1 && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <ScreenshotLoading progress={captureProgress} message={progressMessage} />
                        </div>
                      )}
                    </div>
                  ) : (
                    <img src={`data:image/png;base64,${screenshot}`} alt={`截图 ${index + 1}`} className="w-full" />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
