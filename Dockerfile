# 使用Node.js官方镜像
FROM node:lts-alpine

# 安装Chrome和其依赖，以及中文字体
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    nodejs \
    yarn \
    font-noto \
    font-noto-cjk \
    font-noto-emoji \
    fontconfig

# 设置字体配置
RUN fc-cache -fv

# 设置Chrome环境变量
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    CHROME_PATH=/usr/bin/chromium-browser \
    CHROME_BIN=/usr/bin/chromium-browser \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN.UTF-8 \
    LC_ALL=C.UTF-8

# 设置工作目录
WORKDIR /app

# 创建非root用户
RUN addgroup -S pptruser && adduser -S -G pptruser pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser \
    && chown -R pptruser:pptruser /app

# 首先只复制package文件
COPY package*.json ./

# 清理npm缓存并安装依赖
RUN npm cache clean --force && \
    npm ci --legacy-peer-deps

# 复制其他源代码文件
COPY . .

# 构建应用
RUN npm run build && \
    chown -R pptruser:pptruser /app

# 切换到非root用户
USER pptruser

# 暴露3000端口
EXPOSE 3000

# 启动应用
CMD ["npm", "start"] 