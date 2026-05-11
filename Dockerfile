# syntax=docker/dockerfile:1.6

# ── Build stage ─────────────────────────────────────────────────────
# Compiles the Vite frontend and installs the full dependency set we
# need to do so. Everything here is thrown away after the static assets
# and runtime node_modules have been copied into the slim runtime image.
FROM node:22-alpine AS build

WORKDIR /app

# Install deps first so a code-only change reuses the layer.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# Copy the rest of the source and build the frontend.
COPY . .
RUN npm run build

# Now prune dev dependencies so the runtime image carries only what the
# Node server actually needs at request time.
RUN npm prune --omit=dev


# ── Runtime stage ───────────────────────────────────────────────────
# Tiny image with Node + production node_modules + built static assets.
# No build tools, no source-only files beyond what server.js imports.
FROM node:22-alpine AS runtime

# Drop privileges. The `node` user is bundled with the official image.
USER node
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV TRUST_PROXY=true

# Copy production deps + built frontend + server entrypoint + the API
# handlers and shared libs the server loads dynamically at startup.
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist         ./dist
COPY --chown=node:node --from=build /app/server.js    ./server.js
COPY --chown=node:node --from=build /app/package.json ./package.json
COPY --chown=node:node --from=build /app/api          ./api
COPY --chown=node:node --from=build /app/lib          ./lib

EXPOSE 3000

# Lightweight liveness probe. Hits our /api/health endpoint, which
# returns 200 without touching the database. `wget` is in BusyBox so
# we don't need to add curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
