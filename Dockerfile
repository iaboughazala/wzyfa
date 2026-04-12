FROM node:18-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk fonts-noto-color-emoji && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "server.js"]
