# 零依賴，採輕量 node 映像。釘住明確版本（避免浮動 tag）。非 root 執行。
FROM node:20.18.1-alpine

WORKDIR /app
# 只複製需要的檔（無 npm install，因為零依賴）
COPY package.json ./
COPY server.js ./
COPY public ./public

# 排行榜持久化目錄：建立並交給 node 使用者（持久磁碟掛載於此）
RUN mkdir -p /data && chown -R node:node /data

# 以非 root 使用者執行（node 映像內建 node 使用者）
USER node

ENV PORT=8080 DATA_DIR=/data
# 宣告持久卷（Zeabur 會為此路徑建立持久磁碟，重新部署不丟資料）
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server.js"]
