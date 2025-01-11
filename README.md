# LinkSnapper

LinkSnapper 是一个强大的网页截图工具，支持多种类型网站的智能截图，包括动态加载、单页应用和静态网站。

## 功能特点

- 🌐 支持多种类型网站
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

## 技术架构

- 前端：Next.js + TypeScript + Tailwind CSS
- 截图引擎：Puppeteer
- 容器化：Docker

## 本地开发

1. 克隆项目
```bash
git clone git@github.com:shenkaidong/LinkSnapper.git
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

## 部署指南

### 1. 传统服务器部署

1. 准备环境
```bash
# 安装 Node.js (推荐 v18+)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装 PM2
npm install -g pm2
```

2. 构建项目
```bash
npm run build
# 或
yarn build
```

3. 使用 PM2 启动
```bash
pm2 start npm --name "linksnapper" -- start
```

### 2. Docker 部署

1. 构建镜像
```bash
docker build -t linksnapper .
```

2. 运行容器
```bash
docker run -d -p 3000:3000 --name linksnapper linksnapper
```

Dockerfile 示例：
```dockerfile
# 基础镜像
FROM node:18-alpine

# 安装 Chromium
RUN apk add --no-cache chromium

# 设置工作目录
WORKDIR /app

# 复制项目文件
COPY . .

# 安装依赖
RUN npm install

# 构建项目
RUN npm run build

# 暴露端口
EXPOSE 3000

# 启动服务
CMD ["npm", "start"]
```

### 3. Vercel 部署

1. 安装 Vercel CLI
```bash
npm i -g vercel
```

2. 登录并部署
```bash
vercel login
vercel
```

### 4. GitHub Actions CI/CD

在 `.github/workflows/main.yml` 创建工作流：

```yaml
name: CI/CD

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
    - uses: actions/checkout@v2
    
    - name: Setup Node.js
      uses: actions/setup-node@v2
      with:
        node-version: '18'
        
    - name: Install dependencies
      run: npm install
      
    - name: Run tests
      run: npm test
      
    - name: Build
      run: npm run build
      
    - name: Deploy to production
      if: github.ref == 'refs/heads/main'
      run: |
        # 这里添加你的部署命令
        # 例如部署到 Vercel:
        npx vercel --token ${VERCEL_TOKEN} --prod
      env:
        VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
```

## 环境变量配置

创建 `.env` 文件：

```env
# 基础配置
NEXT_PUBLIC_API_URL=http://localhost:3000
NODE_ENV=development

# Chrome 配置
CHROME_PATH=/usr/bin/google-chrome
```

## 项目结构

```
LinkSnapper/
├── src/
│   ├── app/                 # Next.js 应用目录
│   │   ├── api/            # API 路由
│   │   │   └── screenshot/ # 截图相关 API
│   │   ├── page.tsx        # 主页面
│   │   └── globals.css     # 全局样式
│   ├── services/           # 服务层
│   │   └── screenshot/     # 截图服务
│   └── utils/              # 工具函数
├── public/                 # 静态资源
├── Dockerfile             # Docker 配置
└── package.json          # 项目配置
```

## 注意事项

1. 确保服务器有足够的内存（建议至少 2GB）
2. 需要安装 Chrome/Chromium
3. 某些网站可能有反爬虫机制，需要适当配置请求头和 Cookie

## 贡献指南

1. Fork 项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交改动 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 提交 Pull Request

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 作者

Kaidong Shen - [@shenkaidong](https://github.com/shenkaidong)

## 支持

如果你觉得这个项目有帮助，请给它一个星标 ⭐️ 