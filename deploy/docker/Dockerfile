FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run panel:build

ENV NODE_ENV=production
ENV STM_DOCKER=1
EXPOSE 7860
VOLUME ["/data"]

CMD ["node", "--import", "tsx", "apps/manager-server/src/main.ts"]
