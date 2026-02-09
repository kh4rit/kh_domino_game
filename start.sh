#!/bin/bash
# Full startup: Cloudflare tunnel + Domino bot
# Usage: ./start.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Kill any existing processes
pkill -f "cloudflared.*tunnel.*8000" 2>/dev/null || true
pkill -f "python -m bot.main" 2>/dev/null || true
sleep 1

TUNNEL_LOG="/tmp/cloudflared.log"

echo "Starting Cloudflare tunnel..."
cloudflared tunnel --url http://localhost:8000 --no-tls-verify > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

# Wait for the tunnel URL to appear in logs
echo "Waiting for tunnel URL..."
TUNNEL_URL=""
for i in $(seq 1 30); do
    TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
    if [ -n "$TUNNEL_URL" ]; then
        break
    fi
    sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
    echo "ERROR: Failed to get tunnel URL after 30 seconds."
    echo "Tunnel log:"
    cat "$TUNNEL_LOG"
    kill $TUNNEL_PID 2>/dev/null
    exit 1
fi

echo "Tunnel URL: $TUNNEL_URL"

# Update .env with the tunnel URL
sed -i "s|^BASE_URL=.*|BASE_URL=$TUNNEL_URL|" "$SCRIPT_DIR/.env"

echo ""
echo "==================================================="
echo "  IMPORTANT: Set this URL as your Mini App URL"
echo "  in @BotFather -> /mybots -> your bot -> Bot Settings -> Menu Button or Mini App"
echo ""
echo "  Tunnel URL: $TUNNEL_URL"
echo "==================================================="
echo ""

# Trap to kill tunnel on exit
cleanup() {
    echo "Shutting down..."
    kill $TUNNEL_PID 2>/dev/null
    pkill -f "python -m bot.main" 2>/dev/null || true
    exit 0
}
trap cleanup EXIT INT TERM

# Start the bot + web server
echo "Starting domino bot..."
source venv/bin/activate
exec python -m bot.main
