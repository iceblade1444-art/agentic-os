# Agentic OS — full app (SPA + backend) in one container
FROM node:22-alpine

WORKDIR /app

# Install production deps first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev
RUN npm install -g @anthropic-ai/claude-code@2.1.214

# App source
COPY . .

ENV NODE_ENV=production
ENV PORT=8787
# Persist the datastore on a mounted volume
ENV DATA_DIR=/app/data
ENV CLAUDE_CODE_WORKDIR=/app/work
VOLUME ["/app/data"]

EXPOSE 8787
CMD ["node", "server/index.js"]
