# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS base
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
# Install the committed dependency graph without dependency lifecycle scripts.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && test -f dist/src/main.js

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    ARTIFACT_DIRECTORY=/app/artifacts \
    DATA_DIRECTORY=/app/runtime \
    ZKVERIFY_NETWORK=volta \
    ALLOW_COMPETITION=false

COPY --from=production-dependencies /app/package.json /app/package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Use the downloaded official artifacts; the application pins their checksums.
COPY artifacts/manifest.json ./artifacts/manifest.json
COPY artifacts/wasm/vfy-policy.wasm ./artifacts/wasm/vfy-policy.wasm
COPY artifacts/zkey/vfy-policy_final.zkey ./artifacts/zkey/vfy-policy_final.zkey

# A fresh named volume inherits this directory's owner and permissions.
RUN mkdir -p /app/runtime \
    && chown node:node /app/runtime \
    && chmod 0700 /app/runtime

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
# Run npm start's entrypoint directly so init forwards SIGTERM to Node.
# Compose supplies environment variables; no private .env is copied into the image.
CMD ["node", "--disable-proto=throw", "dist/src/main.js"]
