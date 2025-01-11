'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTheme } from 'next-themes'

// 加载动画组件
const LoadingAnimation = ({ onClose, progress = 0 }: { onClose: () => void, progress?: number }) => {
  return (
    <div 
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose()
        }
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
            {/* 小动物动画 */}
            <div className="relative w-32 h-32">
              <div className="absolute inset-0 flex items-center justify-center animate-bounce">
                <span className="text-6xl">🐰</span>
              </div>
              <div className="absolute inset-0 flex items-center justify-center animate-pulse opacity-50">
                <span className="text-6xl">✨</span>
              </div>
            </div>
            {/* 进度条 */}
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
}

// 进度条组件
const ProgressBar = ({ progress }: { progress: number }) => (
  <div className="w-full h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
    <div 
      className="h-full bg-[#6C63FF] dark:bg-[#8B85FF] transition-all duration-300 ease-out"
      style={{ width: `${progress}%` }}
    />
  </div>
)

// 截图等待组件
const ScreenshotLoading = ({ message = "正在截取网页...", progress }: { message?: string, progress: number }) => (
  <div className="p-8 space-y-6 bg-white dark:bg-gray-800 rounded-lg shadow-lg transform transition-all duration-500 animate-slideIn">
    {/* 动物动画 */}
    <div className="relative w-24 h-24 mx-auto">
      <div className="absolute inset-0 flex items-center justify-center animate-bounce">
        <span className="text-5xl">🐼</span>
      </div>
      <div className="absolute inset-0 flex items-center justify-center animate-pulse opacity-50">
        <span className="text-5xl">✨</span>
      </div>
    </div>
    {/* 进度条 */}
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
  const { theme, setTheme } = useTheme()

  const updateProgress = useCallback(() => {
    setCaptureProgress(0)
    const interval = setInterval(() => {
      setCaptureProgress(prev => {
        if (prev >= 95) {
          clearInterval(interval)
          return prev
        }
        return prev + 5
      })
    }, 500)
    return interval
  }, [])

  const captureScreenshot = async () => {
    try {
      setIsCapturing(true)
      const progressInterval = updateProgress()
      const response = await fetch('/api/screenshot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      })
      const data = await response.json()
      if (data.success) {
        if (data.isEnd) {
          // 如果已经到达底部，显示提示
          alert('已经到达页面底部')
          setCaptureProgress(0)
          setIsCapturing(false)
        } else {
          setScreenshots(prev => [...prev, data.screenshot])
          setCaptureProgress(100)
          setTimeout(() => {
            setCaptureProgress(0)
            setIsCapturing(false)
          }, 500)
        }
      } else {
        throw new Error(data.error || '截图失败')
      }
      clearInterval(progressInterval)
    } catch (error) {
      console.error('截图失败:', error)
      alert('截图失败，请检查URL是否正确或稍后重试')
      setCaptureProgress(0)
      setIsCapturing(false)
      setShowGame(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setScreenshots([])
    // 清除之前的滚动位置
    await fetch('/api/screenshot', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
    })
    await captureScreenshot()
  }

  const handleContinueCapture = async () => {
    await captureScreenshot()
  }

  const handleFullPageCapture = async () => {
    try {
      setIsCapturing(true)
      setShowGame(true)
      const progressInterval = updateProgress()
      const response = await fetch('/api/screenshot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url, fullPage: true }),
      })
      const data = await response.json()
      if (data.success) {
        const link = document.createElement('a')
        link.href = `data:image/png;base64,${data.screenshot}`
        link.download = 'full-page-screenshot.png'
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
      } else {
        throw new Error(data.error || '截图失败')
      }
      clearInterval(progressInterval)
    } catch (error) {
      console.error('截图失败:', error)
      // 显示错误提示
      alert('截图失败，请检查URL是否正确或稍后重试')
    } finally {
      // 确保在任何情况下都会重置状态
      setCaptureProgress(0)
      setIsCapturing(false)
      setShowGame(false)
    }
  }

  const handleMergeSave = async () => {
    try {
      setIsCapturing(true)
      setShowGame(true)
      const progressInterval = updateProgress()
      const response = await fetch('/api/merge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ screenshots }),
      })
      const data = await response.json()
      if (data.success) {
        // 先关闭加载动画
        setIsCapturing(false)
        setShowGame(false)
        setCaptureProgress(0)
        clearInterval(progressInterval)
        
        // 然后触发下载
        const link = document.createElement('a')
        link.href = `data:image/png;base64,${data.mergedImage}`
        link.download = 'merged-screenshot.png'
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
      } else {
        throw new Error(data.error || '合并失败')
      }
    } catch (error) {
      console.error('合并失败:', error)
      // 出错时也要关闭加载动画
      setIsCapturing(false)
      setShowGame(false)
      setCaptureProgress(0)
    }
  }

  // 主题切换函数
  const toggleTheme = () => {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }

  return (
    <main className="min-h-screen bg-gradient-custom">
      {showGame && <LoadingAnimation onClose={() => setShowGame(false)} progress={captureProgress} />}
      {/* 顶部导航栏 */}
      <nav className="fixed top-0 w-full bg-card/80 backdrop-blur-md border-b border-card-foreground/10 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gradient bg-gradient-size">
            LinkSnapper
          </h1>
          <button
            onClick={toggleTheme}
            className="p-2 rounded-full hover:bg-card transition-colors"
            aria-label={theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
          >
            {theme === 'dark' ? (
              <span className="text-xl">🌞</span>
            ) : (
              <span className="text-xl">🌙</span>
            )}
          </button>
        </div>
      </nav>

      {/* 主要内容区域 */}
      <div className="min-h-screen flex flex-col items-center justify-start pt-32 px-4">
        {/* 标题和描述 */}
        <div className="text-center mb-16">
          <h2 className="text-6xl font-bold text-gradient bg-gradient-size mb-8">
            一键获取网页截图
          </h2>
          <p className="text-card-foreground/80 text-xl mt-6">
            简单、快速、智能的网页截图工具，让分享变得更加轻松
          </p>
        </div>

        {/* 输入表单 */}
        <div className="w-full max-w-3xl mx-auto mb-16">
          <form onSubmit={handleSubmit} className="flex gap-4">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="输入网页URL"
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
        </div>

        {/* 功能卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 w-full max-w-7xl mx-auto">
          <div className="p-6 rounded-lg bg-card shadow-lg">
            <div className="mb-4">
              <span className="text-4xl">🎯</span>
            </div>
            <h3 className="text-xl font-semibold mb-2 text-primary">精准截图</h3>
            <p className="text-card-foreground/80">支持全页面和自定义区域截图，满足不同需求</p>
          </div>
          <div className="p-6 rounded-lg bg-card shadow-lg">
            <div className="mb-4">
              <span className="text-4xl">⚡</span>
            </div>
            <h3 className="text-xl font-semibold mb-2 text-primary">快速处理</h3>
            <p className="text-card-foreground/80">采用先进技术，秒级完成截图任务</p>
          </div>
          <div className="p-6 rounded-lg bg-card shadow-lg">
            <div className="mb-4">
              <span className="text-4xl">🔒</span>
            </div>
            <h3 className="text-xl font-semibold mb-2 text-primary">安全可靠</h3>
            <p className="text-card-foreground/80">所有操作在云端完成，保护您的隐私</p>
          </div>
        </div>

        {/* 截图结果展示 */}
        {screenshots.length > 0 && (
          <div className="mt-12 space-y-6 w-full max-w-7xl">
            <div className="flex items-center gap-4">
              <div className="flex-1 flex items-center gap-4">
                <button
                  onClick={handleContinueCapture}
                  disabled={isCapturing}
                  className="flex items-center gap-2 px-6 py-3 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90 transition-colors text-lg"
                >
                  <span>继续截图下一页</span>
                  <span className="text-xl">📸</span>
                </button>
                <button
                  onClick={handleMergeSave}
                  disabled={isCapturing}
                  className="flex items-center gap-2 px-6 py-3 rounded-lg border-2 border-primary text-primary font-medium hover:bg-primary/5 transition-colors text-lg group"
                >
                  <span>拼接长图</span>
                  <span className="text-xl group-hover:scale-110 transition-transform">🔗</span>
                </button>
              </div>
              <button
                onClick={handleFullPageCapture}
                disabled={isCapturing}
                className="flex items-center gap-2 px-6 py-3 rounded-lg bg-primary/10 text-primary font-medium hover:bg-primary/20 transition-colors text-lg"
              >
                <span>重新截取整页</span>
                <span className="text-xl">📄</span>
              </button>
            </div>
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
                          <ScreenshotLoading progress={captureProgress} />
                        </div>
                      )}
                    </div>
                  ) : (
                    <img
                      src={`data:image/png;base64,${screenshot}`}
                      alt={`截图 ${index + 1}`}
                      className="w-full"
                    />
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