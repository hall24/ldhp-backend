# Production image for the Living Data API.
# Build: docker build -t ldhp-api .   Run: docker run -p 3000:3000 --env-file .env ldhp-api
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle
# Run as the unprivileged user that ships with the node image.
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
