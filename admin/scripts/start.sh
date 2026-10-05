#!/bin/sh
# Startup script for the admin dashboard image (admin/Dockerfile).
set -e

# Render the nginx config first: its CSP admits the R2 preview origins
# (R2_PREVIEW_ORIGINS), and a bad value must stop the container here.
echo "[startup] Rendering nginx config..."
/usr/local/bin/render-nginx-conf.sh /etc/nginx/bifrost/default.conf.template /etc/nginx/conf.d/default.conf

# Generate runtime env config from container environment variable.
# This keeps the API key out of the Docker image and build cache entirely.
# The key is injected at container startup, not baked into the JS bundle.
echo "[startup] Writing runtime env config..."
/usr/local/bin/write-env-config.sh /usr/share/nginx/html/env-config.js

echo "[startup] Starting nginx..."
exec nginx -g 'daemon off;'
