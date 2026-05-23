---
project: claude-manager
repo: https://github.com/FrederikLeed/claude-manager-public
updated: 2026-05-22
status: active
---

# Claude Manager

Self-hosted Docker container management UI for Claude Code workspaces. Runs as a Docker container, manages sibling containers via Docker socket mount. Provides a web dashboard to create, monitor, and terminal-access isolated workspace containers with per-container network policy enforcement.

## Current State

**v2 is the active version** (port 3002, `docker-compose.v2.yml`). v1 still runs on port 3000 but is legacy.

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
- Mobile-responsive layout

Recent work (May 2026):
- **Per-instance LLM backend selector** — each instance chooses its LLM: Claude Max (direct Anthropic), Local LLM (Qwen3 30B-A3B via Ollama), or Azure AI Foundry (GPT-4.1-mini, GPT Latest). LiteLLM proxies all non-Anthropic requests, with Claude model name aliases mapped to the selected backend.
- **LiteLLM + Ollama stack** — local inference on local GPU via Ollama, LiteLLM as unified API gateway. Azure AI Foundry models via OpenAI-compatible endpoint. Config baked into image, secrets via `.env`.
- **Network proxy enforcement** — squid forward proxy replaces iptables-per-container approach. Manager writes per-container ACL files, proxy auto-reconfigures. Blocked requests fail instantly (~0.02s). iptables lock in entrypoint prevents proxy bypass.
- **Access request flow** — containers request broader access via API, admin approves/denies from UI. Host additions update proxy ACL (no container recreation). Policy upgrades recreate container with new proxy env.
- **cm-access CLI** — bash tool in workspace image for AI agents. Discovers policies, checks status, requests access, polls for approval.
- **Global CLAUDE.md** — instructs all AI agents on network access workflow (attempt → request → poll → retry).

## Architecture

**Six containers in the v2 stack:**
- `claude-manager-v2` — Fastify 5 backend + React 19 frontend, manages Docker via socket
- `cm-proxy` — squid forward proxy, enforces per-container network allowlists
- `cm-litellm` — LiteLLM proxy, routes Claude Code requests to local or cloud LLMs
- `cm-ollama` — Ollama with NVIDIA GPU, serves local models (Qwen3 30B-A3B on local GPU)
- `cm-litellm-db` — PostgreSQL 16 for LiteLLM state
- Workspace containers — `claude-workspace:latest` image, managed instances

**Three Docker images built from this repo:**
- `claude-manager-v2` (v2/Dockerfile) — Node.js 22, Fastify 5, React 19, multi-stage build
- `claude-workspace` (workspace/Dockerfile) — Ubuntu 24.04, Node.js 22, Claude Code, gh CLI, Docker CLI, cm-access, https-proxy-agent
- `cm-litellm` (litellm/Dockerfile) — LiteLLM with baked-in config

**Network enforcement (proxy-based):**
- Policies: `claude-only`, `claude-github`, `claude-full-dev`, `unrestricted`
- Restricted containers get `HTTP_PROXY`/`HTTPS_PROXY` env vars → squid proxy
- Proxy uses per-container ACL files with domain allowlists (`.domain` syntax for domain + subdomains)
- iptables lock in entrypoint blocks direct internet (prevents proxy bypass by unsetting env vars)
- `NET_ADMIN` only needed for the iptables lock, not for filtering
- Unrestricted containers: no proxy, no iptables, full access

**Data directory (`data/`)** — git-tracked for backup:
- `data/shared/` → `/shared` in all instances
- `data/claude-home/` → `~/.claude` in all instances (global CLAUDE.md)
- `data/instance-memory/<slug>/` → `/workspace/.claude` per instance

**LLM backends:**
- `claude-max` — direct Anthropic API (requires `claude login` in container)
- `local-llm` — Qwen3 30B-A3B on local GPU via Ollama → LiteLLM
- `foundry` — Azure AI Foundry GPT-4.1-mini (deployment `gpt-4.1-mini-1`) via LiteLLM
- `foundry-latest` — Azure AI Foundry GPT Latest (deployment `gpt-chat-latest`) via LiteLLM
- Non-claude-max backends inject `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` pointing at LiteLLM
- LiteLLM aliases Claude model names (claude-opus-4-7, claude-sonnet-4-6, etc.) to the local Qwen3 model

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

### Prerequisites
- Docker Engine 20.10+ with Compose v2
- NVIDIA GPU + Container Toolkit (for local LLM — optional)
- Linux recommended (Windows WSL2 and macOS also work)

### Setup

```bash
git clone https://github.com/FrederikLeed/claude-manager.git
cd claude-manager

# Configure
cp .env.example .env
# Edit .env — set host paths and LITELLM_MASTER_KEY at minimum

# Build all images (manager, workspace, proxy, litellm)
docker compose -f docker-compose.v2.yml --profile build-only build

# Start the stack
docker compose -f docker-compose.v2.yml up -d

# Verify
docker compose -f docker-compose.v2.yml ps
```

Open **http://localhost:3002** — first browser is auto-approved as admin.

### Without GPU

Remove or comment out the `cm-ollama` service in `docker-compose.v2.yml`. The `local-llm` backend won't be available, but `claude-max` and `foundry*` backends work fine.

### Updating

```bash
git pull
docker compose -f docker-compose.v2.yml --profile build-only build
docker compose -f docker-compose.v2.yml up -d
```

See [docs/deployment.md](docs/deployment.md) for full deployment guide (reverse proxy, env vars, backup, troubleshooting).

## Testing

```bash
# Run v2 test suite
docker compose -f docker-compose.v2.yml --profile test run --rm test
```

10 test files, uses real Docker containers. Also: manual proxy verification with throwaway containers on `claude-manager-net`.

## Roadmap

- Publish project
