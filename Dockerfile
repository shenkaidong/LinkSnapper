# 使用 Node.js 官方 Debian 镜像（glibc）。
#
# ⚠️ 关于基础镜像与浏览器版本
# 本项目用 puppeteer-core 驱动**外部** Chrome，而 puppeteer-core 21.11.0 在
# node_modules/puppeteer-core/lib/.../revisions.js 里写死了它配套的 Chrome 版本
# （121.0.6167.85）。两个版本必须对应，否则会有「页面能开但等待超时」「某些
# DevTools 协议能力缺失」这类不易察觉的故障。
#
# 早期版本用 Alpine 自带的 chromium 包，但 Alpine 是 musl libc，而 Google 的
# Chrome-for-Testing 只有 glibc 版本，二者天生不适配；再加上发行版 chromium 版本
# 会随基础镜像滚动，错位只是时间问题。所以这里改成：
#   1. 用 Debian（glibc）基础镜像；
#   2. 用 scripts/install-chrome.mjs 显式下载与 puppeteer-core 锁定的同一个
#      Chrome-for-Testing 构建，本地 / CI / Docker / k8s 全部用同一个版本。
# 这样就把「版本耦合」从「靠运维盯版本」变成「构建期就固定下来」。
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Chrome-for-Testing 运行所需的系统库（注意：不是 Alpine 的 musl 那一套）。
# noto-cjk 保证中文不出现方块；tini 作为 PID 1 回收 Chromium 僵尸进程并正确转发信号。
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    fonts-noto-cjk \
    fontconfig \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    libgtk-3-0 \
    tini \
    && rm -rf /var/lib/apt/lists/*

# 把与 puppeteer-core 锁定的 Chrome 装进 /opt/chrome，并软链到固定路径，
# 后续用 ENV CHROME_PATH 指向这个软链即可，不依赖具体版本目录名。
ENV CHROME_CACHE_DIR=/opt/chrome
RUN CHROME_PATH_MARKER=/tmp/chrome-path node scripts/install-chrome.mjs \
    && ln -sf "$(cat /tmp/chrome-path)" /usr/bin/chrome-for-testing \
    && rm -f /tmp/chrome-path

ENV CHROME_PATH=/usr/bin/chrome-for-testing \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    NEXT_TELEMETRY_DISABLED=1 \
    XDG_CONFIG_HOME=/tmp/.chromium \
    XDG_CACHE_HOME=/tmp/.chromium \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

WORKDIR /app

# 先只复制依赖清单与安装脚本，充分利用构建缓存。
# 注意：此时不能设置 NODE_ENV=production，否则 npm ci 会跳过 typescript / tailwind
# 等构建期必需的 devDependencies，后面 npm run build 会直接失败。
COPY package.json package-lock.json ./
COPY scripts/install-chrome.mjs ./scripts/install-chrome.mjs

# 清理缓存并按锁文件安装依赖
RUN npm cache clean --force && \
    npm ci --legacy-peer-deps && \
    npm cache clean --force

# 再复制源码
COPY . .

# 构建应用
RUN npm run build && \
    chown -R pptruser:pptruser /app || true

# 创建非 root 用户
RUN addgroup --system pptruser && adduser --system --ingroup pptruser pptruser \
    && mkdir -p /home/pptruser /tmp/.chromium \
    && chown -R pptruser:pptruser /home/pptruser /app /tmp/.chromium /opt/chrome

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
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
