# Claude Manager v2 — Operations Guide

Day-to-day operations guide for the v2 dashboard. The dashboard runs
on port **3002** (`docker-compose.v2.yml`). For prerequisites and
initial setup, see [deployment.md](deployment.md); for the design
behind these features, see [architecture.md](architecture.md).

> The legacy v1 stack (port 3000) is not covered here.

---

## 1. Dashboard overview

A single-page React app with four main areas:

| Area | Location | Purpose |
|------|----------|---------|
| Header bar | Top | Status indicator, instance count, Upload, **New Instance** |
| Container grid / list | Center | All managed and unmanaged claude-workspace containers |
| Activity + access requests | Below the grid (collapsible) | Recent actions and **pending access requests** awaiting admin decision |
| Terminal panel | Bottom (docked, tabbed) | Tabbed, resizable terminal access to running containers |

### Header bar

- **Status indicator** — coloured dot showing Docker connection health.
- **Instance count** — managed instances versus `MAX_INSTANCES`.
- **LiteLLM status** — small badge if LiteLLM is reachable.
- **Upload to /shared** — file picker.
- **+ New Instance** — opens the creation modal.

### Container grid / list

All containers in a unified view. Managed containers show full
controls + grant badges; unmanaged claude-workspace containers carry
an "Unmanaged" badge and an **Adopt** button. Toggle grid ↔ list view
from the header.

Each card carries small badges for: network policy, LLM backend, any
active capability grants (with time remaining), and any pending access
requests.

### Activity / access-requests panel

Collapsible panel between the grid and the terminal. Tracks lifecycle
events (last 50 in SQLite). The same panel surfaces **pending access
requests** from inside containers — approve / deny from here.

### Terminal panel

Docked at the bottom. Supports multiple tabs, drag-to-resize, minimise
(Esc), maximise. Each tab is one terminal session on one running
container.

---

## 2. Managing instances

### Creating an instance

1. Click **+ New Instance**.
2. Fill in the form:

| Field | Required | Description |
|-------|----------|-------------|
| Name | Yes | Alphanumeric, space, hyphen, underscore — 1-100 chars |
| Image | No | Defaults to `CLAUDE_IMAGE` |
| Notes | No | Free-text for your own reference |
| Tags | No | Free-text tags (used for filtering) |
| Network policy | Yes | `claude-only` / `claude-github` / `claude-full-dev` / `unrestricted` |
| LLM backend | Yes | `claude-max` / `local-llm` / `foundry` / `foundry-latest` |
| Auto-start | No | When checked, the container starts immediately after creation |
| Allow Docker socket | No | When checked, `/var/run/docker.sock` is mounted (registers a 24 h capability grant) |
| Expiry hours | No | Override the default 24 h TTL on high-risk capability grants |

The form previews the selected policy YAML so you can see exactly what
hosts will be allowed.

3. Click **Create**.

**Behind the scenes:**

- The name → slug (lowercase, non-alphanumeric → hyphens, max 40 chars).
- Container `cm-instance-{slug}-{id}` and volume `cm-workspace-{slug}-{id}`.
- Per-instance memory dir `data/instance-memory/{slug}/` created on the
  host (bind-mounted as `/workspace/.claude`).
- Bind-mounts for `/shared` and `/home/claude/.claude` are learned from
  any existing managed/adopted/unmanaged claude-workspace container,
  so a fresh instance inherits your layout without manual config.
- For any policy other than `unrestricted`, `HTTP_PROXY` /
  `HTTPS_PROXY` env are injected, `NET_ADMIN` capability is added, and
  the entrypoint installs iptables rules locking outbound to the
  proxy + Docker-internal networks.
- For any backend other than `claude-max`, the manager mints a
  per-instance LiteLLM virtual key and injects
  `ANTHROPIC_BASE_URL=http://cm-litellm:4000` +
  `ANTHROPIC_API_KEY=<virtual-key>` so Claude Code talks to LiteLLM
  using its native protocol.
- The manager writes the per-container ACL file under `/proxy-acl/`;
  squid reconfigures within ~1 second via inotify.
- Capability grants (`docker_socket`, `network_unrestricted`) are
  created if applicable.

### Starting and stopping

- **Start** / **Stop** buttons on the instance card.
- Stopping has a 10-second graceful timeout (Docker SIGTERM → SIGKILL).
- Real-time WebSocket updates — no refresh needed.
- The proxy ACL is re-written on start (so the new container IP is
  used).

### Recreating (preserve volume)

Toggle "Allow Docker socket" or change the network policy via the UI →
the manager `POST /api/instances/:id/recreate` which removes and
re-creates the container with the same volumes. Terminal sessions are
dropped during recreation.

### Removing an instance

1. Click **Remove**.
2. Confirm.

By default the workspace volume is **kept** so files survive removal.
Tick "Also delete volume" to remove `cm-workspace-{slug}-{id}` as
well. Removal also:

- Deletes capability grants for the instance.
- Deletes the proxy ACL file.
- Revokes the LiteLLM virtual key (if any).
- Deletes the SQLite row.

### Adopting existing containers

Containers without `claude-manager.managed=true` appear with an
"Unmanaged" badge if they:

- Use the configured `claude-workspace` image, **or**
- Have a name starting with `claude-` (except `claude-manager` /
  `claude-manager-v2`).

Click **Adopt** to track them by `docker_id` (labels can't be added to
running containers). Full management — start/stop/remove/terminal —
becomes available immediately.

---

## 3. Network policy & access requests

### Choosing a policy

Pick at instance creation, or change later via the recreate flow.

| Policy | What it allows |
|--------|----------------|
| `claude-only` | `api.anthropic.com`, `statsig.anthropic.com`, `sentry.io` |
| `claude-github` | + GitHub (web, API, raw, objects, gist, ssh) |
| `claude-full-dev` | + npm, yarn, PyPI, files.pythonhosted.org, Cargo, Docker Hub |
| `unrestricted` | No filtering — requires `network_unrestricted` grant (default 24 h) |

The exact host lists live in `workspace/policies/*.yaml`. Drop in a
custom YAML there to add new policies (restart manager to pick it up).

### Approving access requests

Agents running inside a restricted container can ask for more access
through `cm-access`:

```bash
cm-access --request --policy claude-full-dev --reason "Need to npm install"
cm-access --request --hosts "api.example.com" --reason "Fetch data"
```

In the **Access Requests** panel at the top of the activity column,
each pending request shows:

- The instance name and ID
- What was requested (a policy upgrade, extra hosts, or both)
- The agent's stated reason

For each request:

- **Approve** — optional `expiryHours` override. Policy upgrades
  recreate the container (preserving the volume) and register a fresh
  `network_unrestricted` grant if relevant. Host additions update the
  proxy ACL in place — no container restart, the new hosts are
  reachable within a second.
- **Deny** — logged, the agent's poll returns `denied`.

Approved extra hosts persist (SQLite `access_requests`) and are
re-applied on manager restart by `syncAllACLs()`.

### Inspecting a container's effective access

```bash
docker exec cm-instance-<slug>-<id> cm-access --status
docker exec cm-proxy cat /etc/squid/acl/<id>.acl   # raw ACL for that container
```

---

## 4. LLM backend selection

Each instance picks one of:

| Backend | Routing | Requires |
|---------|---------|----------|
| `claude-max` | Direct `api.anthropic.com` | `claude login` inside the container |
| `local-llm` | Qwen3 30B-A3B via Ollama → LiteLLM | `cm-ollama` reachable, `LITELLM_MASTER_KEY` set |
| `foundry` | Azure AI Foundry `gpt-4.1-mini-1` via LiteLLM | `AZURE_AI_API_KEY` |
| `foundry-latest` | Azure AI Foundry `gpt-chat-latest` via LiteLLM | `GPTLATEST_AZURE_AI_API_KEY` |

Non-`claude-max` backends use the **per-instance LiteLLM virtual key**
stored in `instances.litellm_key`. Each key has a budget (default $20,
configurable via `LITELLM_DEFAULT_BUDGET`). The **LiteLLM panel** on
each instance card shows usage + budget; rotate the key from there if
needed.

LiteLLM (`litellm/config.yaml`) maps Claude model names (e.g.
`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`) to
Qwen3 for the `local-llm` backend, so Claude Code's model selection
works without modification.

---

## 5. Capability grants

The dashboard surfaces two grant types:

| Grant | Default TTL | What it covers |
|-------|-------------|----------------|
| `docker_socket` | 24 h | The `/var/run/docker.sock` bind in the instance |
| `network_unrestricted` | 24 h | The `unrestricted` network policy |

Each instance card shows a **grant badge** with time remaining. From
the badge you can:

- **Renew** (admin) — bump the expiry by another N hours.
- **Recreate without** — instantly recreate the container with the
  capability removed (`docker_socket: false` or
  `networkPolicy: claude-github`).
- **Revoke** (admin) — deactivate the grant immediately. The grant
  checker stops the container on the next pass (60 s).

Expired grants:

- A 60-second timer (`checkExpiredGrants`) **stops** any container
  whose grant has expired and emits a `grant_expired` WebSocket event.
- The container can be started again, but the underlying capability
  is still in place — start + a fresh grant, or recreate-without-it
  for a clean state.

---

## 6. Terminal access

### Opening a terminal

1. The container must be in the **Running** state.
2. Click **Terminal** on the instance card.
3. A new tab opens in the bottom panel.

### Behaviour

- Sessions are tmux-backed (`tmux -L cm -f /dev/null new-session -A
  -s main`). Open the same instance from a second browser/device and
  you join the **same shell**.
- Closing the tab sends a tmux detach (`Ctrl-a d`) so the session
  lives on.
- Reconnecting attaches and replays the scrollback.

### Panel controls

| Control | Action |
|---------|--------|
| Drag top edge | Resize panel vertically |
| Minimise | Collapse (or press Esc) |
| Maximise | Expand to full height |
| Close tab | End the WebSocket — tmux session persists |
| Close all | Close every tab and collapse the panel |

### Keyboard

| Key | Action |
|-----|--------|
| Esc | Minimise the terminal panel |

---

## 7. File upload

`Upload to /shared` in the header writes to the bind-mounted `/shared`
directory. Every instance with `/shared` bind-mounted sees the file
immediately.

- Max file size: **50 MB**.
- Filename sanitisation strips path-traversal characters.
- Toast confirms success / failure.

---

## 8. Activity log

Recent lifecycle events with relative timestamps (last 50 in SQLite).

| Action | Description |
|--------|-------------|
| Created | A new instance was created |
| Started | An instance was started |
| Stopped | An instance was stopped |
| Recreated | Container recreated (socket/policy toggle, access-request approval) |
| Removed | An instance was removed |
| Adopted | An unmanaged container was adopted |
| Grant expired | A capability grant TTL ran out — the container was stopped |
| Access requested | An agent asked for more network access |
| Access approved / denied | Admin resolved an access request |

---

## 9. Multi-device access and device authentication

Open `http://<host>:3002` from any device on the network. **TOFU device
authentication** is on by default — the cookie *is* the credential.

### First-time setup

1. From the device you'll use as admin, open the dashboard. It is
   auto-approved and immediately functional.
2. Open the **Devices** panel (admin only) to see the device list.

### Adding another device

1. Open the dashboard from the new device. It registers automatically
   and lands on a **Waiting for approval** page.
2. From an admin device, open the Devices panel.
3. Click **Approve** next to the new device.
4. The pending device polls every few seconds and unlocks once
   approved.

Devices can be renamed or revoked. You cannot revoke your own device —
promote another device first, or revoke yours from a different one.

### Lockout recovery

If you lose every admin device:

1. Set `ADMIN_RESET_TOKEN=<long-random>` in `.env`.
2. Restart the manager.
3. From a fresh browser, visit
   `http://<host>:3002/?reset_token=<long-random>` — that device is
   registered as a new admin.
4. Clear `ADMIN_RESET_TOKEN` from `.env` after recovery.

Device tokens are SHA-256 hashed in the `devices` table. The browser
holds a 10-year `HttpOnly` cookie — clearing site data logs the device
out.

---

## 10. Container states

| State | Colour | Description |
|-------|--------|-------------|
| Running | Green | Active. Terminal available. Status shows uptime. |
| Exited | Gray | Stopped. Can be started again. Shows exit code. |
| Created | Yellow | Exists but never started. |
| Paused | Blue | `docker pause`d. |
| Restarting | Yellow | Currently restarting. |
| Removing | Red | Removal in progress. |
| Dead | Red | Dead state — may need manual cleanup. |

---

## 11. Monitoring

### At a glance

- **Instance count** in the header — managed vs. `MAX_INSTANCES`.
- **Docker connection** — green/red dot.
- **LiteLLM status** — small badge if reachable.
- **Per-instance** — state, network policy, LLM backend, grant
  timers, pending access requests.
- **Activity log** — audit trail.

### Logs

```bash
docker compose -f docker-compose.v2.yml logs claude-manager-v2 --tail 50 -f
docker compose -f docker-compose.v2.yml logs cm-proxy --tail 50
docker compose -f docker-compose.v2.yml logs cm-litellm --tail 50
docker compose -f docker-compose.v2.yml logs cm-ollama --tail 50
```

---

## 12. Data persistence

| Component | Location | Purpose |
|-----------|----------|---------|
| SQLite DB | Docker volume `claude-manager-v2-data` → `/data/manager.db` | Instance metadata, devices, grants, access requests, LiteLLM keys, activity log |
| Per-instance workspace | Docker volume `cm-workspace-{slug}-{id}` | Code & files at `/workspace` |
| Per-instance project memory | `data/instance-memory/{slug}/` on host | Mounted at `/workspace/.claude` (isolated, git-tracked) |
| Global Claude config | `data/claude-home/` on host | Mounted at `/home/claude/.claude` (shared, git-tracked, auth gitignored) |
| Shared files | `data/shared/` on host | Mounted at `/shared` (shared, git-tracked) |
| Proxy ACLs | Docker volume `proxy-acl` | Manager writes, squid reads. Regenerated on startup. |
| LiteLLM state | Docker volume `litellm-db` (PostgreSQL) | Virtual keys, spend tracking. |
| Ollama models | Docker volume `ollama-data` | Downloaded model weights. |

### Startup sync

On every startup:

1. `initDb()` snapshots the current DB to `/data/backups/`, then
   applies any missing-column migrations.
2. `syncWithDocker()` reconciles SQLite with Docker — inserts missing
   rows, prunes orphans except adopted (`docker_id`-tracked)
   containers.
3. `syncAllACLs()` writes a fresh ACL file for every running managed
   container, re-applying any approved access-request hosts.

---

## 13. Common workflows

### Start a new project

1. Click **+ New Instance**.
2. Name (e.g. `my-api-service`), pick a network policy
   (e.g. `claude-github`), pick a backend
   (`claude-max` if you're using your Claude Max subscription).
3. Auto-start ticked, Create.
4. Open **Terminal**, run `claude login` (for `claude-max`),
   then start working.

### Continue work on another device

1. Open `http://<host>:3002` on the other device — approve via the
   admin panel.
2. Find the instance, open its terminal — the tmux session resumes
   exactly where you left off.

### Share a file with all instances

1. Click **Upload to /shared** in the header.
2. Select the file.
3. Every instance with `/shared` mounted sees it immediately.

### Promote an instance from claude-only to claude-github

Option A — operator decides:

1. On the instance card, click the policy badge → **Change policy**.
2. Pick `claude-github`, confirm — the container is recreated with the
   new proxy env. Volume preserved.

Option B — agent asks:

1. Inside the container: `cm-access --request --policy claude-github
   --reason "Need to clone repo X"; cm-access --poll`.
2. Admin sees the request in the panel, approves with an optional
   expiry override.
3. `cm-access --poll` returns `approved`; the agent retries.

### Add one extra host without changing policy

Inside the container:

```bash
cm-access --request --hosts "api.example.com" --reason "Fetch data"
cm-access --poll
```

The admin approves; the proxy ACL is updated within ~1 second. **No
container restart**.

### Clean up a removed instance's data

1. Remove the instance from the dashboard (tick "Also delete volume"
   to include `cm-workspace-{slug}-{id}`).
2. Optionally remove the per-instance memory dir
   `data/instance-memory/{slug}/`.
