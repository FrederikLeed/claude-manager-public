---
title: What Claude Manager v2 gives the operator
markmap:
  colorFreezeLevel: 2
---

# Claude Manager v2

## Instance lifecycle
### Create · Start · Stop · Remove
- Web UI or API
- Real-time via WebSocket
- Per-instance choices: policy + backend + socket
### Adopt existing
- Discover unmanaged claude-* containers
- Register by docker_id in SQLite
### Recreate (preserve volume)
- Toggle Docker socket on/off
- Switch network policy on approval

## Web terminal
### xterm.js v6
- Full terminal in the browser
- Binary pipe (stdin/stdout)
### Shared tmux sessions
- Same session across devices
- Detach / reattach preserves scrollback
### Tabbed panel
- Windows Terminal-style tabs
- One tab per container connection

## Network policy (per container)
### Policies
- claude-only — Anthropic API only
- claude-github — + GitHub
- claude-full-dev — + npm/PyPI/Cargo/Docker Hub
- unrestricted — no filtering
### Enforcement
- squid forward proxy (cm-proxy)
- Per-container ACL files (manager-generated)
- inotify → squid -k reconfigure
- iptables lock blocks bypass attempts
### Access request flow
- cm-access CLI inside container
- Request policy upgrade or extra hosts
- Admin approves/denies in UI
- Host additions: no recreation needed

## LLM backend (per instance)
### claude-max
- Direct api.anthropic.com
- Requires `claude login` inside the container
### local-llm
- Qwen3 30B-A3B via Ollama
- Runs on RTX 3090
### foundry · foundry-latest
- Azure AI Foundry GPT-4.1-mini · GPT Latest
### Routing
- Non-claude-max → LiteLLM proxy
- ANTHROPIC_BASE_URL + per-instance virtual key
- Claude model name aliases mapped server-side

## Capability grants
### High-risk, time-bound
- docker_socket (default 24h)
- network_unrestricted (default 24h)
### Expiry handling
- Checker stops container on expiry
- Grant badge in UI shows remaining time
- Renew / revoke from instance card

## Data architecture
### Per-instance isolation
- /workspace — dedicated Docker volume
- /workspace/.claude — project memory (bind mount)
- Each instance has its own auth
### Shared across instances
- /shared — cross-instance files
- ~/.claude — global settings + memory
### Git-backed backup
- data/ is git-tracked
- git push = full settings/memory restore
- Auth stays inside each container

## Auth
### First-device admin (TOFU)
- First browser auto-approved as admin
- Prevents lockout on fresh deploy
### Device approval
- Subsequent devices need admin approval
- Tokens SHA-256 hashed in SQLite
- 10-year httpOnly cookie
### Emergency reset
- ADMIN_RESET_TOKEN env var
- ?reset_token=… on registration

## Observability
### Real-time event stream
- Docker events filtered by managed label
- Broadcast to all connected clients
- No polling
### Activity log
- Per-instance lifecycle history
- Includes grant + access-request events
### LiteLLM panel
- Per-instance token usage + budget
