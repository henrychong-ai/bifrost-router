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

# The bundle takes no environment: it calls its own origin, and the runtime
# nginx proxies /api to the Worker with the key (v1.39.0). ADMIN_API_KEY is a
# runtime env var of the container, never a build arg.
RUN pnpm run build

# Production stage
FROM nginx:alpine

# Copy built assets
COPY --from=builder /app/admin/dist /usr/share/nginx/html

# The nginx config template and its renderer; start.sh renders it into conf.d
# at container start from the container's environment (API_PROXY_ORIGIN,
# ADMIN_API_KEY, CSP_MODE, CSP_REPORT_ORIGIN, R2_PREVIEW_ORIGINS,
# API_PROXY_RESOLVER; see the renderer).
COPY admin/nginx.conf.template /etc/nginx/bifrost/default.conf.template
COPY admin/scripts/render-nginx-conf.sh /usr/local/bin/render-nginx-conf.sh

# Copy startup script (renders the nginx config at container start)
COPY admin/scripts/start.sh /start.sh
RUN chmod +x /start.sh /usr/local/bin/render-nginx-conf.sh

# The /api proxy verifies the Worker's certificate against this CA bundle
# (proxy_ssl_trusted_certificate): the build stops if the base image lacks it.
RUN test -s /etc/ssl/certs/ca-certificates.crt

# Remove the stock nginx site: it serves the same files without the dashboard's
# CSP and security headers, so a launch that bypasses the start script must
# find no config to serve rather than that one.
RUN rm -f /etc/nginx/conf.d/default.conf

# Expose port
EXPOSE 3001

# Start via script so the config is rendered before nginx serves requests
CMD ["/start.sh"]
