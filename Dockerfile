FROM node:20-alpine

# better-sqlite3 trenger build-verktøy for å kompileres på Alpine
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

RUN mkdir -p /app/data

EXPOSE 3060

CMD ["node", "server.js"]
