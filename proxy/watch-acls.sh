#!/bin/bash
# Start squid and watch for ACL file changes to trigger reconfigure.
set -euo pipefail

ACL_DIR="/etc/squid/acl"

# A squid killed uncleanly leaves /run/squid.pid in the container filesystem.
# On restart squid sees it and exits with "Squid is already running", so the
# container crash-looped and stayed down (Aug 2026). Nothing else runs squid
# here, so the pid file is always stale at this point.
rm -f /run/squid.pid

# Start the watcher BEFORE squid. The manager rewrites ACLs while the stack
# starts; a change made before the watcher existed was never applied, so squid
# kept a stale allow rule for an IP Docker had already handed to another
# container (seen 2026-09-16).
echo "[proxy] Watching $ACL_DIR for changes..."
inotifywait -m -r -e modify,create,delete,moved_to "$ACL_DIR" 2>/dev/null | while read -r dir event file; do
    echo "[proxy] ACL change detected: $event $file — reconfiguring squid"
    squid -k reconfigure || echo "[proxy] ERROR: squid reconfigure failed after $event $file" >&2
done &

echo "[proxy] Starting squid..."
squid -f /etc/squid/squid.conf -NYC &
SQUID_PID=$!

# Wait for squid to be ready, then reload once to pick up any ACL change that
# landed between config parse and the watcher seeing a running squid.
sleep 2
squid -k reconfigure || echo "[proxy] ERROR: initial squid reconfigure failed" >&2

# Stream squid's logs to docker logs: access log on stdout (parsed by the
# manager), cache log (errors) on stderr. Hourly rotation keeps the files small;
# tail -F follows the new file after each rotate.
tail -n0 -F /var/log/squid/access.log 2>/dev/null &
tail -n0 -F /var/log/squid/cache.log >&2 2>/dev/null &
while sleep 3600; do squid -k rotate 2>/dev/null || true; done &

# Wait for squid process
wait $SQUID_PID
