FROM node:20-bookworm-slim AS build

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/automation-runtime/package.json apps/automation-runtime/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @oi/automation-runtime build


FROM node:20-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/apps/automation-runtime/package.json ./apps/automation-runtime/package.json
COPY --from=build /app/apps/automation-runtime/node_modules ./apps/automation-runtime/node_modules
COPY --from=build /app/apps/automation-runtime/dist ./apps/automation-runtime/dist
COPY --from=build /app/apps/automation-runtime/vendor ./apps/automation-runtime/vendor
COPY --from=build /app/apps/automation-runtime/src/vendor ./apps/automation-runtime/src/vendor

ENV NODE_ENV=production
ENV AUTOMATION_RUNTIME_HOST=0.0.0.0
ENV AUTOMATION_RUNTIME_PORT=8787
ENV OI_RUNNER_CHROME_PATH=/usr/bin/chromium

WORKDIR /app/apps/automation-runtime

EXPOSE 8787

CMD ["node", "dist/index.js"]
