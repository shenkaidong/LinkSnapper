/** @type {import('next').NextConfig} */
const nextConfig = {
  // puppeteer-core 与 sharp 属于原生 / 大体积模块，必须交给 Node 在运行时 require。
  // 不声明的话，Next 的打包器会尝试把它们 bundle 进产物，构建阶段就会失败。
  experimental: {
    serverComponentsExternalPackages: ['puppeteer-core', 'sharp'],
  },
}

module.exports = nextConfig
