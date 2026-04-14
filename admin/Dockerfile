# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

# Copy workspace root files needed for pnpm install and version
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Copy package.json files for both shared and admin packages
COPY shared/package.json ./shared/
COPY admin/package.json ./admin/

# Install dependencies for both packages
RUN pnpm install --frozen-lockfile --filter @bifrost/shared --filter bifrost-dashboard

# Copy source files for both packages
COPY shared/ ./shared/
COPY admin/ ./admin/

# Build shared package first, then admin
WORKDIR /app/shared
RUN pnpm run build

WORKDIR /app/admin

# Build args for environment variables
# Note: ADMIN_API_KEY is NOT a build arg — pass it as a runtime env var to the container.
ARG VITE_API_URL=https://yourdomain.com

# Build the application
RUN VITE_API_URL=$VITE_API_URL pnpm run build

# Production stage
FROM nginx:alpine

# Copy built assets
COPY --from=builder /app/admin/dist /usr/share/nginx/html

# Copy nginx configuration
COPY admin/nginx.conf /etc/nginx/conf.d/default.conf

# Copy startup script (generates env-config.js at container start)
COPY admin/scripts/start.sh /start.sh
RUN chmod +x /start.sh

# Expose port
EXPOSE 3001

# Start via script so env-config.js is written before nginx serves requests
CMD ["/start.sh"]
