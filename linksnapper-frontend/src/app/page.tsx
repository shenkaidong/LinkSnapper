"use client";

import React, { useEffect, useState } from "react";
import Image from "next/image";

export default function Home() {
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setIsLoaded(true);
  }, []);

  return (
    <div className="min-h-screen bg-black text-white overflow-hidden">
      {/* 背景动画效果 */}
      <div className="fixed inset-0 bg-gradient-to-br from-black via-gray-900 to-black">
        <div className="absolute inset-0 bg-[url('/grid.svg')] opacity-20"></div>
        <div className="absolute inset-0 bg-gradient-radial from-transparent to-black"></div>
      </div>

      {/* 主要内容 */}
      <main className="relative z-10">
        {/* Hero 部分 */}
        <div className={`
          transition-all duration-1000 transform
          ${isLoaded ? 'translate-y-0 opacity-100' : 'translate-y-10 opacity-0'}
          px-6 pt-32 pb-16 mx-auto max-w-7xl
        `}>
          <h1 className="text-5xl md:text-7xl font-bold text-center mb-6 bg-clip-text text-transparent bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500">
            LinkSnapper
          </h1>
          <p className="text-xl md:text-2xl text-center text-gray-400 max-w-3xl mx-auto mb-12">
            重新定义您的链接管理方式，智能、快速、优雅
          </p>

          {/* 特性卡片 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-16">
            <FeatureCard
              title="智能分析"
              description="自动分析链接内容，提供智能分类和标签"
              delay="0"
            />
            <FeatureCard
              title="快速分享"
              description="一键分享到任何平台，无缝协作"
              delay="100"
            />
            <FeatureCard
              title="安全可靠"
              description="端到端加密，确保您的数据安全"
              delay="200"
            />
          </div>

          {/* CTA 按钮 */}
          <div className="flex justify-center gap-6 mt-16">
            <button className="px-8 py-4 bg-gradient-to-r from-blue-600 to-purple-600 rounded-full text-lg font-semibold hover:opacity-90 transition-all">
              立即开始
            </button>
            <button className="px-8 py-4 border border-gray-700 rounded-full text-lg font-semibold hover:bg-gray-800 transition-all">
              了解更多
            </button>
          </div>
        </div>

        {/* 动态背景装饰 */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-gradient-to-r from-blue-500/30 to-purple-500/30 rounded-full blur-3xl opacity-20 animate-pulse"></div>
      </main>
    </div>
  );
}

function FeatureCard({ title, description, delay }: { title: string; description: string; delay: string }) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), parseInt(delay));
    return () => clearTimeout(timer);
  }, [delay]);

  return (
    <div
      className={`
        transition-all duration-1000 transform
        ${isVisible ? 'translate-y-0 opacity-100' : 'translate-y-10 opacity-0'}
        p-8 rounded-2xl bg-gradient-to-b from-gray-800/50 to-gray-900/50
        border border-gray-700/50 backdrop-blur-sm
        hover:border-gray-600 hover:scale-105 transition-all
      `}
    >
      <h3 className="text-xl font-semibold mb-4 bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
        {title}
      </h3>
      <p className="text-gray-400">
        {description}
      </p>
    </div>
  );
} 