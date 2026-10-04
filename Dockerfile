FROM node:22-bookworm-slim

ARG SOURCE_REVISION=local-dev
ARG RELEASE_VERSION=local-dev
LABEL org.opencontainers.image.source="https://github.com/19Chris19/ima-qa-web-agent" \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.version=$RELEASE_VERSION

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY src ./src
COPY scripts ./scripts
COPY provider-a-server.js ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "provider-a-server.js"]
