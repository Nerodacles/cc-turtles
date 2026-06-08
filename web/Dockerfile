# Build from the REPO ROOT so lib/version.lua is in context:
#   docker build -f web/Dockerfile -t <img> .
FROM node:22-alpine
WORKDIR /app/web
COPY web/package.json ./
RUN npm install --omit=dev
COPY web/server.js ./
COPY web/public ./public
COPY lib/version.lua /app/lib/version.lua
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
