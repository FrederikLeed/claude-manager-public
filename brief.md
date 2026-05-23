---
project: claude-manager
repo: https://github.com/FrederikLeed/claude-manager-public
updated: 2026-05-23
status: active
---

# Claude Manager

Self-hosted Docker container management UI for Claude Code workspaces. Runs as a Docker container, manages sibling containers via Docker socket mount. Provides a web dashboard to create, monitor, and terminal-access isolated workspace containers with per-container network policy enforcement.

## Current State

Core functionality:
- Instance lifecycle (create, start, stop, remove) via web UI
- Container discovery and adoption of existing claude-* containers
- Web terminal (xterm.js v6 + tmux shared sessions)
- Real-time WebSocket updates from Docker event stream
- Device-based authentication (TOFU — first device auto-admin)
- Per-container network policy enforcement via squid proxy
- Access request flow — agents request access, admins approve/deny in UI
- `cm-access` CLI inside containers for agents to discover and request network access
- Capability grants (time-limited docker socket, network upgrades)
- Per-instance LLM backend selector (Claude Max, Local LLM, Azure AI Foundry)
- Mobile-responsive layout

## Architecture

**Six containers in the stack:**
- `claude-manager` — Fastify 5 backend + React 19 frontend, manages Docker via socket
- `cm-proxy` — squid forward proxy, enforces per-container network allowlists
- `cm-litellm` — LiteLLM proxy, routes Claude Code requests to local or cloud LLMs
- `cm-ollama` — Ollama with NVIDIA GPU, serves local models (Qwen3 30B-A3B)
- `cm-litellm-db` — PostgreSQL 16 for LiteLLM state
- Workspace containers — `claude-workspace:latest` image, managed instances

**Four Docker images built from this repo:**
- `claude-manager` (Dockerfile) — Node.js 22, Fastify 5, React 19, multi-stage build
- `claude-workspace` (workspace/Dockerfile) — Ubuntu 24.04, Node.js 22, Claude Code, gh CLI, Docker CLI, cm-access
- `cm-proxy` (proxy/Dockerfile) — squid + inotify ACL watcher
- `cm-litellm` (litellm/Dockerfile) — LiteLLM with baked-in config

**Network enforcement (proxy-based):**
- Policies: `claude-only`, `claude-github`, `claude-full-dev`, `unrestricted`
- Restricted containers get `HTTP_PROXY`/`HTTPS_PROXY` env vars → squid proxy
- Proxy uses per-container ACL files with domain allowlists
- iptables lock in entrypoint blocks direct internet (prevents proxy bypass)
- Unrestricted containers: no proxy, no iptables, full access

**Data directory (`data/`)** — git-tracked for backup:
- `data/shared/` → `/shared` in all instances
- `data/claude-home/` → `~/.claude` in all instances (global CLAUDE.md)
- `data/instance-memory/<slug>/` → `/workspace/.claude` per instance

**LLM backends:**
- `claude-max` — direct Anthropic API (requires `claude login` in container)
- `local-llm` — Qwen3 30B-A3B on local GPU via Ollama → LiteLLM
- `foundry` — Azure AI Foundry GPT-4.1-mini via LiteLLM
- `foundry-latest` — Azure AI Foundry GPT Latest via LiteLLM

**Stack:** Fastify 5, React 19, Vite, Tailwind CSS 3, dockerode, better-sqlite3, xterm.js v6, tmux, squid, LiteLLM, Ollama

## Key Decisions

- **Sibling containers, not DinD** — manager creates containers alongside itself via socket mount
- **Docker as source of truth** — SQLite stores only metadata, container state from Docker API
- **Proxy over iptables** — domain-level filtering, no IP resolution games, instant policy changes
- **iptables lock + proxy** — defense in depth: proxy filters by domain, iptables prevents bypass
- **Mount template learning** — new instances auto-learn bind mounts from existing containers
- **Per-instance memory** — each instance gets isolated `/workspace/.claude`
- **Global CLAUDE.md** — AI agent instructions distributed via bind mount (live updates)

## Quick Deploy

```bash
git clone https://github.com/FrederikLeed/claude-manager-public.git && cd claude-manager-public
cp .env.example .env                               # set host paths + LITELLM_MASTER_KEY
docker compose --profile build-only build           # build all images
docker compose up -d                                # start the stack
```

Open **http://localhost:3002** — first browser is auto-approved as admin.

Without GPU: comment out `cm-ollama` in `docker-compose.yml`. The `local-llm` backend won't be available, but `claude-max` and `foundry*` work fine.

See [docs/deployment.md](docs/deployment.md) for full deployment guide.

## Testing

```bash
docker compose --profile test run --rm test
```

10 test files, uses real Docker containers.

## Roadmap

See [docs/roadmap.md](docs/roadmap.md) and the [GitHub issues](https://github.com/FrederikLeed/claude-manager-public/issues) for what's planned next.
