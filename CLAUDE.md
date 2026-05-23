# Claude Manager — Developer Context

## What this project is
A Docker container management UI specifically for Claude Code workspace containers.
Runs as a container itself. Manages sibling containers via Docker socket mount.
Includes the workspace Docker image source in workspace/.

## Key files to understand first
- server/docker.js — all Docker Engine API interaction, instance creation with mount logic
- server/proxy.js — per-container squid ACL generation
- server/grants.js — time-bound capability grants (docker_socket, network_unrestricted)
- server/litellm.js — per-instance virtual key lifecycle
- server/routes/instances.js — REST API
- server/routes/access-requests.js — agent ↔ admin access negotiation
- src/components/Dashboard.jsx — main UI entry point
- workspace/Dockerfile — the Claude Code workspace image
- workspace/scripts/cm-access — agent-side CLI for querying/requesting network access
- workspace/scripts/entrypoint.sh — iptables lock applied when network policy is restricted
- proxy/squid.conf + proxy/watch-acls.sh — forward-proxy enforcement
- litellm/config.yaml — LiteLLM model routing (Claude name aliases, Azure)
- policies/*.yaml — network policy YAML (baked into manager image at /app/policies)

## Data architecture
- data/shared/ — files shared across all instances (/shared mount)
- data/claude-home/ — global Claude config + auth (/home/claude/.claude mount)
- data/instance-memory/<slug>/ — per-instance Claude project memory (/workspace/.claude mount)
- Each instance gets its own Docker volume for /workspace (code)
- Auth tokens in data/claude-home/ are .gitignored, everything else is git-tracked

## Environment
- Node.js 22
- Fastify backend
- React 19 + Vite frontend
- dockerode for Docker API
- SQLite (better-sqlite3) for manager metadata
- xterm.js for terminal emulation

## Development
npm run dev    # starts both Vite dev server (5173) and Fastify (3002) concurrently
npm run build  # builds frontend into dist/, then Fastify serves it

## Docker context
The manager container mounts /var/run/docker.sock from the host.
Instance containers are identified by the label: claude-manager.managed=true
Instance metadata (human name, tags, notes) stored in SQLite at /data/manager.db
The workspace image is built from workspace/Dockerfile in this repo.

## Naming conventions
- Docker container names: cm-instance-{slug}-{id}  (CONTAINER_PREFIX in shared/constants.js)
- Docker volumes:         cm-workspace-{slug}-{id} (VOLUME_PREFIX)
- Docker network:         claude-manager-net
- Instance memory dirs:   data/instance-memory/{slug}/
- Sidecars:               cm-proxy, cm-litellm, cm-ollama, cm-litellm-db

## Do not
- Do not use docker-compose CLI from within the container (no CLI in image)
- Do not store auth tokens in SQLite, use Docker secrets or env vars
- Do not hardcode image names, read from CLAUDE_IMAGE env var
- Do not put customer data in data/shared/ — that's for personal tools/templates only
