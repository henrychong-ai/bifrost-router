#!/bin/sh
set -e

# Startup script for admin dashboard with Tailscale
# Provides HTTPS access via bifrost.your-tailnet.ts.net

echo "[startup] Starting admin dashboard with Tailscale..."

# Render the nginx config first (v1.39.0): its security headers take the
# container's values, its /api proxy adds the container's ADMIN_API_KEY (the
# browser never holds the key), and a bad or missing value must stop the
# container here, before it joins the tailnet.
echo "[startup] Rendering nginx config..."
/usr/local/bin/render-nginx-conf.sh /etc/nginx/bifrost/default.conf.template /etc/nginx/conf.d/default.conf /etc/nginx/bifrost/admin-key.conf

# nginx listens only on a Unix socket (DASHBOARD_TAILSCALE_SERVE=on in the
# image): a root-owned 0700 directory, so only root processes in this
# container (tailscaled for Serve, nginx's master) can connect, and no stale
# socket from an unclean stop, which nginx could not bind over.
mkdir -p /run/bifrost
chown root:root /run/bifrost
chmod 700 /run/bifrost
rm -f /run/bifrost/nginx.sock

# Start tailscaled in userspace networking mode (required for containers)
echo "[startup] Starting tailscaled..."
tailscaled --state=/var/lib/tailscale/tailscaled.state \
           --socket=/var/run/tailscale/tailscaled.sock \
           --tun=userspace-networking &

# Wait for tailscaled to be ready
echo "[startup] Waiting for tailscaled..."
sleep 3

# Check for auth key
if [ -z "$TAILSCALE_AUTHKEY" ]; then
    echo "[startup] ERROR: TAILSCALE_AUTHKEY not set"
    exit 1
fi

# Authenticate with Tailscale using custom hostname
HOSTNAME="${TAILSCALE_HOSTNAME:-bifrost}"
echo "[startup] Authenticating as ${HOSTNAME}..."
tailscale up --authkey="$TAILSCALE_AUTHKEY" --hostname="$HOSTNAME"

# Wait for Tailscale to be fully connected
echo "[startup] Waiting for Tailscale connection..."
sleep 2

# Verify connection
tailscale status

# Configure Tailscale Serve for HTTPS
# This exposes https://bifrost.your-tailnet.ts.net -> nginx's Unix socket.
# Serve sends `Host: localhost` to a socket, the browser's host in
# X-Forwarded-Host and the viewer's Tailscale-User-* identity, removing any a
# client sent; nginx trusts these only in this image.
echo "[startup] Configuring Tailscale Serve..."
tailscale serve --bg --https=443 unix:/run/bifrost/nginx.sock

# Show serve status
tailscale serve status

# Start nginx in the background
echo "[startup] Starting nginx..."
nginx

echo "[startup] Admin dashboard ready at https://${HOSTNAME}.your-tailnet.ts.net"

# Keep container running and forward signals
exec tail -f /dev/null
