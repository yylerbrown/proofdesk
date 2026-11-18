# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json tsconfig.browser.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=optional also leaves out the test tools, which the sign-in library lists as an
# optional companion and which the running server never loads.
RUN npm ci --omit=dev --omit=optional

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/app.db
ARG GIT_COMMIT=""
ENV GIT_COMMIT=${GIT_COMMIT}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY views ./views
COPY docs/assistant-run ./docs/assistant-run
COPY --from=build /app/public ./public
COPY docker-entrypoint.sh ./
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The entrypoint starts as root only to hand the mounted disk to "node", then runs the
# command below as "node".
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
