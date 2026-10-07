#!/bin/sh
# Startup script for the admin dashboard image (admin/Dockerfile).
set -e

# Render the nginx config first (v1.39.0): its security headers take the
# container's values, its /api proxy adds the container's ADMIN_API_KEY (the
# browser never holds the key), and a bad or missing value must stop the
# container here.
echo "[startup] Rendering nginx config..."
/usr/local/bin/render-nginx-conf.sh /etc/nginx/bifrost/default.conf.template /etc/nginx/conf.d/default.conf /etc/nginx/bifrost/admin-key.conf

echo "[startup] Starting nginx..."
exec nginx -g 'daemon off;'
