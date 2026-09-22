# One file, no dependencies (native fetch, Node 18+) — nothing here needs a build step.
FROM node:22-alpine
WORKDIR /app
COPY worker.mjs .
CMD ["node", "worker.mjs"]
