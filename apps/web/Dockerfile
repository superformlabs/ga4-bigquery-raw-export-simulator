# Container for apps/web (the Next.js UI) and, inside it, the documentation
# site of apps/docs-site, served at /docs (decision D-87). Owner: the deploy
# role; the ui role changed the documentation steps.
#
# Build from the REPOSITORY ROOT, not from this folder: the apps are npm
# workspaces that share one package-lock.json at the root.
#
#   docker build -f apps/web/Dockerfile --build-arg API_URL=https://<api host> -t ga4fake-web .
#
# API_URL is where next.config.ts forwards /api/* and /auth/*. Next.js
# resolves rewrites when `next build` runs, so the API URL is a BUILD argument
# here, and infra/deploy-app.sh builds this image after the API is deployed.
# The same value is also set as a runtime environment variable, so the two
# never disagree.
#
# In this project the build runs on Cloud Build via infra/deploy-app.sh
# (there is no Docker on the laptop); see infra/cloudbuild-app.yaml.

# --- 1. The documentation site, then next build -----------------------------
FROM node:22-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Every workspace's package.json, because npm reads them all from the one
# lockfile, whichever workspace it is asked to install.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/docs-site/package.json apps/docs-site/
RUN npm ci --workspace apps/web --workspace apps/docs-site
# The documentation site first: `next build` reads apps/web/public, so the
# site has to be in it by then.
COPY apps/docs-site apps/docs-site
ARG SITE_URL=http://localhost:3000
ENV SITE_URL=${SITE_URL}
RUN npm run build --workspace apps/docs-site
COPY apps/web apps/web
RUN mkdir -p apps/web/public && rm -rf apps/web/public/docs && cp -r apps/docs-site/build apps/web/public/docs
ARG API_URL=http://localhost:3001
ENV API_URL=${API_URL}
RUN npm run build --workspace apps/web && rm -rf apps/web/.next/cache

# --- 2. Runtime: production dependencies plus the build output -------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/docs-site/package.json apps/docs-site/
# The documentation site is already built, so none of its own dependencies
# are installed here: only the web app's.
RUN npm ci --workspace apps/web --omit=dev && npm cache clean --force
COPY apps/web/next.config.ts apps/web/
COPY --from=build /app/apps/web/.next apps/web/.next
# The documentation site, as plain files. `next start` reads this folder at
# every request, so it belongs to the runtime stage and not only to the build.
COPY --from=build /app/apps/web/public apps/web/public
ARG API_URL=http://localhost:3001
ENV API_URL=${API_URL}

# Cloud Run sets PORT (8080 by default); `next start` listens on it.
USER node
EXPOSE 8080
WORKDIR /app/apps/web
CMD ["node", "/app/node_modules/next/dist/bin/next", "start"]
