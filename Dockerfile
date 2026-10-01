# 使用 Node.js 官方镜像
FROM node:lts-alpine

# 安装 Chromium 及其依赖、中文字体、sharp 需要的兼容库
#   - libc6-compat / vips: sharp 在 alpine(musl) 上运行的原生依赖，缺了会在运行时崩溃
#   - tini: 容器 PID 1 初始化进程，负责回收 Chromium 产生的僵尸进程并正确转发信号
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto \
    font-noto-cjk \
    font-noto-emoji \
    fontconfig \
    libc6-compat \
    vips \
    tini

# 刷新字体缓存，保证中文不出现方块
RUN fc-cache -fv

# Chromium 路径与运行环境
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    CHROME_PATH=/usr/bin/chromium-browser \
    CHROME_BIN=/usr/bin/chromium-browser \
    NEXT_TELEMETRY_DISABLED=1 \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN.UTF-8 \
    LC_ALL=C.UTF-8

WORKDIR /app

# 创建非 root 用户
RUN addgroup -S pptruser && adduser -S -G pptruser pptruser \
    && mkdir -p /home/pptruser/Downloads /app/.next \
    && chown -R pptruser:pptruser /home/pptruser /app

# 先只复制依赖清单，充分利用构建缓存
COPY package.json package-lock.json ./

# 清理缓存并按锁文件安装依赖
RUN npm cache clean --force && \
    npm ci --legacy-peer-deps && \
    npm cache clean --force

# 再复制源码
COPY . .

# 构建应用
RUN npm run build && \
    chown -R pptruser:pptruser /app

# 切换到非 root 用户
USER pptruser

# 暴露端口
EXPOSE 3000

# 健康检查
# 走 /api/health 而不是首页：这个接口只报进程自身状态，不会产生任何副作用，
# 也不会因为渲染页面而额外拉起 Chromium。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/health > /dev/null || exit 1

# 用 tini 作为 PID 1 启动，避免 Chromium 僵尸进程堆积
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "start"]
