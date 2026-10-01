/** @type {import('next').NextConfig} */
const nextConfig = {
  // puppeteer-core 与 sharp 属于原生 / 大体积模块，必须交给 Node 在运行时 require。
  // 不声明的话，Next 的打包器会尝试把它们 bundle 进产物，构建阶段就会失败。
  experimental: {
    serverComponentsExternalPackages: ['puppeteer-core', 'sharp'],
    // 启用 src/instrumentation.ts：进程启动时做自检并注册优雅退出钩子。
    // 截图服务依赖「启动即就绪」的 Chromium，没有启动钩子就只能等首个请求来试错。
    instrumentationHook: true,
  },

  // puppeteer-core / sharp 必须在运行时交给 Node require：它们依赖 Node 内置模块
  // （fs / path / http）与原生二进制，一旦被 webpack 打包就会构建失败。
  // serverComponentsExternalPackages 只覆盖路由与服务端组件，
  // instrumentation.ts 走的是另一条打包链，所以这里要再显式声明一次。
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(config.externals || []), 'puppeteer-core', 'sharp', 'ioredis']
    }
    return config
  },
}

module.exports = nextConfig
