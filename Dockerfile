# 结婴之战 · 运行镜像（零依赖，只有 Node 标准库）
FROM node:20-alpine

WORKDIR /app

# 只拷运行时需要的东西（卡池是数据，挂载覆盖即可改卡）
COPY server ./server
COPY public ./public
COPY data ./data
COPY tools/editor ./tools/editor

ENV PORT=8094
ENV HOST=0.0.0.0
EXPOSE 8094

# 镜像里自带 wget（busybox），直接探活
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || exit 1

CMD ["node", "server/index.js"]
