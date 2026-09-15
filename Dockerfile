FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts

FROM deps AS build
COPY tsconfig.json biome.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node","dist/src/main.js"]
