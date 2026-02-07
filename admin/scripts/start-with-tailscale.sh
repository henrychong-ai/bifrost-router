#!/bin/sh
set -e

# Startup script for admin dashboard with Tailscale
# Provides HTTPS access via bifrost.<your-tailnet>.ts.net

echo "[startup] Starting admin dashboard with Tailscale..."

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
# This exposes https://bifrost.<your-tailnet>.ts.net -> localhost:3001
echo "[startup] Configuring Tailscale Serve..."
tailscale serve --bg --https=443 http://localhost:3001

# Show serve status
tailscale serve status

# Start nginx in the background
echo "[startup] Starting nginx..."
nginx

echo "[startup] Admin dashboard ready at https://${HOSTNAME}.<your-tailnet>.ts.net"

# Keep container running and forward signals
exec tail -f /dev/null
