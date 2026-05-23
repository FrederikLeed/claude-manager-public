# Claude Manager — Deployment Guide

This guide covers deploying **Claude Manager** — a six-container
stack consisting of the manager UI, a squid forward proxy, a LiteLLM
router, an Ollama runtime, a Postgres state DB for LiteLLM, and any
number of managed workspace instances. The manager runs as a container
and manages sibling workspace containers on the same host via the
Docker socket.

---

## 1. Prerequisites

### Docker Engine 20.10+

Required Docker Engine API features (API version ≥ 1.41):

- Container label filtering on `listContainers`
- Named volume creation and management
- Bridge network creation
- Exec API with TTY and resize support (in-browser terminal sessions)
- Event streaming with label filters
- `NET_ADMIN` capability for instance containers (iptables lock)

```bash
docker version
```

The `API version` line must be `1.41` or higher.

### Docker Compose

Use the `docker compose` plugin, not the legacy `docker-compose` binary.

```bash
docker compose version
```

### NVIDIA GPU + Container Toolkit (for `cm-ollama`)

`cm-ollama` runs Qwen3 30B-A3B locally. The `docker-compose.yml`
declares an NVIDIA GPU reservation for the `cm-ollama` service:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: 1
          capabilities: [gpu]
```

Install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/)
on the host:

```bash
nvidia-smi                  # GPU visible on the host?
docker info | grep -i nvidia   # nvidia runtime registered?
```

Without a GPU you have three options:
1. Drop the `cm-ollama` service from `docker-compose.yml` and skip
   the `local-llm` backend — instances default to `claude-max`.
2. Run Ollama externally and point LiteLLM at it
   (`litellm/config.yaml`).
3. Stick with `claude-max` and `foundry*` (Azure) backends only.

### Host operating system

**Linux is recommended.** Docker socket at `/var/run/docker.sock`.

- **macOS** (Docker Desktop): socket symlinked at `/var/run/docker.sock`,
  may need adjustment depending on Docker Desktop version. No GPU
  passthrough — `cm-ollama` will not work.
- **Windows (WSL2)**: works with Docker Desktop's WSL integration.
  GPU passthrough requires Windows 11 + recent NVIDIA drivers.

### Minimum resources

| Component                      | RAM    | Notes                                       |
|--------------------------------|--------|---------------------------------------------|
| `claude-manager`            | ~1 GB  | Node.js + SQLite + frontend assets          |
| `cm-proxy`                     | ~50 MB | squid is tiny                               |
| `cm-litellm`                   | ~512 MB| Python proxy                                |
| `cm-litellm-db`                | ~256 MB| Idle PostgreSQL                             |
| `cm-ollama` (Qwen3 30B-A3B)    | 24 GB VRAM + 4 GB RAM | RTX 3090+ class GPU (≥24 GB VRAM) |
| Each workspace instance        | ~2 GB  | Depends on workload                         |

A host with 32 GB RAM + an NVIDIA GPU (≥24 GB VRAM) comfortably runs the full stack
plus 5-7 concurrent workspace instances.

### Network

- Manager: **3002** (mapped 3002 → 3002 inside the container)
- LiteLLM: 4000 (only needed if you talk to it from outside Docker)
- Ollama: 11434 (only needed for direct access)

All other inter-container traffic goes over the `claude-manager-net`
bridge.

### Claude Workspace image

The image is built from this repo's `workspace/Dockerfile`. There's no
separate repo to clone — see step 2 below.

---

## 2. Quick deploy

```bash
git clone https://github.com/FrederikLeed/claude-manager-public.git
cd claude-manager

# 1. Configure host paths and secrets
cp .env.example .env
# edit .env — at minimum set INSTANCE_SHARED_DIR, INSTANCE_CLAUDE_DIR,
# INSTANCE_MEMORY_BASE_DIR to ABSOLUTE host paths

# 2. Build all images (manager, workspace, proxy, litellm)
docker compose -f docker-compose.yml --profile build-only build

# 3. Start the stack
docker compose -f docker-compose.yml up -d

# 4. Verify
docker compose -f docker-compose.yml ps
```

Open **http://localhost:3002**. The first browser to load it is
auto-approved as the admin device (see
[operations.md → Device Authentication](operations.md#9-multi-device-access-and-device-authentication)).

On first start the manager:

1. Builds the multi-stage image (Vite build + Fastify production stage).
2. Initialises the SQLite database at `/data/manager.db`,
   snapshotting any existing DB to `/data/backups/` (last 3 kept).
3. Creates the `claude-manager-net` bridge network if missing.
4. Syncs SQLite with Docker (adopts managed-label containers it finds).
5. Calls `syncAllACLs()` — writes a `.acl` file under `/proxy-acl/`
   for every running managed container; squid picks them up via
   inotify.

---

## 3. Production deployment

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3002` | Manager port inside the container |
| `CLAUDE_IMAGE` | `claude-workspace:latest` | Workspace image for new instances |
| `CLAUDE_NETWORK` | `claude-manager-net` | Bridge network for manager + instances |
| `MAX_INSTANCES` | `20` | Hard cap on managed instances. Create returns HTTP 409 when reached. |
| `SHARED_DIR` | `./data/shared` | Manager's own `/shared` mount source |
| `INSTANCE_SHARED_DIR` | *(unset)* | **Host** path bind-mounted as `/shared` in every new instance |
| `INSTANCE_CLAUDE_DIR` | *(unset)* | **Host** path bind-mounted as `/home/claude/.claude` |
| `INSTANCE_MEMORY_BASE_DIR` | *(unset)* | **Host** base dir for per-instance `/workspace/.claude` (per slug) |
| `INSTANCE_MEMORY_DIR` | *(unset)* | Legacy single-shared project memory; leave empty when using the base dir |
| `ADMIN_RESET_TOKEN` | *(unset)* | Emergency admin promotion via `?reset_token=…` |
| `DEFAULT_NETWORK_POLICY` | `unrestricted` | Pre-selected policy in the create modal |
| `POLICIES_HOST_DIR` | *(unset)* | Host path of `workspace/policies/` (overrides volume) |
| `POLICIES_VOLUME` | `cm-policies` | Alternative for DinD setups |
| `POLICIES_DIR` | `/app/policies` | Where the manager reads policy YAML inside its own container |
| `PROXY_URL` | `http://cm-proxy:3128` | Proxy URL injected into restricted instances |
| `PROXY_ACL_DIR` | `/proxy-acl` | Where the manager writes per-container ACL files |
| `LITELLM_API_BASE` | `http://cm-litellm:4000` | LiteLLM admin + completion endpoint |
| `LITELLM_MASTER_KEY` | *(unset)* | LiteLLM admin key — **required** for `local-llm` / `foundry*` |
| `LITELLM_DEFAULT_BUDGET` | `20` | Per-instance USD budget on virtual keys |
| `AZURE_AI_API_KEY` | *(unset)* | LiteLLM-side: Azure key for `foundry` (`gpt-4.1-mini-1`) |
| `GPTLATEST_AZURE_AI_API_KEY` | *(unset)* | LiteLLM-side: Azure key for `foundry-latest` |
| `DATA_DIR` | `/data` | SQLite DB path inside the manager container |
| `LOG_LEVEL` | `info` | Fastify log level |

The `INSTANCE_*_DIR` variables must be **host** paths, because the
manager passes them as bind sources to `dockerode`. On Windows that's
a path like `/srv/claude-manager/data/shared` — keep these in
`.env` (not in JSON, which would mangle backslashes).

#### Sample `.env`

```bash
# Host paths — every instance bind-mounts from these
INSTANCE_SHARED_DIR=/srv/claude-manager/data/shared
INSTANCE_CLAUDE_DIR=/srv/claude-manager/data/claude-home
INSTANCE_MEMORY_BASE_DIR=/srv/claude-manager/data/instance-memory

# Manager's own /shared mount
SHARED_DIR=/srv/claude-manager/data/shared

# LLM stack
LITELLM_MASTER_KEY=sk-litellm-replace-me
LITELLM_DEFAULT_BUDGET=20
AZURE_AI_API_KEY=...          # for backend=foundry
GPTLATEST_AZURE_AI_API_KEY=...  # for backend=foundry-latest

# Defaults
MAX_INSTANCES=20
DEFAULT_NETWORK_POLICY=claude-github

# Emergency recovery — set during initial setup, clear afterwards
ADMIN_RESET_TOKEN=
```

Docker Compose auto-loads `.env`.

### Volume mounts

The manager (`claude-manager`) requires:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock     # required — Docker API
  - claude-manager-data:/data                  # SQLite + backups
  - ${SHARED_DIR:-./data/shared}:/shared          # manager's /shared view
  - ${INSTANCE_MEMORY_BASE_DIR:-./data/instance-memory}:/instance-memory
  - ${CLAUDE_HOME_DIR:-./data/claude-home}:/claude-home
  - ./workspace/policies:/policies:ro             # policy YAML
  - proxy-acl:/proxy-acl                          # shared with cm-proxy
```

`cm-proxy` mounts the same `proxy-acl` volume read-only at
`/etc/squid/acl` and watches it with inotify.

### Network policy + LLM defaults

Two knobs control the out-of-the-box defaults:

- `DEFAULT_NETWORK_POLICY=claude-github` — every new instance starts
  with this policy unless the operator picks otherwise in the modal.
- `LITELLM_DEFAULT_BUDGET=20` — each `local-llm` / `foundry*` instance
  gets a $20 LiteLLM budget.

The four policy YAMLs live in `workspace/policies/`. To add a custom
policy, drop a YAML file there (same schema as the existing ones) and
restart the manager — `listPolicies()` reads the directory on each
call.

### Restart policy

All services use `restart: unless-stopped`. After host reboots the
stack comes back automatically. To stop the whole stack:

```bash
docker compose -f docker-compose.yml stop
```

---

## 4. Reverse proxy

The manager uses WebSockets for real-time events and in-browser
terminals. Any reverse proxy must pass WebSocket upgrade headers.

### nginx

```nginx
upstream claude-manager {
    server 127.0.0.1:3002;
}

server {
    listen 443 ssl http2;
    server_name claude.example.com;

    ssl_certificate     /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;

    location / {
        proxy_pass http://claude-manager;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support — required for terminals and event stream
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Long-running terminal sessions
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

### Traefik

```yaml
services:
  claude-manager:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.claude-manager.rule=Host(`claude.example.com`)"
      - "traefik.http.routers.claude-manager.entrypoints=websecure"
      - "traefik.http.routers.claude-manager.tls.certresolver=letsencrypt"
      - "traefik.http.services.claude-manager.loadbalancer.server.port=3002"
    networks:
      - claude-manager-net
      - traefik
```

Traefik passes WebSocket upgrades automatically.

### Key WebSocket paths

| Path                              | Purpose                                  |
|-----------------------------------|------------------------------------------|
| `/api/instances/events`           | Real-time instance + grant + access events |
| `/api/instances/:id/terminal`     | In-browser terminal (xterm.js)           |

---

## 5. Updating

```bash
cd claude-manager
git pull
docker compose -f docker-compose.yml --profile build-only build
docker compose -f docker-compose.yml up -d
```

Database migrations run automatically — `CREATE TABLE IF NOT EXISTS` +
`PRAGMA table_info` adds any missing columns (`docker_id`, `litellm_key`,
etc.) on startup.

---

## 6. Backup

### What lives where

| Class                          | Where                                                | Backup story                          |
|--------------------------------|------------------------------------------------------|---------------------------------------|
| Manager DB                     | Docker volume `claude-manager-data` → `/data/manager.db` | Auto-snapshot to `/data/backups/` on every startup (last 3 kept) |
| Per-instance code & files       | Docker volume `cm-workspace-{slug}-{id}` (`/workspace`) | `docker volume` — not auto-backed-up |
| Per-instance project memory    | `data/instance-memory/<slug>/` on host               | **`git push`**                        |
| Global Claude config + memory   | `data/claude-home/` on host (auth files gitignored)  | **`git push`**                        |
| Shared files                   | `data/shared/` on host                               | **`git push`** (unless ignored)       |
| Squid ACLs                     | Docker volume `proxy-acl`                            | Regenerated by `syncAllACLs()` on startup |
| LiteLLM virtual keys           | Docker volume `litellm-db`                           | `pg_dump` if needed (also stored in `instances.litellm_key`) |
| Ollama model weights           | Docker volume `ollama-data`                          | Re-downloadable; back up if bandwidth is precious |

### SQLite backup commands

The startup snapshot is the easy story. For an on-demand backup:

```bash
# Option A — stop and copy (safest)
docker compose -f docker-compose.yml stop claude-manager
cp "$(docker volume inspect claude-manager-data --format '{{.Mountpoint}}')/manager.db" \
   ~/backups/claude-manager-$(date +%Y%m%d).db
docker compose -f docker-compose.yml start claude-manager

# Option B — online (.backup, WAL-safe)
docker exec claude-manager sh -c \
  "sqlite3 /data/manager.db '.backup /data/manager-backup.db'"
docker cp claude-manager:/data/manager-backup.db \
  ~/backups/claude-manager-$(date +%Y%m%d).db
docker exec claude-manager rm /data/manager-backup.db
```

### Disaster recovery

To restore on a new host:

1. Clone the repo (this brings back `data/`, `workspace/policies/`,
   compose files, etc).
2. `cp .env.example .env` and set `INSTANCE_*_DIR` to the new absolute
   host paths.
3. `docker compose -f docker-compose.yml --profile build-only build`
4. `docker compose -f docker-compose.yml up -d`
5. From the new admin device, set `ADMIN_RESET_TOKEN` in `.env`,
   restart, register with `?reset_token=…`, then clear the env var.
6. Each instance re-authenticates (`claude login`, `gh auth login`) on
   first use.

---

## 7. Troubleshooting

### "Cannot connect to Docker"

```
Error: connect ENOENT /var/run/docker.sock
```

The manager cannot reach the Docker daemon. Verify the socket mount in
`docker-compose.yml`:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

Check the host:

```bash
sudo systemctl status docker
ls -la /var/run/docker.sock
```

### "Image not found"

```
Failed to pull image "claude-workspace:latest": ...
```

```bash
docker images | grep claude-workspace
# If missing:
docker compose -f docker-compose.yml --profile build-only build claude-workspace
```

### `cm-ollama` exits / no GPU

```bash
docker compose -f docker-compose.yml logs cm-ollama
```

Likely causes:
- NVIDIA Container Toolkit not installed.
- Docker not configured with the `nvidia` runtime.
- VRAM exhausted by another process — `nvidia-smi`.

### LiteLLM "Authentication Error"

LiteLLM needs `LITELLM_MASTER_KEY` set on both `cm-litellm` (so it
accepts admin calls from the manager) and `claude-manager` (so it
can mint virtual keys). Both pick up the same `.env` value via
`docker-compose.yml`.

### Restricted instance can't reach an allowed host

1. `cm-access --status` inside the container to see effective access.
2. Verify the host is in the policy YAML (`workspace/policies/<policy>.yaml`).
3. Inspect the ACL file: `docker exec cm-proxy cat /etc/squid/acl/<id>.acl`.
4. Check the proxy log: `docker logs cm-proxy --tail 50`.
5. Make sure the agent isn't bypassing `HTTPS_PROXY` — the iptables
   lock should turn that into an instant TCP-reset; if not, check
   `docker inspect` for `NET_ADMIN`.

### Terminal not connecting through reverse proxy

The most common issue is missing WebSocket upgrade headers. See
§4 above. Also bump `proxy_read_timeout` for long sessions.

### File upload fails

```bash
docker inspect claude-manager --format '{{ json .Mounts }}' | python3 -m json.tool
ls -la "${SHARED_DIR:-./data/shared}"
```

If `SHARED_DIR` wasn't set, Docker may have created `/shared` as a
root-owned host directory. Set it in `.env`, recreate the manager:

```bash
docker compose -f docker-compose.yml up -d --force-recreate claude-manager
```

---

## 8. Security considerations

### Docker socket access

`/var/run/docker.sock` grants root-equivalent access to the host.
The manager can create / start / stop / remove any container, mount
any host directory, pull any image. This is intrinsic to the
sibling-container pattern (same trust model as Portainer).

### Device authentication (TOFU)

TOFU device auth is **on by default**. The first browser becomes
admin; subsequent devices wait for approval. Tokens are stored only as
SHA-256 hashes. The cookie is `HttpOnly`, `sameSite: lax`, 10-year TTL.

Losing the admin device → set `ADMIN_RESET_TOKEN` (a long random
string), restart, register with `?reset_token=…` from a new browser.
Clear `ADMIN_RESET_TOKEN` afterwards.

### Per-instance network policy

Workspace instances default to (or can opt into) per-container network
filtering by the squid forward proxy, with an iptables lock preventing
bypass. The four shipped policies (`claude-only`, `claude-github`,
`claude-full-dev`, `unrestricted`) live as YAML in
`workspace/policies/`. Custom policies are a drop-in YAML file.

Restricted containers do **not** get `unrestricted` for free — that
requires a `network_unrestricted` capability grant (default 24 h), and
the container is stopped on expiry.

### Network exposure

Device auth prevents drive-by access, but the manager still has root-
equivalent Docker access. Defence in depth:

- Run on a trusted network only (home lab / VLAN).
- Front with a VPN (WireGuard, Tailscale, etc.).
- Add an authenticating reverse proxy (Authelia, Authentik,
  oauth2-proxy) as a second factor.
- Bind to localhost only if access is local:
  ```yaml
  ports:
    - "127.0.0.1:3002:3002"
  ```

### Container isolation

- Each instance gets its own `/workspace` volume and
  `/workspace/.claude` bind — no cross-contamination of code or
  project memory.
- Auth is per-instance: each container runs its own `claude login`
  (Max) and `gh auth login`.
- Instances share the `claude-manager-net` bridge and can reach each
  other by name *unless* their network policy blocks it (squid only
  filters external traffic — internal RFC1918 ranges are always
  allowed so the instance can reach the manager and LiteLLM).
- Instances do **not** receive the Docker socket by default. The
  "Allow Docker socket" toggle adds it and registers a 24 h
  `docker_socket` capability grant. Toggling the setting recreates the
  container with its volumes preserved.
- `/shared` and `/home/claude/.claude` are explicitly shared — do not
  put customer-specific data there.
