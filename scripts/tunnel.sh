#!/bin/sh
# Temporary public HTTPS tunnel to the Guardian gateway so Alebex can reach the Custom Tool
# endpoints. This is a development tunnel, not a deployment. Stop it with Ctrl+C.
PORT="${GATEWAY_PORT:-3001}"
if command -v cloudflared >/dev/null 2>&1; then
  echo "Starting a Cloudflare quick tunnel to http://127.0.0.1:${PORT} ..."
  echo "Copy the https://*.trycloudflare.com URL it prints into PUBLIC_TOOL_BASE_URL in .env, then restart the gateway."
  exec cloudflared tunnel --url "http://127.0.0.1:${PORT}"
elif command -v ngrok >/dev/null 2>&1; then
  echo "Starting an ngrok tunnel to port ${PORT} ..."
  echo "Copy the https:// forwarding URL into PUBLIC_TOOL_BASE_URL in .env, then restart the gateway."
  exec ngrok http "${PORT}"
else
  echo "No tunnel tool found. Install one (this script does not install anything):"
  echo "  brew install cloudflared      # then: pnpm tunnel"
  echo "  or: https://ngrok.com/download"
  echo "Only the /tools/* endpoints need to be reachable; every request is checked against a signed, short-lived, per-session token."
  exit 1
fi
