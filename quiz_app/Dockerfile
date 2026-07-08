# 零依賴輕量 node 映像;非 root 執行(沿用 exam_app 慣例)
FROM node:20.18.1-alpine

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY seed_question_pool.json ./
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data
USER node

ENV PORT=8090 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8090
CMD ["node", "server.js"]
