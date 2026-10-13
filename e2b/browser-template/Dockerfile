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

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npx playwright install --with-deps chromium

COPY browser-agent.mjs browser-client.mjs web-bot-auth.mjs kernel-controller.mjs ./
COPY browser-conditions.mjs ./
COPY chusky-vnc.html /usr/share/novnc/chusky-vnc.html
RUN chmod a+rx /app/node_modules/agent-browser/bin/agent-browser-linux-x64 \
    && chmod -R a+rX /opt/ms-playwright /app \
    && useradd --create-home --shell /bin/bash chusky \
    && mkdir -p /home/chusky/.cache/chusky-browser \
    && chown -R chusky:chusky /home/chusky

USER chusky
ENV HOME=/home/chusky

# Install Google's Chrome for Testing through the pinned agent-browser release.
# The controller launches this stable path for local E2B sessions; Playwright's
# Chromium remains installed only as an explicit compatibility fallback.
RUN /app/node_modules/.bin/agent-browser install

USER root
RUN chrome_path="$(find /home/chusky/.agent-browser/browsers -type f -name chrome | sort | tail -n 1)" \
    && test -n "$chrome_path" \
    && ln -s "$chrome_path" /usr/local/bin/chrome-for-testing

USER chusky
ENV CHUSKY_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chrome-for-testing

# E2B's public port proxy only exposes declared template ports. The dedicated
# browser runtime attaches over CDP and can optionally return the owner-only
# noVNC live view, while the existing Chusky browser agent continues to use its
# internal command port.
EXPOSE 9222 6080 8765
