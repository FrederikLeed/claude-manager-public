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

# Start Claude Code at boot in the tmux session the web terminal attaches to
# (same socket/session name as server/docker.js createPTY). With
# remoteControlAtStartup the session shows up in the Claude app without anyone
# opening a terminal. Managed instances only; CM_AUTOSTART_CLAUDE=0 disables.
if [ -n "${CM_INSTANCE_ID:-}" ] && [ "${CM_AUTOSTART_CLAUDE:-1}" != "0" ] && command -v tmux >/dev/null 2>&1; then
    # ~/.claude.json is per container (not on the shared mount), so a fresh or
    # recreated container would stop at the first-run onboarding screen.
    CJ="$HOME/.claude.json"
    if ! jq -e '.hasCompletedOnboarding == true' "$CJ" >/dev/null 2>&1; then
        CC_VERSION="$(claude --version 2>/dev/null | awk '{print $1}')"
        { [ -s "$CJ" ] && cat "$CJ" || echo '{}'; } | jq --arg v "${CC_VERSION:-}" \
            '.hasCompletedOnboarding = true | .lastOnboardingVersion = $v
             | .projects["/workspace"].hasTrustDialogAccepted = true' > "$CJ.tmp" 2>/dev/null \
            && mv "$CJ.tmp" "$CJ" && chmod 600 "$CJ" \
            || echo "[entrypoint] WARNING: could not seed $CJ" >&2
    fi

    if ! tmux -L cm has-session -t main 2>/dev/null; then
        if tmux -L cm -f "$HOME/.tmux.conf" new-session -d -s main -c /workspace -x 200 -y 50; then
            tmux -L cm send-keys -t main 'cm-autostart' Enter
            echo "[entrypoint] Claude Code autostarted in tmux session 'main'"
        else
            echo "[entrypoint] WARNING: could not start tmux session for Claude autostart" >&2
        fi
    fi
fi

# Note: Node.js proxy bootstrap (https-proxy-agent) is activated via .bashrc
# (entrypoint env doesn't persist to interactive shells started via terminal)

exec "$@"
