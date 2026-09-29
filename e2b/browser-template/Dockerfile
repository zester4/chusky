FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libnspr4 libnss3 \
    libu2f-udev libvulkan1 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxrandr2 xdg-utils xvfb fluxbox x11vnc novnc websockify ffmpeg \
    && printf '{"name":"noVNC","version":"%s"}' "$(dpkg-query -W novnc | cut -f2)" > /usr/share/novnc/package.json \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./package.json
RUN npm install --omit=dev --ignore-scripts && npx playwright install --with-deps chromium

COPY browser-agent.mjs /app/browser-agent.mjs
COPY browser-client.mjs /app/browser-client.mjs
RUN chmod -R a+rX /opt/ms-playwright /app \
    && useradd --create-home --shell /bin/bash chusky \
    && mkdir -p /home/chusky/.cache/chusky-browser \
    && chown -R chusky:chusky /home/chusky

USER chusky
ENV HOME=/home/chusky
