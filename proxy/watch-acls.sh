#!/bin/bash
# Start squid and watch for ACL file changes to trigger reconfigure.
set -euo pipefail

ACL_DIR="/etc/squid/acl"

echo "[proxy] Starting squid..."
squid -f /etc/squid/squid.conf -NYC &
SQUID_PID=$!

# Wait for squid to be ready
sleep 2

echo "[proxy] Watching $ACL_DIR for changes..."
# Watch for ACL file changes and reconfigure squid
inotifywait -m -r -e modify,create,delete,moved_to "$ACL_DIR" 2>/dev/null | while read -r dir event file; do
    echo "[proxy] ACL change detected: $event $file — reconfiguring squid"
    squid -k reconfigure 2>/dev/null || true
done &

# Wait for squid process
wait $SQUID_PID
