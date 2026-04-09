FROM node:22-alpine

RUN apk add --no-cache openssh-client

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY sql/ ./sql/

RUN npm run build

EXPOSE 3001

CMD ["node", "dist/index.js"]
