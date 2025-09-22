# Node.js Base Image
FROM node:18-alpine

# System dependencies für Canvas und SQLite
RUN apk add --no-cache \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    musl-dev \
    giflib-dev \
    pixman-dev \
    pangomm-dev \
    libjpeg-turbo-dev \
    freetype-dev \
    python3 \
    make \
    g++

# Arbeitsverzeichnis erstellen
WORKDIR /app

# Package files kopieren
COPY package*.json ./

# Dependencies installieren
RUN npm install --only=production

# App Code kopieren
COPY . .

# Port exposieren (optional für Health Checks)
EXPOSE 3000

# Datenbank Ordner erstellen
RUN mkdir -p /app/data

# User für Sicherheit
RUN addgroup -g 1001 -S nodejs
RUN adduser -S discordbot -u 1001
RUN chown -R discordbot:nodejs /app
USER discordbot

# Bot starten
CMD ["npm", "start"]
