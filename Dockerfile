FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY *.mjs ./

CMD ["node", "worker.mjs"]