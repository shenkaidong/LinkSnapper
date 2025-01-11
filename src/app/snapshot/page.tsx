'use client'

import React, { useState } from 'react';
import { useTheme } from 'next-themes';

export default function SnapshotPage() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const { theme } = useTheme();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const response = await fetch('/api/screenshot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      });
      
      const data = await response.json();
      if (data.success) {
        setScreenshot(`data:image/png;base64,${data.screenshot}`);
      } else {
        alert('截图失败，请重试');
      }
    } catch (error) {
      console.error('Error:', error);
      alert('发生错误，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 transition-colors duration-300">
      <main className="max-w-4xl mx-auto px-4 py-12">
        <h1 className="text-4xl font-bold text-center mb-8 bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
          网页截图
        </h1>

        <form onSubmit={handleSubmit} className="mb-8">
          <div className="flex gap-4">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="输入网页链接..."
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
        </form>

        {screenshot && (
          <div className="mt-8">
            <h2 className="text-2xl font-semibold mb-4 text-gray-900 dark:text-white">
              截图预览
            </h2>
            <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
              <img
                src={screenshot}
                alt="网页截图"
                className="w-full h-auto"
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
} 