# LinkSnapper

LinkSnapper 是一个强大的网页截图工具，支持多种类型网站的智能截图，包括动态加载、单页应用和静态网站。

## 功能特点

- 🌐 多网站支持
  - 动态加载网站（如 B站、知乎等）
  - 单页应用（SPA）
  - 静态网站
- 📸 智能截图
  - 自动检测网站类型
  - 智能等待页面加载
  - 支持分页截图
- 🌙 深色模式支持
- 🔄 自动重试机制
- 📱 响应式设计

## 技术栈

- 前端：Next.js + TypeScript + Tailwind CSS
- 截图引擎：Puppeteer
- 容器化：Docker

## 快速开始

### 环境要求

- Node.js（v18 或更高版本）
- Docker（可选，用于容器化部署）

### 安装步骤

1. 克隆仓库
```bash
git clone https://github.com/YOUR_USERNAME/LinkSnapper.git
cd LinkSnapper
```

2. 安装依赖
```bash
npm install
# 或
yarn install
```

3. 启动开发服务器
```bash
npm run dev
# 或
yarn dev
```

4. 访问 http://localhost:3000

## Docker 部署

1. 构建 Docker 镜像
```bash
docker build -t linksnapper .
```

2. 运行容器
```bash
docker run -d -p 3000:3000 linksnapper
```

## 环境变量

在根目录创建 `.env` 文件：

```env
# 基础配置
NEXT_PUBLIC_API_URL=http://localhost:3000
NODE_ENV=development

# Chrome 配置
CHROME_PATH=/usr/bin/google-chrome
```

## 参与贡献

1. Fork 本项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m '添加某个特性'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 提交 Pull Request

## 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情

## 作者

Kaidong Shen - [@shenkaidong](https://github.com/shenkaidong)

## 支持

如果你觉得这个项目有帮助，请给它一个星标 ⭐️

[English Documentation](README.md) 