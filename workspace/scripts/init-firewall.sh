#!/bin/bash
# init-firewall.sh — Network egress policy enforcement for Claude workspace containers.
# Written from scratch for claude-manager. Apache-2.0 compatible.
#
# Usage: init-firewall.sh <policy-file>
# Called by entrypoint.sh when a policy file is mounted.
# Exits 0 on success, 1 on failure (fail closed).

set -euo pipefail

POLICY_FILE="${1:-}"

if [ -z "$POLICY_FILE" ] || [ ! -f "$POLICY_FILE" ]; then
    echo "[firewall] No policy file found, skipping firewall setup"
    exit 0
fi

# Check for unrestricted policy
if grep -q "^unrestricted: true" "$POLICY_FILE" 2>/dev/null; then
    echo "[firewall] Policy is unrestricted, skipping firewall setup"
    exit 0
fi

echo "[firewall] Applying network policy from $POLICY_FILE"

# Parse allowed hosts from YAML (simple line-based parsing, no YAML library needed)
ALLOWED_HOSTS=()
IN_HOSTS=false
while IFS= read -r line; do
    # Trim whitespace
    trimmed=$(echo "$line" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')

    # Skip comments and empty lines
    [[ -z "$trimmed" || "$trimmed" == \#* ]] && continue

    if [[ "$trimmed" == "allowed_hosts:" ]]; then
        IN_HOSTS=true
        continue
    fi

    if $IN_HOSTS; then
        # Stop if we hit a non-list line (new YAML key)
        if [[ "$trimmed" != -* ]]; then
            IN_HOSTS=false
            continue
        fi
        # Extract hostname (strip "- " prefix)
        host=$(echo "$trimmed" | sed 's/^-[[:space:]]*//')
        if [ -n "$host" ]; then
            ALLOWED_HOSTS+=("$host")
        fi
    fi
done < "$POLICY_FILE"

if [ ${#ALLOWED_HOSTS[@]} -eq 0 ]; then
    echo "[firewall] ERROR: No allowed hosts found in policy file"
    exit 1
fi

echo "[firewall] Allowed hosts: ${ALLOWED_HOSTS[*]}"

# Create ipset for allowed IPs
ipset create allowed-hosts hash:ip -exist
ipset flush allowed-hosts

# Resolve each host and add IPs to ipset
FIRST_ALLOWED=""
for host in "${ALLOWED_HOSTS[@]}"; do
    # Resolve A records (filter strictly for IPv4 addresses, ignore CNAMEs/empty)
    while IFS= read -r ip; do
        [ -z "$ip" ] && continue
        [ "$ip" = "0.0.0.0" ] && continue
        ipset add allowed-hosts "$ip" -exist
        [ -z "$FIRST_ALLOWED" ] && FIRST_ALLOWED="$host"
    done < <(dig +short A "$host" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
done

echo "[firewall] Resolved $(ipset list allowed-hosts | grep -c '^[0-9]' || echo 0) unique IPs"

# Flush existing rules
iptables -F OUTPUT 2>/dev/null || true
iptables -F INPUT 2>/dev/null || true

# Allow loopback
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT

# Allow established/related connections (responses to allowed outbound)
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow Docker DNS (127.0.0.11)
iptables -A OUTPUT -d 127.0.0.11 -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -d 127.0.0.11 -p tcp --dport 53 -j ACCEPT
iptables -A INPUT -s 127.0.0.11 -p udp --sport 53 -j ACCEPT
iptables -A INPUT -s 127.0.0.11 -p tcp --sport 53 -j ACCEPT

# Allow host network (for LiteLLM proxy and manager communication)
HOST_GW=$(cat /proc/net/route 2>/dev/null | awk '$2 == "00000000" {printf "%d.%d.%d.%d", "0x"substr($3,7,2), "0x"substr($3,5,2), "0x"substr($3,3,2), "0x"substr($3,1,2)}' || true)
if [ -n "$HOST_GW" ]; then
    HOST_NET=$(echo "$HOST_GW" | sed 's/\.[0-9]*$/.0\/16/')
    iptables -A OUTPUT -d "$HOST_NET" -j ACCEPT
    iptables -A INPUT -s "$HOST_NET" -j ACCEPT
fi

# Allow all IPs in the allowed-hosts ipset
iptables -A OUTPUT -m set --match-set allowed-hosts dst -j ACCEPT

# Reject everything else with immediate TCP RST / ICMP unreachable
# (REJECT instead of DROP so blocked connections fail instantly, not after 60s timeout)
iptables -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset
iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable
iptables -A INPUT -j REJECT --reject-with icmp-port-unreachable

echo "[firewall] iptables rules applied with REJECT (instant failure for blocked hosts)"

# Verification: test DNS still works (required for all network operations)
if [ -n "$FIRST_ALLOWED" ]; then
    echo "[firewall] Verifying DNS resolution for $FIRST_ALLOWED..."
    if dig +short A "$FIRST_ALLOWED" >/dev/null 2>&1; then
        echo "[firewall] OK: DNS resolution working"
    else
        echo "[firewall] WARNING: DNS resolution failed for $FIRST_ALLOWED"
    fi
fi

echo "[firewall] Network policy applied successfully"
exit 0
