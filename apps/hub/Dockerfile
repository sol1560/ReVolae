# hub（含云端大脑 + 云电脑）镜像。在仓库根目录构建：docker build -f apps/hub/Dockerfile .
FROM oven/bun:1.3.10-slim
WORKDIR /app

# 先拷各 workspace 的 package.json 装依赖（只装 hub 用到的那部分），利用层缓存
COPY package.json bun.lock bunfig.toml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/brain/package.json packages/brain/
COPY packages/cloud-computer/package.json packages/cloud-computer/
COPY packages/client/package.json packages/client/
COPY apps/hub/package.json apps/hub/
COPY apps/poc-web/package.json apps/poc-web/
COPY apps/mobile/package.json apps/mobile/
COPY firmware/dongle/calibration/package.json firmware/dongle/calibration/
RUN bun install --filter '@cuaremote/hub' --production

COPY packages/protocol packages/protocol
COPY packages/brain packages/brain
COPY packages/cloud-computer packages/cloud-computer
COPY firmware/dongle/calibration firmware/dongle/calibration
COPY apps/hub apps/hub

ENV NODE_ENV=production HUB_DB=/data/hub.db
EXPOSE 8788
CMD ["bun", "run", "apps/hub/src/server.ts"]
