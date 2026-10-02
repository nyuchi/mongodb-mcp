# Nyuchi data relay: Node 24 (the relay) + Apache Doris MCP 1.0 (Python 3.12,
# run by the relay as a stdio child process).
#
# The build context is the REPOSITORY ROOT, because the relay shares
# src/relay-signing.ts with the Worker. Deploy from the root with:
#
#   fly deploy . --config relay/fly.toml --dockerfile relay/Dockerfile
FROM node:24-bookworm-slim

# Debian bookworm ships Python 3.11 and Doris MCP needs >= 3.12, so uv fetches
# a standalone 3.12 and installs the pinned release into its own environment.
COPY --from=ghcr.io/astral-sh/uv:0.12.22 /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_TOOL_DIR=/opt/uv/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin
RUN uv tool install --python 3.12 doris-mcp-server==1.0.0 \
    && doris-mcp-server --help >/dev/null

WORKDIR /app
# Marks the copied .ts files as ES modules for Node's type stripping.
RUN printf '{"type":"module","private":true}\n' > package.json
COPY src/relay-signing.ts src/relay-signing.ts
COPY relay/package.json relay/package-lock.json relay/
RUN cd relay && npm ci --omit=dev --no-audit --no-fund
COPY relay/src relay/src

# Doris MCP writes ./logs relative to its working directory.
RUN install -d -o node -g node /var/lib/doris-mcp
ENV NODE_ENV=production \
    DORIS_MCP_WORKDIR=/var/lib/doris-mcp
USER node
WORKDIR /app/relay
EXPOSE 8080
CMD ["node", "src/main.ts"]
