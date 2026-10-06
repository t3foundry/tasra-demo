# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: install dependencies and build the React frontend.
#
# The server is executed directly from TypeScript via `tsx` at runtime, so the
# full node_modules tree (including devDependencies such as tsx/esbuild) is
# carried into the final image.
# ---------------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# package.json + lockfile + the postinstall script (which copies pdfjs assets).
# `npm ci` runs the postinstall hook, which needs `scripts/` to be present.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

# The rest of the source. .dockerignore keeps node_modules, server/.tasra,
# web/dist and web/public/pdf-assets out of the build context.
COPY . .

# Optional Web3Forms key baked into the client bundle, provided by the CI action.
ARG VITE_WEB3FORMS_ACCESS_KEY=""
ENV VITE_WEB3FORMS_ACCESS_KEY=${VITE_WEB3FORMS_ACCESS_KEY}

# Type-check both projects and build the web bundle into web/dist.
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: runtime.
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

# Set PUBLIC_ORIGIN to the public https:// URL behind the TLS proxy (e.g.
# https://demo.tasra.network) so credential offers advertise an HTTPS issuer.
# Set TRUST_PROXY=1 as an alternative when the proxy sets X-Forwarded-*.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4177 \
    TASRA_SIGN_DATA=/data

WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/web ./web
COPY --from=build /app/shared ./shared

# Mutable state (service.json, wallets, requests, SDK journals) lives here.
# Run unprivileged: the `node` user owns `/data`. A named volume mounted at
# /data inherits this ownership. For a host bind mount, `chown 1000:1000` the
# directory first (or run with `--user 0`) if the node user cannot write.
RUN mkdir -p /data && chown node:node /data

# Bootstrap entrypoint: run `npm run setup` on first start (creating the funded
# creator + issuer identity from TASRA_CREATOR_KEY/TASRA_ISSUER_SEED when set,
# or generating fresh keys), then launch the server. Idempotent: setup re-runs
# reuse saved state, and the server refuses to start without service.json.
ENTRYPOINT ["sh", "-c"]
CMD ["[ -f /data/service.json ] || node --import tsx server/setup.ts; exec node --import tsx server/index.ts"]

USER node

EXPOSE 4177
VOLUME ["/data"]