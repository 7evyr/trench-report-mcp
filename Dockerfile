# Trench Report MCP server (stdio). No dependencies: the bundle in dist/ is self-contained.
FROM node:22-alpine
WORKDIR /app
COPY dist/ ./dist/
USER node
ENTRYPOINT ["node", "dist/trench-report-mcp.mjs"]
