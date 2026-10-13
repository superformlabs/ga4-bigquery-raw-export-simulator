# Container for apps/api (the backend). Owner: the deploy role.
#
# Build from the REPOSITORY ROOT, not from this folder: the two apps are npm
# workspaces that share one package-lock.json at the root.
#
#   docker build -f apps/api/Dockerfile --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t ga4fake-api .
#
# In this project the build runs on Cloud Build via infra/deploy-app.sh
# (there is no Docker on the laptop); see infra/cloudbuild-app.yaml.
#
# Runtime configuration is all environment variables (see apps/api/.env.example
# and apps/api/README.md). The image contains no .env file and no infra/IMAGE,
# so GENERATOR_IMAGE must be set by whoever runs the container.

# --- 1. Compile TypeScript to apps/api/dist ---------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/api
COPY apps/api/tsconfig.json apps/api/
COPY apps/api/src apps/api/src
RUN npm run build --workspace apps/api

# --- 2. Runtime: production dependencies plus the compiled output ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/api --omit=dev && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist

# Reported by GET /api/health. The runtime image has no git and no .git folder.
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}

# Cloud Run sets PORT (8080 by default); src/config.ts reads it.
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
