FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git tini \
    && cloudflared_arch="$(dpkg --print-architecture)" \
    && case "${cloudflared_arch}" in amd64) cloudflared_arch=amd64 ;; arm64) cloudflared_arch=arm64 ;; armhf) cloudflared_arch=arm ;; *) echo "Unsupported cloudflared architecture: ${cloudflared_arch}" >&2; exit 1 ;; esac \
    && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cloudflared_arch}" -o /usr/local/bin/cloudflared \
    && chmod 0755 /usr/local/bin/cloudflared \
    && cloudflared --version \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run panel:build

ENV NODE_ENV=production
ENV STM_DOCKER=1
EXPOSE 7860
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--", "node", "--import", "tsx", "apps/manager-server/src/main.ts"]
