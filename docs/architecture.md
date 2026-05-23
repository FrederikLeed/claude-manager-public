# Claude Manager v2 — Architecture

A self-hosted web UI that runs as a Docker container and manages sibling
Claude Code workspace containers on the same host, with per-container
**network policy enforcement** and a **pluggable LLM backend** per
instance. For the design intent and current status, see
[brief.md](../brief.md); for day-to-day usage, see
[operations.md](operations.md).

> **v2 is the active version** (port 3002, `docker-compose.v2.yml`). v1
> still ships in the repo on port 3000 as legacy and is not covered here.

All diagrams below are generated from text sources in `docs/diagrams/`.
Edit the source, re-render, commit both. The render commands live in
the README under "Diagram tooling".

---

## 1. The stack

![Architecture](diagrams/architecture.png)

Six containers, one bridge network (`claude-manager-net`):

| Container             | Image source           | Purpose                                                       |
|-----------------------|------------------------|---------------------------------------------------------------|
| `claude-manager-v2`   | `v2/Dockerfile`        | Fastify 5 backend + React 19 frontend, manages Docker via socket |
| `cm-proxy`            | `proxy/Dockerfile`     | squid forward proxy — enforces per-container network ACLs     |
| `cm-litellm`          | `litellm/Dockerfile`   | LiteLLM proxy — routes Claude Code requests to Ollama / Azure |
| `cm-ollama`           | `ollama/ollama` (NVIDIA) | Local inference — Qwen3 30B-A3B on the host GPU             |
| `cm-litellm-db`       | `postgres:16-alpine`   | PostgreSQL for LiteLLM virtual-key state                      |
| `cm-instance-*`       | `claude-workspace:latest` (`workspace/Dockerfile`) | Per-project Claude Code workspace containers |

The manager creates and tears down instance containers via
`/var/run/docker.sock` (mounted) using the `dockerode` library. It does
not run a Docker daemon — this is the standard Docker-out-of-Docker
sibling-container pattern.

---

## 2. Data architecture

![Data architecture](diagrams/data-architecture.png)

```
claude-manager/
├── data/                       git-tracked — your backup
│   ├── shared/                 → /shared in every instance
│   ├── claude-home/            → /home/claude/.claude in every instance
│   │   ├── CLAUDE.md           global agent instructions (incl. cm-access workflow)
│   │   ├── settings.json       global Claude preferences
│   │   └── memory/             global memories
│   └── instance-memory/        per-instance project memory
│       └── <slug>/             → /workspace/.claude in that instance
├── workspace/
│   └── policies/               network policies — bind-mounted into manager as /policies (RO)
├── proxy-acl (Docker volume)   manager writes, cm-proxy reads (inotify reload)
└── claude-manager-v2-data (Docker volume)   /data/manager.db (+ /data/backups/)
```

**Isolation model:**

- Per-instance: `/workspace` (Docker volume `cm-workspace-{slug}-{id}`),
  `/workspace/.claude` (per-slug bind), and **all auth state inside the
  container**.
- Shared: `/home/claude/.claude` (global config + memory + agent
  instructions) and `/shared` (utility files).

Push `data/` to GitHub, clone on a new host, `docker compose -f
docker-compose.v2.yml up` — settings and memory are restored. Each
instance re-authenticates (`claude login` for `claude-max`, `gh auth
login`) on first use.

---

## 3. Network policy enforcement

Each workspace container runs under one of four policies:

| Policy             | Hosts allowed (see `workspace/policies/*.yaml`)                 |
|--------------------|-----------------------------------------------------------------|
| `claude-only`      | `api.anthropic.com`, `statsig.anthropic.com`, `sentry.io`       |
| `claude-github`    | + GitHub (api / web / objects / raw / gist / ssh)               |
| `claude-full-dev`  | + npm, yarn, PyPI, Cargo, Docker Hub                            |
| `unrestricted`     | No filtering (covered by a 24 h capability grant)               |

### Defence in depth

For any policy other than `unrestricted`, the manager wires up two
independent layers:

1. **`HTTPS_PROXY` / `HTTP_PROXY` env** pointing the container at
   `http://cm-proxy:3128`. Manager writes
   `/proxy-acl/<id>.acl` with a `dstdomain .host` line per allowed
   domain (using the `.host` form so subdomains are covered). The proxy
   container watches the directory with `inotifywait` and runs
   `squid -k reconfigure` on every change. squid handles HTTPS by
   CONNECT/SNI — no MITM, no TLS termination.
2. **iptables lock** inside the container (entrypoint, requires
   `NET_ADMIN`): all OUTPUT is blocked except (a) the proxy IP, (b)
   `127.0.0.11/Docker DNS`, and (c) Docker-internal RFC1918 ranges
   (manager API, LiteLLM, proxy). An agent that *unsets* `HTTPS_PROXY`
   gets an instant TCP-reset on every outbound packet.

`unrestricted` containers skip both — no proxy env, no iptables lock,
direct egress.

### Access request flow

![Network policy & access requests](diagrams/network-policy.png)

Inside any restricted container, the `cm-access` CLI (installed in the
workspace image) lets an agent ask for more access:

```
cm-access --list                              # show available policies
cm-access --status                            # show this instance's effective access
cm-access --request --policy claude-github --reason "Need to clone repo X"
cm-access --request --hosts "api.example.com,cdn.example.com" --reason "Fetch data"
cm-access --poll                              # wait until admin resolves
```

Server-side (`v2/server/routes/access-requests.js`):

- The request goes into the `access_requests` SQLite table, status
  `pending`, and is broadcast over WebSocket to connected admin
  browsers (the new `AccessRequests` panel).
- Admin approves with optional `expiryHours`. If a policy upgrade was
  requested, the container is **recreated** with the new proxy env
  (volumes preserved) and a `network_unrestricted` grant is created
  when appropriate. If only extra hosts were requested, the proxy ACL
  is updated in place — no recreation, the new hosts are reachable
  within a second.
- Denials are also logged. The container keeps polling
  `/api/instances/:id/request-access` until the request is resolved.

Approved extra hosts are persisted in `access_requests` (status
`approved`) and re-applied to the ACL on manager startup
(`syncAllACLs`), so they survive restarts.

---

## 4. LLM backend selector

![LLM routing](diagrams/llm-routing.png)

Each instance picks one of:

| Backend          | Routing                                                       |
|------------------|---------------------------------------------------------------|
| `claude-max`     | Direct `api.anthropic.com` (subject to the network policy).   |
| `local-llm`      | Qwen3 30B-A3B on Ollama, fronted by LiteLLM.                  |
| `foundry`        | Azure AI Foundry — deployment `gpt-4.1-mini-1`.               |
| `foundry-latest` | Azure AI Foundry — deployment `gpt-chat-latest`.              |

For any non-`claude-max` backend, the manager:

1. Calls LiteLLM to mint a **per-instance virtual key**, stored in
   `instances.litellm_key`.
2. Injects `ANTHROPIC_BASE_URL=http://cm-litellm:4000` and
   `ANTHROPIC_API_KEY=<virtual-key>` into the container, so Claude Code
   speaks its native protocol to LiteLLM.
3. LiteLLM (`litellm/config.yaml`) maps Claude model names
   (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`,
   etc.) to `ollama_chat/qwen3:30b-a3b`. For `foundry`/`foundry-latest`,
   the relevant `gpt-…` models are routed to Azure via the
   OpenAI-compatible endpoint.
4. `drop_params: true` is set so non-matching parameters from the
   Anthropic SDK don't break Azure / Ollama.

When an instance is removed, its LiteLLM key is deleted via the LiteLLM
admin API.

---

## 5. Capability grants

High-risk capabilities are **time-bound** (`v2/server/grants.js`,
table `capability_grants`):

| Capability             | Default TTL | What it covers                                        |
|------------------------|-------------|-------------------------------------------------------|
| `docker_socket`        | 24 h        | `/var/run/docker.sock` mounted into the instance      |
| `network_unrestricted` | 24 h        | `unrestricted` network policy (no filtering at all)   |

Lifecycle:

1. Created at instance creation if either capability is requested
   (`source: 'instance-creation'`). Also created on approved access
   requests (`source: 'access-request'`).
2. A 60-second timer (`checkExpiredGrants`) **stops** any container
   whose grant has expired. The UI's `GrantBadge` shows the remaining
   time and offers renew / recreate-without-it.
3. On manual remove, all grants for the instance are deleted.

Note: the grant *expires* the container but doesn't remove the
capability from the underlying Docker config. To permanently drop the
capability, recreate the instance via the `recreateWithoutCapability`
helper (also exposed in the UI).

---

## 6. Request flows

### 6.1 Instance creation

![Request flow](diagrams/request-flow.png)

In code (`v2/server/routes/instances.js` → `createInstance` →
`v2/server/docker.js`):

1. Validate body against the schema (`networkPolicy` ∈ `NETWORK_POLICIES`,
   `llmBackend` ∈ `LLM_BACKENDS`).
2. Check `MAX_INSTANCES`.
3. Ensure image and Docker network exist.
4. Create the workspace volume `cm-workspace-{slug}-{id}`.
5. Learn bind-mounts from any existing managed / adopted / unmanaged
   claude-workspace container (mount template), skipping
   `/workspace`, `/data`, and the docker socket.
6. Pre-create the per-instance memory directory under
   `INSTANCE_MEMORY_BASE_DIR`.
7. If `networkPolicy !== 'unrestricted'`, add
   `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` env and `NET_ADMIN` capability.
8. If `llmBackend !== 'claude-max'`, create a LiteLLM virtual key and
   inject `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`.
9. If `dockerSocket: true`, mount the host socket.
10. Create + (optionally) start the container, label it
    `claude-manager.managed=true` + `id=…` + `network-policy=…` +
    `llm-backend=…`.
11. `writeContainerACL(id, { networkPolicy })` — squid picks up the new
    file via inotify.
12. Create capability grants for any high-risk choices.
13. Upsert into SQLite, log `created` activity, broadcast
    `INSTANCE_CREATED` over WebSocket. Clients re-fetch.

### 6.2 Recreate (preserve volume)

`POST /api/instances/:id/recreate` with `{ dockerSocket?, networkPolicy?
}` stops + removes the container, creates a fresh one with the same
volumes and image, then re-writes the ACL. Used by:

- The "Allow Docker socket" toggle in the UI.
- Approved access requests that ask for a policy change.
- The `recreateWithoutCapability` helper after a grant expires.

### 6.3 Adoption

Containers without `claude-manager.managed=true` show up in
`GET /api/instances/discover` if they:

- Use the configured `CLAUDE_IMAGE`, or any image name ending in
  `/claude-workspace`, **or**
- Have a container name starting with `claude-` (except
  `claude-manager`).

`POST /api/instances/adopt` records them in SQLite by `docker_id`
(labels cannot be retroactively added to running containers). Adopted
containers persist across `syncWithDocker()` restarts.

### 6.4 Real-time updates

The server subscribes once to
`docker.getEvents({ filters: { label: ['claude-manager.managed=true'] } })`.
Each event becomes a `WS_EVENTS` message
(`instance_created` / `instance_updated` / `instance_removed`) and is
broadcast to all connected `/api/instances/events` WebSocket clients.
Clients re-fetch the full list — no partial-state patching.

Additional broadcast event types:

- `grant_expired` — emitted by the grant checker.
- `access_requested` — emitted on `POST /api/instances/:id/request-access`.
- `access_resolved` — emitted on approve/deny.

### 6.5 Device authentication (TOFU)

![Auth flow](diagrams/auth-flow.png)

Trust-on-first-use: the browser generates a random token, posts it to
`/api/auth/register`, and receives an `HttpOnly` cookie
(`sameSite: lax`). The first device to register is auto-approved as
admin; subsequent devices land in `pending`. Tokens are stored as
SHA-256 hashes (`devices.token_hash`). An optional `ADMIN_RESET_TOKEN`
env var enables emergency admin promotion via `?reset_token=…`.

Device auth gates `/api/*` only — static frontend assets, the
`/api/auth/*` routes, and the in-container `/api/instances/:id/request-access` +
`/api/policies` endpoints are reachable without it.

### 6.6 Terminal sessions

![Terminal protocol](diagrams/terminal-protocol.png)

`GET /api/instances/:id/terminal` is a WebSocket. The server:

1. Verifies the container is running.
2. Opens a PTY via `docker exec` with
   `tmux -L cm -f /dev/null new-session -A -s main`. `-A` attaches to
   an existing `main` session if one exists, so a second browser/device
   sees the same shell.
3. Pipes binary frames bidirectionally between the WebSocket and the PTY.
4. Forwards `{"type":"resize","cols":N,"rows":N}` control messages to
   `exec.resize`.
5. On socket close, sends `Ctrl-a d` (the workspace `tmux.conf`
   remaps the prefix; v1 used `Ctrl-b`) so the session lives on.

State machine:

![Terminal state](diagrams/terminal-state.png)

---

## 7. Backend layout

```
v2/server/
├── index.js                 Fastify bootstrap, plugin & route registration, grant timer, ACL sync
├── config.js                Env-var loading
├── auth.js                  hashToken(), registerAuthHooks() (gate /api except /api/auth + a few in-container)
├── db.js                    SQLite schema, queries, sync, auto-backup, grants, access requests, LiteLLM keys
├── docker.js                dockerode wrapper, mount template learning, createInstance, recreateInstance, PTY, event stream
├── proxy.js                 writeContainerACL, addHostsToACL, removeContainerACL, syncAllACLs
├── grants.js                createGrantsForInstance, checkExpiredGrants, recreateWithoutCapability
├── litellm.js               isAvailable, createVirtualKey, deleteVirtualKey
└── routes/
    ├── instances.js         REST + WS for /api/instances/*
    ├── terminal.js          WS for /api/instances/:id/terminal
    ├── auth.js              /api/auth/* — device registration & approval
    ├── grants.js            /api/instances/:id/grants, /api/grants/:id/{renew,recreate}, DELETE
    ├── access-requests.js   /api/instances/:id/request-access, /api/access-requests/:id/{approve,deny}
    ├── policies.js          /api/policies — lists workspace/policies/*.yaml
    ├── litellm.js           /api/litellm/status, /api/litellm/models, per-instance key endpoints
    ├── shared.js            /api/shared/upload (multipart, 50 MB)
    └── system.js            /api/system, /api/system/activity
```

`registerAuthHooks` is a Fastify `onRequest` hook that gates everything
under `/api/*` except `/api/auth/*` and a small set of in-container
endpoints (`request-access`, `access`, `policies`). The hook also
decorates `request.device` so admin endpoints can check
`request.device.is_admin`.

---

## 8. Frontend layout

```
v2/src/
├── main.jsx                  React entry
├── App.jsx                   Auth gate → Dashboard / WaitingApproval
├── api.js                    fetch wrapper (credentials: 'include')
├── hooks/
│   ├── useAuth.js            /api/auth/status polling
│   ├── useInstances.js       REST + WebSocket state (re-fetch on event)
│   ├── useTerminal.js        xterm.js wiring + reconnect/backoff
│   └── useGrants.js          per-instance grant polling
└── components/
    ├── Dashboard.jsx         header, grid/list toggle, modals, activity log, AccessRequests
    ├── NewInstanceModal.jsx  create form with policy + backend + socket toggle + expiry
    ├── InstanceCard.jsx      grid card; grant + access badges; start/stop/recreate/remove
    ├── InstanceRow.jsx       compact list-view row (mobile-first)
    ├── Terminal.jsx          xterm.js + addons + WebSocket plumbing
    ├── TerminalTab.jsx       Windows-Terminal-style tab strip
    ├── PolicyPreview.jsx     shows the YAML of the selected policy in the modal
    ├── GrantBadge.jsx        time-remaining badge per capability
    ├── GrantActions.jsx      renew, recreate-without
    ├── AccessRequests.jsx    admin panel — approve/deny pending requests
    ├── DeviceManager.jsx     admin — approve / rename / revoke devices
    ├── LiteLLMPanel.jsx      per-instance LiteLLM usage + budget
    ├── ActivityLog.jsx       recent actions
    ├── StatusBadge.jsx       running / exited / created / paused / …
    ├── WaitingApproval.jsx   pending-device landing page
    └── Toast.jsx             lightweight notifications
```

The `useInstances` hook is the central state manager: REST for the
authoritative list, WebSocket only as a trigger to re-fetch.
Exponential backoff (1 s → 30 s) on disconnect.

---

## 9. Data model

### 9.1 SQLite schema

`${DATA_DIR}/manager.db` — WAL mode, foreign keys on. On startup the
previous DB is copied to `${DATA_DIR}/backups/manager-{timestamp}.db`
(last 3 kept).

![Schema](diagrams/schema.png)

Migrations are handled by `CREATE TABLE IF NOT EXISTS` + a
`PRAGMA table_info` check that `ALTER TABLE`s in any missing columns
(currently `instances.docker_id` and `instances.litellm_key`).

### 9.2 Docker labels

Applied to every container the manager creates:

| Label                              | Value                                                  | Purpose                                    |
|------------------------------------|--------------------------------------------------------|--------------------------------------------|
| `claude-manager.managed`           | `true`                                                 | Identifies managed containers              |
| `claude-manager.id`                | `{8-char-uuid}`                                        | Links container to `instances.id`          |
| `claude-manager.name`              | `{project-name}`                                       | Human-readable name on the container       |
| `claude-manager.network-policy`    | `claude-only` / `claude-github` / `claude-full-dev` / `unrestricted` | Read by `syncAllACLs` on restart |
| `claude-manager.llm-backend`       | `claude-max` / `local-llm` / `foundry` / `foundry-latest` | Read by the UI for the badge            |

### 9.3 Docker ↔ SQLite

- **Labeled containers** (created here): resolved by `claude-manager.id`.
- **Adopted containers** (pre-existing, can't relabel): resolved by
  `instances.docker_id` (full container ID).

On startup, `syncWithDocker()` inserts unknown Docker containers into
SQLite and deletes orphaned SQLite rows — except adopted ones with a
`docker_id`. `syncAllACLs()` then re-writes the proxy ACLs for every
running container and replays any approved access-request hosts.

### 9.4 Naming

| Resource          | Pattern                              | Example                              |
|-------------------|--------------------------------------|--------------------------------------|
| Container name    | `cm-instance-{slug}-{id}`            | `cm-instance-customer-a-a1b2c3d4`    |
| Volume name       | `cm-workspace-{slug}-{id}`           | `cm-workspace-customer-a-a1b2c3d4`   |
| Network           | `claude-manager-net`                 | `claude-manager-net`                 |
| Manager container | `claude-manager-v2`                  | `claude-manager-v2`                  |
| Memory dir        | `data/instance-memory/{slug}/`       | `data/instance-memory/customer-a/`   |
| ACL file          | `/proxy-acl/{safe-id}.acl`           | `/proxy-acl/a1b2c3d4.acl`            |

Slug = name lowercased, non-alphanumeric → hyphens, trimmed, max
40 chars.

---

## 10. API reference

All endpoints are prefixed with `/api`. Device cookie is required
unless explicitly noted otherwise.

### 10.1 Auth (public)

| Method   | Path                              | Description                                     |
|----------|-----------------------------------|-------------------------------------------------|
| `GET`    | `/api/auth/status`                | Current device status (unknown / pending / approved) |
| `POST`   | `/api/auth/register`              | Register device by token (auto-admin if first)  |
| `GET`    | `/api/auth/devices`               | Admin: list all devices                         |
| `POST`   | `/api/auth/devices/:id/approve`   | Admin: approve a pending device                 |
| `PATCH`  | `/api/auth/devices/:id`           | Admin: rename a device                          |
| `DELETE` | `/api/auth/devices/:id`           | Admin: revoke (not your own)                    |

### 10.2 Instances

| Method   | Path                              | Description                                     |
|----------|-----------------------------------|-------------------------------------------------|
| `GET`    | `/api/instances`                  | List (Docker + SQLite merged)                   |
| `POST`   | `/api/instances`                  | Create — body includes `networkPolicy`, `llmBackend`, `dockerSocket`, `expiryHours` |
| `GET`    | `/api/instances/:id`              | Detail                                          |
| `PATCH`  | `/api/instances/:id`              | Update `name` / `notes` / `tags`                |
| `DELETE` | `/api/instances/:id`              | Remove (`?removeVolume=true` deletes the volume too) |
| `POST`   | `/api/instances/:id/start`        | Start (also re-writes ACL once IP is known)     |
| `POST`   | `/api/instances/:id/stop`         | Stop                                            |
| `POST`   | `/api/instances/:id/recreate`     | Recreate with new `dockerSocket` / `networkPolicy` (preserves volume) |
| `POST`   | `/api/instances/:id/exec`         | Run a shell command for testing/admin           |
| `GET`    | `/api/instances/discover`         | Adoptable unmanaged containers                  |
| `POST`   | `/api/instances/adopt`            | Adopt one                                       |

### 10.3 Grants

| Method   | Path                              | Description                                     |
|----------|-----------------------------------|-------------------------------------------------|
| `GET`    | `/api/instances/:id/grants`       | List active grants for an instance              |
| `POST`   | `/api/instances/:id/grants`       | Create a manual grant                           |
| `POST`   | `/api/grants/:grantId/renew`      | Renew (admin)                                   |
| `POST`   | `/api/grants/:grantId/recreate`   | Recreate the container *without* this capability |
| `DELETE` | `/api/grants/:grantId`            | Revoke (admin)                                  |

### 10.4 Access requests

| Method | Path                                      | Description                                                |
|--------|-------------------------------------------|------------------------------------------------------------|
| `POST` | `/api/instances/:id/request-access`       | **From inside the container** — submit a request           |
| `GET`  | `/api/instances/:id/request-access`       | **From inside the container** — poll request status         |
| `GET`  | `/api/instances/:id/access`               | **From inside the container** — effective approved access  |
| `GET`  | `/api/access-requests`                    | Admin: list pending requests                               |
| `POST` | `/api/access-requests/:requestId/approve` | Admin: approve (`{ expiryHours? }`)                        |
| `POST` | `/api/access-requests/:requestId/deny`    | Admin: deny                                                |

### 10.5 LiteLLM + policies

| Method | Path                                    | Description                                  |
|--------|------------------------------------------|----------------------------------------------|
| `GET`  | `/api/policies`                          | List policies (public — read by `cm-access`) |
| `GET`  | `/api/litellm/status`                    | Whether LiteLLM is reachable + master key set |
| `GET`  | `/api/litellm/models`                    | LiteLLM model list                           |
| `GET`  | `/api/instances/:id/litellm`             | Per-instance usage + budget                  |
| `POST` | `/api/instances/:id/litellm/rotate`      | Rotate the virtual key                       |

### 10.6 WebSocket endpoints

| Path                              | Direction       | Purpose                                                   |
|-----------------------------------|-----------------|-----------------------------------------------------------|
| `/api/instances/events`           | Server → Client | `instance_*`, `grant_expired`, `access_requested`, `access_resolved` |
| `/api/instances/:id/terminal`     | Bidirectional   | xterm.js terminal session (tmux-backed)                   |

### 10.7 System + file sharing

| Method | Path                       | Description                              |
|--------|----------------------------|------------------------------------------|
| `GET`  | `/api/system`              | Docker info, counts, config              |
| `GET`  | `/api/system/activity`     | Activity log (last 50 entries)           |
| `POST` | `/api/shared/upload`       | Upload to `/shared` (multipart, 50 MB)   |

---

## 11. Configuration

All configuration is via environment variables; see `.env.example`.

| Variable                  | Default                        | Purpose                                                    |
|---------------------------|--------------------------------|------------------------------------------------------------|
| `PORT`                    | `3002`                         | Server port (inside the container)                         |
| `NODE_ENV`                | `development`                  | `production` / `development`                               |
| `LOG_LEVEL`               | `info`                         | Fastify log level                                          |
| `DATA_DIR`                | `/data`                        | SQLite + auto-backups                                      |
| `CLAUDE_IMAGE`            | `claude-workspace:latest`      | Default workspace image                                    |
| `CLAUDE_NETWORK`          | `claude-manager-net`           | Bridge network for manager + all instances                 |
| `MAX_INSTANCES`           | `20`                           | Hard cap on managed instances                              |
| `SHARED_DIR`              | `/shared`                      | Manager's own `/shared` mount source                       |
| `INSTANCE_SHARED_DIR`     | *(unset)*                      | **Host** path bind-mounted as `/shared` in every instance  |
| `INSTANCE_CLAUDE_DIR`     | *(unset)*                      | **Host** path bind-mounted as `/home/claude/.claude`       |
| `INSTANCE_MEMORY_BASE_DIR`| *(unset)*                      | **Host** base dir for per-instance `/workspace/.claude`    |
| `INSTANCE_MEMORY_DIR`     | *(unset)*                      | Legacy single-shared project memory; leave empty           |
| `ADMIN_RESET_TOKEN`       | *(unset)*                      | Emergency admin promotion via `?reset_token=…`             |
| `DEFAULT_NETWORK_POLICY`  | `unrestricted`                 | Pre-selected policy in the create modal                    |
| `POLICIES_HOST_DIR`       | *(unset)*                      | Host path of `workspace/policies/`; bind-mounted as `/policies` (RO) |
| `POLICIES_VOLUME`         | `cm-policies`                  | Alternative to `POLICIES_HOST_DIR` for DinD setups         |
| `POLICIES_DIR`            | `/app/policies` (in container) | Where the manager reads policy YAML from                   |
| `PROXY_URL`               | `http://cm-proxy:3128`         | Forward proxy injected into restricted instances           |
| `PROXY_ACL_DIR`           | `/proxy-acl`                   | Where the manager writes per-container ACLs                |
| `LITELLM_API_BASE`        | `http://cm-litellm:4000`       | LiteLLM admin + completion endpoint                        |
| `LITELLM_MASTER_KEY`      | *(unset)*                      | LiteLLM admin key (for creating virtual keys)              |
| `LITELLM_DEFAULT_BUDGET`  | `20`                           | Default per-instance USD budget on virtual keys            |

LiteLLM also reads `AZURE_AI_API_KEY` and `GPTLATEST_AZURE_AI_API_KEY`
for the `foundry` / `foundry-latest` backends — see
`litellm/config.yaml`.

---

## 12. Build + deploy

```bash
docker compose -f docker-compose.v2.yml --profile build-only build
docker compose -f docker-compose.v2.yml up -d
```

The `build-only` profile builds the workspace image alongside the
manager. NVIDIA Container Toolkit is required for `cm-ollama` to see
the GPU. For prerequisites, env-var setup, GPU configuration, and
operational concerns, see [deployment.md](deployment.md).

---

## 13. Repository layout

```
claude-manager/
├── brief.md                    project self-summary (start here)
├── CLAUDE.md                   project-level context for Claude Code
├── README.md
├── docker-compose.v2.yml       v2 stack (active)
├── docker-compose.yml          v1 stack (legacy)
├── v2/                         active manager backend + frontend
│   ├── Dockerfile
│   ├── package.json
│   ├── server/                 (see §7)
│   ├── src/                    (see §8)
│   ├── shared/constants.js
│   ├── policies/               policy YAML — same content as workspace/policies/
│   └── tests/                  10 v2 integration tests
├── proxy/                      cm-proxy image (squid + watch-acls)
├── litellm/                    cm-litellm image (LiteLLM + config.yaml)
├── workspace/                  claude-workspace image source
│   ├── Dockerfile
│   ├── config/tmux.conf
│   ├── policies/               canonical policy YAML (bind-mounted into the manager)
│   └── scripts/
│       ├── entrypoint.sh       iptables lock when restricted
│       ├── cm-access           network access CLI for agents
│       ├── init-firewall.sh
│       └── proxy-bootstrap.js  Node.js https-proxy-agent shim
├── data/                       runtime config + memory (git-tracked)
│   ├── shared/
│   ├── claude-home/            includes global CLAUDE.md with cm-access workflow
│   └── instance-memory/
├── scripts/dev.sh
├── server/ · src/ · workspace/ shared by v1 (legacy)
└── docs/
    ├── architecture.md         (this file)
    ├── deployment.md
    ├── operations.md
    ├── roadmap.md
    └── diagrams/               .dot · .puml · .mmd · .py · .md sources + PNGs
        └── archive/            old .drawio (reference)
```
