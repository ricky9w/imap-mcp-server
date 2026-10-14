# Optional example image for `imap-mcp-server serve`. Build from the repo root:
#   docker build -f examples/docker/Dockerfile -t imap-mcp .
# Run, publishing the port only as widely as you need, with a volume for the
# accounts, key, tokens and audit log ($HOME/.imap-mcp = /data/.imap-mcp):
#   docker run -d -p 127.0.0.1:8765:8765 -v imap-mcp:/data imap-mcp
# The admin token is in /data/.imap-mcp/admin-token unless you pass
# IMAP_MCP_WIZARD_TOKEN.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY build.mjs tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
ENV HOME=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8765
# Inside the container the server must listen on all interfaces.
CMD ["node", "dist/index.js", "serve", "--host", "0.0.0.0", "--port", "8765"]
