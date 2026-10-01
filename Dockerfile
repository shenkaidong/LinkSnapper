# 使用 Node.js 官方镜像
#
# ⚠️ 关于基础镜像与浏览器版本
# 本项目用 puppeteer-core 驱动**系统自带的** Chromium，因此 Chromium 的版本
# 必须与 puppeteer-core 的版本大致对应（puppeteer-core 21.x 对应 Chromium 121）。
# Alpine 的 chromium 包会随基础镜像版本变化，一旦错位可能出现
# 「页面能开但等待超时」「某些 DevTools 协议能力缺失」这类不易察觉的问题。
#
# 所以：base image 一旦升级，必须重新验证镜像内的截图功能。
# CI 里的 docker job 会真的起容器并跑一遍截图冒烟，就是为了卡住这一点；
# 如果它失败，两条路可选 —— 回退基础镜像版本，或同步升级 puppeteer-core
# （后者注意 puppeteer 22+ 已移除 headless: 'new'，需同时调整 HEADLESS_MODE）。
FROM node:20-alpine

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

# 把实际装进来的 Chromium 版本打进构建日志。
# 前面说的版本错位问题，出问题时至少能在构建记录里直接看到用的是哪个版本。
RUN chromium-browser --version

# Chromium 路径与运行环境
#   - XDG_* 指向可写目录：Chromium 需要可写的用户数据目录与缓存目录，
#     否则会出现 "chrome_crashpad_handler: --database is required" 之类的启动失败
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    CHROME_PATH=/usr/bin/chromium-browser \
    CHROME_BIN=/usr/bin/chromium-browser \
    NEXT_TELEMETRY_DISABLED=1 \
    XDG_CONFIG_HOME=/tmp/.chromium \
    XDG_CACHE_HOME=/tmp/.chromium \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN.UTF-8 \
    LC_ALL=C.UTF-8

WORKDIR /app

# 创建非 root 用户
RUN addgroup -S pptruser && adduser -S -G pptruser pptruser \
    && mkdir -p /home/pptruser/Downloads /app/.next /tmp/.chromium \
    && chown -R pptruser:pptruser /home/pptruser /app /tmp/.chromium

# 先只复制依赖清单，充分利用构建缓存
# 注意：此时不能设置 NODE_ENV=production，否则 npm ci 会跳过 typescript / tailwind
# 等构建期必需的 devDependencies，后面 npm run build 会直接失败。
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

# 运行期才声明 production
ENV NODE_ENV=production

# 暴露端口
EXPOSE 3000

# 健康检查
# 走 /api/health 而不是首页：这个接口只报进程自身状态，不会产生任何副作用，
# 也不会因为渲染页面而额外占用资源。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/health > /dev/null || exit 1

# 用 tini 作为 PID 1 启动，避免 Chromium 僵尸进程堆积
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "start"]
