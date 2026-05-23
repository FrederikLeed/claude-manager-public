#!/bin/bash
# Convenience script for local development
# Requires Docker socket access and Node.js 22+

set -e

echo "Starting Claude Manager in development mode..."
echo "  Backend: http://localhost:3001"
echo "  Frontend: http://localhost:5173"
echo ""

export NODE_ENV=development
export DATA_DIR="${DATA_DIR:-./data}"

mkdir -p "$DATA_DIR"

npx concurrently \
  -n "server,client" \
  -c "blue,green" \
  "node server/index.js" \
  "npx vite"
