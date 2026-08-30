FROM node:24-bookworm-slim

WORKDIR /workspace
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY . .
RUN npm run verify:core

CMD ["npm", "run", "test:core"]
