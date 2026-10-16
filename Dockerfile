# Cartblox multiplayer server -- Render builds this file.
# Keep it named exactly "Dockerfile" (no extension) in the ROOT of your repo.
FROM node:20-alpine

WORKDIR /app

# install the server's dependencies first (cached unless package.json changes)
COPY server/package*.json ./
RUN npm install --omit=dev

# then copy the server code
COPY server/ ./

ENV NODE_ENV=production
# Render sets $PORT for you (default 10000); server.js listens on it.
EXPOSE 10000

CMD ["node", "server.js"]
