# Node.js Base Image - Use LTS Alpine for smaller size
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install system dependencies for image processing and PostgreSQL
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    pixman-dev \
    postgresql-client \
    curl

# Copy package files first for better caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY . .

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S discordbot -u 1001 -G nodejs

# Set ownership of app directory
RUN chown -R discordbot:nodejs /app

# Switch to non-root user
USER discordbot

# Expose port for health checks
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the bot
CMD ["npm", "start"]
