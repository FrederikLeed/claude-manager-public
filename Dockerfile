# Stage 1: Build frontend
FROM node:22-alpine AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY vite.config.js tailwind.config.js postcss.config.js index.html ./
COPY src/ ./src/
COPY shared/ ./shared/
RUN npm run build

# Stage 2: Production image
FROM node:22-alpine
WORKDIR /app

# Install build deps for better-sqlite3, compile, then remove
RUN apk add --no-cache --virtual .build-deps python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev && apk del .build-deps

# Copy server code and built frontend
COPY server/ ./server/
COPY shared/ ./shared/
COPY --from=frontend /app/dist ./dist/

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

CMD ["node", "server/index.js"]
