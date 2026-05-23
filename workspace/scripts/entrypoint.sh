#!/bin/bash
set -euo pipefail

# Ensure workspace .claude directory exists (mount point for project memory)
if [ ! -d "/workspace/.claude" ]; then
    mkdir -p /workspace/.claude 2>/dev/null || true
fi

# Check Claude auth
if [ ! -d "/home/claude/.claude" ] || [ -z "$(ls -A /home/claude/.claude 2>/dev/null)" ]; then
    echo -e "\033[1;33mWARNING: Claude auth not found. Run 'claude login' to authenticate.\033[0m"
fi

# Network policy enforcement — lock outbound to proxy only
if [ -n "${CM_NETWORK_POLICY:-}" ] && [ "$CM_NETWORK_POLICY" != "unrestricted" ] && [ -n "${HTTPS_PROXY:-}" ]; then
    echo "[entrypoint] Network policy: ${CM_NETWORK_POLICY} (enforced via proxy)"
    echo "[entrypoint] Proxy: ${HTTPS_PROXY}"

    # Extract proxy host IP
    PROXY_HOST=$(echo "$HTTPS_PROXY" | sed 's|http://||;s|:.*||')
    PROXY_IP=$(getent hosts "$PROXY_HOST" 2>/dev/null | awk '{print $1}')

    if [ -n "$PROXY_IP" ]; then
        echo "[entrypoint] Locking outbound traffic to proxy ($PROXY_IP) + Docker internal"

        # Allow loopback
        sudo iptables -A OUTPUT -o lo -j ACCEPT

        # Allow established connections
        sudo iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

        # Allow Docker DNS
        sudo iptables -A OUTPUT -d 127.0.0.11 -p udp --dport 53 -j ACCEPT
        sudo iptables -A OUTPUT -d 127.0.0.11 -p tcp --dport 53 -j ACCEPT

        # Allow Docker internal networks (manager API, proxy, LiteLLM)
        sudo iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT
        sudo iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT
        sudo iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT

        # Block everything else with instant rejection
        sudo iptables -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset
        sudo iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable

        echo "[entrypoint] Firewall locked — direct internet access blocked"
    else
        echo "[entrypoint] WARNING: Could not resolve proxy host '$PROXY_HOST', skipping firewall lock"
    fi
fi

# Note: Node.js proxy bootstrap (https-proxy-agent) is activated via .bashrc
# (entrypoint env doesn't persist to interactive shells started via terminal)

exec "$@"
