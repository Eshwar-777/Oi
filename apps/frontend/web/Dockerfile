FROM node:20-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages

ARG VITE_OI_API_URL
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_STORAGE_BUCKET
ARG VITE_FIREBASE_APP_ID
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
ARG VITE_FIREBASE_MEASUREMENT_ID
ARG VITE_BYPASS_WEB_AUTH=false

ENV VITE_OI_API_URL=$VITE_OI_API_URL
ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY
ENV VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN
ENV VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID
ENV VITE_FIREBASE_STORAGE_BUCKET=$VITE_FIREBASE_STORAGE_BUCKET
ENV VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID
ENV VITE_FIREBASE_MESSAGING_SENDER_ID=$VITE_FIREBASE_MESSAGING_SENDER_ID
ENV VITE_FIREBASE_MEASUREMENT_ID=$VITE_FIREBASE_MEASUREMENT_ID
ENV VITE_BYPASS_WEB_AUTH=$VITE_BYPASS_WEB_AUTH

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @oi/web build

FROM nginx:1.27-alpine

ENV OYE_DOWNLOAD_DESKTOP_MAC_URL=https://github.com/Eshwar-777/Oi/releases/download/desktop-latest/oye-desktop-mac.dmg
ENV OYE_DOWNLOAD_DESKTOP_WINDOWS_URL=https://github.com/Eshwar-777/Oi/releases/download/desktop-latest/oye-desktop-windows.exe
ENV OYE_DOWNLOAD_DESKTOP_LINUX_URL=https://github.com/Eshwar-777/Oi/releases/download/desktop-latest/oye-desktop-linux.AppImage
ENV OYE_DOWNLOAD_EXTENSION_URL=https://github.com/Eshwar-777/Oi/releases/download/extension-latest/oye-extension.zip
ENV OYE_DOWNLOAD_ANDROID_APK_URL=https://github.com/Eshwar-777/Oi/releases/download/android-apk-latest/oye-mobile-android.apk

COPY apps/frontend/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=builder /workspace/apps/frontend/web/dist /usr/share/nginx/html

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
