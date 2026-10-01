'use client'

import React, { useState } from 'react'
import { useTheme } from 'next-themes'

export default function SnapshotPage() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const { theme, setTheme } = useTheme()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setErrorMessage(null)
    setScreenshot(null)

    try {
      const response = await fetch('/api/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          singleShot: true, // 普通截图模式：只截当前视口
        }),
      })

      const data = await response.json()

      if (data.success && data.screenshot) {
        setScreenshot(`data:image/png;base64,${data.screenshot}`)
      } else {
        setErrorMessage(data.error || '截图失败，请重试')
      }
    } catch (error) {
      console.error('Error:', error)
      setErrorMessage('发生错误，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 transition-colors duration-300">
      <main className="max-w-4xl mx-auto px-4 py-12">
        <div className="flex justify-end mb-4">
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label={theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
          >
            {theme === 'dark' ? <span className="text-xl">🌞</span> : <span className="text-xl">🌙</span>}
          </button>
        </div>

        <h1 className="text-4xl font-bold text-center mb-8 bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
          网页截图
        </h1>

        <form onSubmit={handleSubmit} className="mb-8">
          <div className="flex gap-4">
            <input
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="输入网页链接，例如 example.com"
              required
              className="flex-1 px-6 py-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none transition-all"
            />
            <button
              type="submit"
              disabled={loading}
              className={`px-8 py-4 bg-gradient-to-r from-blue-600 to-purple-600 text-white rounded-xl transition-all font-medium
                ${loading ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90'}`}
            >
              {loading ? '处理中...' : '开始截图'}
            </button>
          </div>

          {errorMessage && (
            <div className="mt-4 px-5 py-4 rounded-xl border border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              {errorMessage}
            </div>
          )}
        </form>

        {screenshot && (
          <div className="mt-8">
            <h2 className="text-2xl font-semibold mb-4 text-gray-900 dark:text-white">截图预览</h2>
            <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
              <img src={screenshot} alt="网页截图" className="w-full h-auto" />
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
