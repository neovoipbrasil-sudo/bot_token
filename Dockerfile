FROM node:20-slim
WORKDIR /app
RUN npm install -g @anthropic-ai/claude-code@2.1.270
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3300
CMD ["node", "src/bot/bootstrap.js"]
