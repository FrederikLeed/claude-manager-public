# Claude Manager — Project Plan & Build Instructions

> **This document is written for a Claude Code instance that will build this project.**
> Read it fully before writing a single line of code. It contains context, decisions, and rationale that will save you from going down wrong paths.

---

## What This Is

**Claude Manager** is a self-hosted web UI that runs as a Docker container and manages other Claude Code containers on the same Docker host. Think of it as a lightweight Portainer, but purpose-built for Claude Code workspaces.

The operator runs it on a Linux host with an NVIDIA GPU. There is a working `claude-workspace` Docker setup with a `CLAUDE.md` for context persistence. This tool manages instances of that workspace — and will evolve over time with features no other tool will add fast enough.

---

## Why Not Use an Existing Tool

Researched the full ecosystem. Here is what exists and why none of them fit:

| Tool | What it does | Why it doesn't fit |
|---|---|---|
| **CloudCLI / claudecodeui** | Web UI wrapping a single Claude Code install, session management via `~/.claude` SQLite | Manages sessions within one Claude Code install, not isolated Docker containers. GPL-3.0. Large codebase, wrong abstraction layer. |
| **Codeman** | Web UI over tmux PTY sessions, circuit breaker, health scoring | tmux-based, not Docker-native. Great patterns to steal, wrong runtime model. |
| **ClaudeBox** | CLI tool for per-project isolated Docker images with profile system | CLI-only, no web UI, no management plane. Good Dockerfile patterns to reference. |
| **claude-tmux** | Rust TUI for tmux session management | Terminal-only, macOS/tmux-dependent. |
| **HolyClaude** | Single Claude Code container with browser | Single instance, not a manager. |
| **ksred dashboard** | Go/React dashboard reading `~/.claude` SQLite, WebSocket real-time | Read-only monitoring of sessions within one install. Good WebSocket pattern. |

**The actual reason for container-per-project**: it is not primarily about security isolation. It is about **cognitive isolation**.

A Claude Code instance that has spent weeks on AD security work carries that context into everything it touches. Ask it to write a Home Assistant integration and it will still be thinking in PowerShell and Kerberos. Context windows fill up. Long-running sessions accumulate noise. The model starts making decisions based on stale assumptions from three tasks ago — it sands up.

A fresh container with its own `/workspace` volume and a sharp `CLAUDE.md` starts clean. It knows exactly what it is working on, nothing more. This is the core design principle inherited from the `claude-workspace` project this builds on:

```
/workspace         → isolated named volume per project (code, deps, state)
/shared            → bind mount, ALL containers can read it (shared snippets, templates)
/project-memory    → bind mount, all containers, but /<slug>/ subfolder per project
CLAUDE.md          → context file Claude Code reads automatically at session start
```

Claude Manager is the management layer on top of that model — a web UI that replaces the manual `new-project.sh` CLI with a dashboard that handles the full lifecycle. The unit of work is still the container. The motivation is still cognitive isolation, not process isolation.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Docker Host (Linux)                         │
│                                              │
│  ┌──────────────────────┐                    │
│  │  claude-manager      │  :3000 → browser   │
│  │  (this project)      │                    │
│  │  Node.js + React     │                    │
│  │  /var/run/docker.sock│◄── mounted         │
│  └──────────┬───────────┘                    │
│             │ Docker SDK                     │
│             ▼                                │
│  ┌──────────────────────────────────┐        │
│  │  claude-instance-1  (container)  │        │
│  │  claude-instance-2  (container)  │        │
│  │  claude-instance-N  (container)  │        │
│  └──────────────────────────────────┘        │
└─────────────────────────────────────────────┘
```

### Runtime model

- **Manager container** mounts `/var/run/docker.sock` and uses the Docker Engine API directly (via `dockerode` Node.js library) to list, start, stop, create, and inspect containers.
- **Claude instances** are containers built from the existing `claude-workspace` image (or a derivative). Each gets its own named volume for workspace persistence.
- **Communication**: Manager talks to instances via Docker exec (run commands inside containers) or via exposed ports if the instance exposes a terminal/API.
- **Frontend**: Single-page React app served by the Node.js backend. No separate frontend dev server in production.

---

## Tech Stack Decisions

These are decided. Do not second-guess them without strong reason.

| Layer | Choice | Rationale |
|---|---|---|
| Backend runtime | **Node.js 22** | `dockerode` is the best Docker SDK available, mature, well-typed. Matches frontend language. |
| Backend framework | **Fastify** | Fast, schema-first, built-in WebSocket plugin. Lower boilerplate than Express. |
| Docker SDK | **dockerode** | Native Node.js Docker Engine API client. Full API coverage. |
| Frontend | **React 18 + Vite** | Fast iteration. Vite proxies API in dev, serves static in prod. |
| Terminal emulation | **xterm.js** | Industry standard. Used by VS Code, Codeman, CloudCLI. Attach to container PTY via Docker exec. |
| Real-time updates | **WebSocket** (via `@fastify/websocket`) | Push container state changes to browser. Codeman and ksred dashboard proved this pattern works well. |
| Styling | **Tailwind CSS** | Utility-first, no design system overhead for an internal tool. |
| Persistence | **SQLite (via better-sqlite3)** | Store manager-level metadata (instance names, tags, notes, config) that Docker labels don't handle. |
| Container format | **Docker Compose** | Manager itself deployed via compose. Instance containers also created with compose-compatible config stored as JSON. |

---

## Project Structure

```
claude-manager/
├── CLAUDE.md                    ← context file for Claude Code instances working on this project
├── docker-compose.yml           ← production deployment
├── docker-compose.dev.yml       ← dev mode with volume mounts
├── Dockerfile                   ← manager container image
├── .env.example
├── server/
│   ├── index.js                 ← Fastify app entry point
│   ├── docker.js                ← dockerode wrapper / Docker service layer
│   ├── instances.js             ← instance lifecycle (create, start, stop, remove)
│   ├── terminal.js              ← PTY/exec WebSocket handler
│   ├── db.js                    ← SQLite setup and queries
│   ├── routes/
│   │   ├── instances.js         ← REST: CRUD for instances
│   │   ├── terminal.js          ← WS: attach terminal to container
│   │   └── system.js            ← REST: host info, Docker info
│   └── config.js                ← env var config with defaults
├── src/                         ← React frontend (Vite)
│   ├── main.jsx
│   ├── App.jsx
│   ├── components/
│   │   ├── Dashboard.jsx        ← main landing page, instance grid
│   │   ├── InstanceCard.jsx     ← single instance status card
│   │   ├── NewInstanceModal.jsx ← create instance form
│   │   ├── Terminal.jsx         ← xterm.js terminal panel
│   │   └── StatusBadge.jsx
│   ├── hooks/
│   │   ├── useInstances.js      ← WebSocket + REST state management
│   │   └── useTerminal.js       ← terminal connection logic
│   └── api.js                   ← fetch wrapper for REST endpoints
├── shared/
│   └── constants.js             ← shared between server and client (instance states, labels)
└── scripts/
    └── dev.sh                   ← convenience dev startup script
```

---

## CLAUDE.md for This Project (embed in repo root)

Create this file at `claude-manager/CLAUDE.md`:

```markdown
# Claude Manager — Developer Context

## What this project is
A Docker container management UI specifically for Claude Code workspace containers.
Runs as a container itself. Manages sibling containers via Docker socket mount.

## Key files to understand first
- server/docker.js — all Docker Engine API interaction
- server/instances.js — instance lifecycle logic
- server/routes/instances.js — REST API
- src/components/Dashboard.jsx — main UI entry point

## Environment
- Node.js 22
- Fastify backend
- React 18 + Vite frontend
- dockerode for Docker API
- SQLite (better-sqlite3) for manager metadata
- xterm.js for terminal emulation

## Development
npm run dev    # starts both Vite dev server (5173) and Fastify (3001) concurrently
npm run build  # builds frontend into server/public/, then Fastify serves it

## Docker context
The manager container mounts /var/run/docker.sock from the host.
Instance containers are identified by the label: claude-manager.managed=true
Instance metadata (human name, tags, notes) stored in SQLite at /data/manager.db

## Naming conventions
- Docker container names: cm-instance-{id}
- Docker volumes: cm-workspace-{id}
- Docker network: claude-manager-net

## Do not
- Do not use docker-compose CLI from within the container (no CLI in image)
- Do not store auth tokens in SQLite, use Docker secrets or env vars
- Do not hardcode image names, read from CLAUDE_IMAGE env var
```

---

## Phase 1 — MVP (Build This First)

**Goal**: Working end-to-end. Can see containers, create new ones, start/stop, and open a terminal.

### Phase 1 Deliverables

#### 1.1 — Project scaffold

```bash
mkdir claude-manager && cd claude-manager
npm init -y
npm install fastify @fastify/websocket @fastify/static @fastify/cors dockerode better-sqlite3 dotenv
npm install -D vite @vitejs/plugin-react react react-dom tailwindcss concurrently
npx tailwindcss init
```

#### 1.2 — Docker service layer (`server/docker.js`)

Implement these functions using `dockerode`:

```javascript
// Must implement:
listManagedContainers()     // filters by label claude-manager.managed=true
getContainer(id)            // inspect single container
createInstance(opts)        // create container + volume, apply labels
startInstance(id)
stopInstance(id)
removeInstance(id, { removeVolume: false })
execInContainer(id, cmd)    // for health checks
attachPTY(id)               // returns dockerode exec stream for terminal
getDockerInfo()             // docker system info for system page
```

All containers created by the manager MUST have the label `claude-manager.managed=true` so the manager only sees its own instances and not unrelated host containers.

#### 1.3 — SQLite schema (`server/db.js`)

```sql
CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,           -- Docker container ID (short)
  name TEXT NOT NULL,            -- human-readable name
  image TEXT NOT NULL,           -- Docker image used
  created_at INTEGER NOT NULL,
  notes TEXT,
  tags TEXT,                     -- JSON array
  port INTEGER                   -- allocated host port if any
);
```

Sync on startup: query Docker for all managed containers, upsert into SQLite. Docker is the source of truth for container state; SQLite holds only manager-level metadata.

#### 1.4 — REST API routes (`server/routes/instances.js`)

```
GET    /api/instances              list all managed instances (merged Docker + SQLite data)
POST   /api/instances              create new instance
GET    /api/instances/:id          get single instance detail
POST   /api/instances/:id/start    start stopped instance
POST   /api/instances/:id/stop     stop running instance
DELETE /api/instances/:id          remove instance (body: { removeVolume: bool })
GET    /api/system                 Docker host info
```

#### 1.5 — WebSocket for real-time state (`server/routes/instances.js`)

```
WS /api/instances/events      push container state changes to all connected clients
```

On server startup, start a polling loop (every 3 seconds) using `dockerode`'s event stream or container list diff. Push JSON events to all connected WebSocket clients:

```json
{ "type": "instance_updated", "id": "abc123", "status": "running" }
{ "type": "instance_created", "id": "def456" }
{ "type": "instance_removed", "id": "abc123" }
```

#### 1.6 — Terminal WebSocket (`server/routes/terminal.js`)

```
WS /api/instances/:id/terminal
```

On connection:
1. Call `dockerode` exec to create a PTY session inside the container
2. Pipe container stdout → WebSocket → xterm.js in browser
3. Pipe WebSocket input ← xterm.js → container stdin
4. Handle resize events (xterm sends `{ type: "resize", cols, rows }`)
5. On WebSocket close, kill exec session

Reference: Codeman's PTY implementation (GitHub: Ark0N/Codeman, `src/session.js`) is the best open-source example of this pattern.

#### 1.7 — Frontend Dashboard

`Dashboard.jsx` layout:
- Top bar: "Claude Manager" title, Docker host status dot (green/red), "+ New Instance" button
- Instance grid: 3-column responsive grid of `InstanceCard` components
- Each `InstanceCard` shows: name, status badge, image, created time, CPU/mem sparkline (Phase 2), action buttons (Start/Stop/Terminal/Remove)
- `NewInstanceModal`: form with fields: Name (text), Image (text, default from env), Notes (textarea), and a "Create" button

`useInstances.js` hook:
- On mount: `GET /api/instances`
- Open WebSocket to `/api/instances/events`
- On event: update local state accordingly
- Expose: `instances`, `createInstance(opts)`, `startInstance(id)`, `stopInstance(id)`, `removeInstance(id)`

`Terminal.jsx`:
- Opens WebSocket to `/api/instances/:id/terminal`
- Renders `xterm.js` terminal
- Handles resize with `ResizeObserver`
- Displayed in a slide-over panel or modal overlay

#### 1.8 — Dockerfile (manager image)

```dockerfile
FROM node:22-alpine

WORKDIR /app

# Install build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --production

COPY server/ ./server/
COPY dist/ ./dist/          # pre-built React app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV CLAUDE_IMAGE=claude-workspace:latest

EXPOSE 3000

CMD ["node", "server/index.js"]
```

#### 1.9 — docker-compose.yml (production)

```yaml
version: '3.9'

services:
  claude-manager:
    build: .
    container_name: claude-manager
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - claude-manager-data:/data
    environment:
      - CLAUDE_IMAGE=${CLAUDE_IMAGE:-claude-workspace:latest}
      - CLAUDE_NETWORK=claude-manager-net
    networks:
      - claude-manager-net

networks:
  claude-manager-net:
    name: claude-manager-net
    driver: bridge

volumes:
  claude-manager-data:
```

---

## Phase 2 — Observability (Build After MVP Works)

**Goal**: Actually useful day-to-day. Know what each instance is doing without opening a terminal.

### 2.1 — Live resource metrics per instance

Use `dockerode` container stats stream:
```javascript
container.stats({ stream: true }, callback)
```

Parse CPU % and memory MB. Push via WebSocket to update `InstanceCard` sparklines every 3 seconds. Store last 20 data points per instance in memory (not SQLite — no need to persist).

### 2.2 — Claude Code activity detection

Mount the host's `~/.claude` directory into the manager container (read-only). Watch the SQLite database at `~/.claude/projects/*/` for changes.

Inspired by the ksred dashboard approach: read `~/.claude` SQLite to detect which container/project is actively running a Claude session, how many tokens have been used, and session duration.

Map `~/.claude` project paths to container workspace volume mount paths to correlate sessions with containers.

```yaml
# Add to docker-compose.yml volumes:
- ${HOME}/.claude:/host-claude:ro
```

```javascript
// server/claude-activity.js
// Watch /host-claude directory for SQLite changes
// Parse projects and session data
// Emit events via WebSocket when session state changes
```

### 2.3 — Container log streaming

```
GET /api/instances/:id/logs?tail=100&follow=true
WS  /api/instances/:id/logs
```

Use `dockerode` `container.logs({ follow: true, stdout: true, stderr: true })`.
Add a "Logs" tab in the instance detail panel alongside "Terminal".

### 2.4 — Instance status enrichment

Detect whether Claude Code is actually running inside the container (not just that the container is running):

```javascript
// exec: pgrep -f "claude" returns 0 if running
const result = await execInContainer(id, ['pgrep', '-f', 'claude'])
```

Show as a sub-status: Container: Running | Claude: Active / Idle / Not started

---

## Phase 3 — Lifecycle Management (Build When Needed)

**Goal**: Manage instances with the same care as real workspaces.

### 3.1 — Instance templates / profiles

Inspired by ClaudeBox's profile system. Store template definitions in SQLite:

```sql
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image TEXT NOT NULL,
  env_vars TEXT,           -- JSON
  volume_config TEXT,      -- JSON
  description TEXT
);
```

"New Instance" modal gets a template dropdown. Templates pre-fill the form.

Default templates:
- **Basic** — claude-workspace image, single workspace volume
- **With Git** — adds git config volume mount
- **Isolated** — no network access except Anthropic API (firewall rules inspired by ClaudeBox's `init-firewall.sh`)

### 3.2 — Workspace file browser

Use `dockerode` exec to run `ls -la` / `find` / `cat` inside container. Simple tree view in the UI. Allow viewing (not editing) files from the manager. Editing should happen inside the terminal.

### 3.3 — Scheduled operations

Simple cron-style scheduler stored in SQLite:
- Auto-stop idle instances after N hours (idle = Claude not running per 2.4 detection)
- Auto-snapshot (commit container to image) before stopping

### 3.4 — Instance notes and tagging

Already in SQLite schema. Add UI: click instance name → edit inline → save. Tags displayed as colored badges on cards. Filter/search instances by tag on dashboard.

---

## Phase 3.5 — Instance Network Policy (NemoClaw-Inspired)

**Goal**: Each Claude instance runs with declarative, per-instance egress policy. Deny by default. No silent data exfiltration. Policy is a YAML file — reviewable, versioned, auditable.

### Background — what NemoClaw got right

NVIDIA NemoClaw (Apache 2.0) is a reference stack for running OpenClaw AI agents securely inside their OpenShell runtime. It solves the same fundamental problem we have: an autonomous AI agent running in a container with unrestricted outbound network access is a risk, even on a private server.

Their key design principles — adapted here for plain Docker (no k3s/OpenShell required):

- **Deny-by-default egress** — container starts with no outbound access; only explicitly allowed endpoints work
- **Policy as YAML** — human-readable, diff-able, can be reviewed in a PR
- **Per-binary allowlisting** — not just "allow api.anthropic.com" but "allow `node` to reach api.anthropic.com" — other binaries (e.g. a compromised shell script) cannot use the same path
- **Static vs dynamic policy** — static policy baked in at container creation, dynamic patches applied to a running container (reset on restart)
- **Operator approval flow** — unknown egress attempts are logged and surfaced to the operator rather than silently dropped

NemoClaw also revealed two important failure modes to avoid:
1. **Binary chain mismatches** (NemoClaw issue #396): if `openclaw` is a Node launcher script, you must allowlist `/usr/bin/node` too — not just the top-level binary. Policy checks happen at the syscall level.
2. **Read-only config files** (NemoClaw issue #719): if the policy marks a config directory read-only but the agent needs to write to it, the agent breaks silently. Be careful with filesystem constraints.

### Policy YAML format (adapted from NemoClaw's `openclaw-sandbox.yaml`)

Each instance gets a `policy.yaml` stored in SQLite (or as a file in the instance volume). Format:

```yaml
# claude-manager instance network policy
# Deny-by-default. Only listed endpoints are reachable.
version: "1"

network:
  egress:
    - name: anthropic-api
      description: "Claude Code model inference"
      endpoints:
        - host: api.anthropic.com
          port: 443
      binaries: [node]
      rules:
        - methods: [POST, GET]

    - name: github
      description: "Git operations"
      endpoints:
        - host: github.com
          port: 443
        - host: api.github.com
          port: 443
        - host: objects.githubusercontent.com
          port: 443
      binaries: [git, node]

    - name: npm-registry
      description: "npm install"
      endpoints:
        - host: registry.npmjs.org
          port: 443
      binaries: [node, npm]

    - name: dns
      description: "DNS resolution"
      endpoints:
        - host: "0.0.0.0/0"
          port: 53
      binaries: ["*"]
      rules:
        - protocols: [udp, tcp]

filesystem:
  workspace: /workspace        # read-write — agent workspace
  claude_config: /root/.claude # read-write — Claude Code state (must be writable)
  tmp: /tmp                    # read-write
  # everything else: read-only or inaccessible
```

### Implementation approach (plain Docker, no k3s)

NemoClaw uses OpenShell's gateway-level policy engine. We use Docker's native network isolation + iptables — simpler, no extra runtime required.

**At container creation** (`server/instances.js`):

```javascript
async function applyEgressPolicy(containerId, policy) {
  // 1. Connect container to an isolated bridge network (no internet by default)
  // 2. Parse policy.yaml egress rules
  // 3. docker exec into container, run iptables rules to allowlist each endpoint:
  //    iptables -A OUTPUT -d api.anthropic.com -p tcp --dport 443 -j ACCEPT
  //    iptables -A OUTPUT -j DROP  (catch-all deny at end)
  // 4. Store applied policy hash in SQLite for drift detection
}
```

Key implementation notes:
- The manager container needs `NET_ADMIN` capability to exec iptables inside instances — OR the instance containers start with `NET_ADMIN` so they can set their own rules
- Prefer the instance sets its own rules (avoids manager needing elevated privileges)
- DNS must always be allowed (port 53, UDP+TCP) — easy to forget, causes mysterious failures
- Allowlist by resolved IP is fragile (CDNs rotate IPs). Use hostname-based rules via `iptables` + `/etc/hosts` injection or an in-container DNS proxy

**Policy presets** (following NemoClaw's preset concept):

Store preset YAML files in `server/policies/presets/`:

```
presets/
  claude-only.yaml        # Anthropic API + DNS only. Maximum isolation.
  claude-github.yaml      # + GitHub for git ops
  claude-full-dev.yaml    # + npm, PyPI, common package registries
  claude-open.yaml        # Unrestricted (for trusted, air-gapped-adjacent use)
```

Template selection in "New Instance" modal: pick a preset as baseline, optionally extend it.

**Policy drift detection**:

On the 3-second polling loop (server/docker.js), also exec `iptables -L OUTPUT` inside each instance and compare against stored policy hash. If drift detected (rules were modified inside the container), surface a warning badge in the UI: ⚠️ Policy drift.

**Manager UI additions**:

- `InstanceCard` gets a policy badge: `🔒 claude-only` / `🔓 open` / `⚠️ drift`
- Instance detail panel: "Network Policy" tab showing the active YAML with allowed endpoints listed
- "Edit Policy" — load preset or write custom YAML, apply to running instance (dynamic) or next restart (static)
- "Blocked Connections" log — parse container stderr for iptables DROP log entries, display in UI as a feed

### SQLite schema additions

```sql
ALTER TABLE instances ADD COLUMN policy_preset TEXT DEFAULT 'claude-github';
ALTER TABLE instances ADD COLUMN policy_yaml TEXT;       -- full YAML if customized
ALTER TABLE instances ADD COLUMN policy_hash TEXT;       -- sha256 of applied rules
ALTER TABLE instances ADD COLUMN policy_drift INTEGER DEFAULT 0;  -- 1 = drift detected

CREATE TABLE IF NOT EXISTS policy_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  event_type TEXT NOT NULL,   -- 'blocked', 'drift', 'applied', 'approved'
  detail TEXT,                -- JSON: host, port, binary, timestamp
  created_at INTEGER NOT NULL
);
```

### What we explicitly do NOT do (unlike NemoClaw)

- No OpenShell/k3s — plain Docker is sufficient for this use case
- No Landlock LSM enforcement — too complex for phase 3, revisit if needed
- No inference routing proxy — Claude Code manages its own API calls, we just firewall the egress
- No operator approval TUI — logged and surfaced in web UI instead

---

## Phase 4 — Multi-Agent Orchestration (Future)

**Goal**: Use the manager to coordinate work across instances.

### 4.1 — Send message to instance

API endpoint that `docker exec`s into a container and sends a string to Claude Code's stdin. Inspired by `send-claude-message.sh` from Tmux-Orchestrator pattern.

```
POST /api/instances/:id/message
Body: { "message": "Please continue working on the auth feature" }
```

### 4.2 — Task assignment board

Kanban board (columns: Idle / Working / Review / Done). Drag instances between columns. Store task context per instance in SQLite. Inspired by Auto-Claude's kanban UI.

### 4.3 — Shared context injection

Mount a shared read-only volume into all instances containing a `SHARED_CONTEXT.md` file. The manager UI can edit this file. Useful for sharing project-wide instructions across instances.

---

## What to Borrow From Existing Projects (With License Awareness)

| What to borrow | From project | License | How to use |
|---|---|---|---|
| PTY → WebSocket bridge pattern | Codeman (Ark0N/Codeman) | MIT | Study and reimplement — the pattern is standard, not the code |
| xterm.js resize/attach pattern | CloudCLI (siteboon/claudecodeui) | GPL-3.0 | Study only — do NOT copy code, reimplement from xterm.js docs |
| `~/.claude` SQLite schema understanding | ksred dashboard | Not yet OSS | Conceptual reference only |
| Container label filtering | Portainer | Apache-2.0 | General Docker pattern, not specific code |
| Firewall init script for instances | ClaudeBox (RchGrav) | MIT | Can adapt `init-firewall.sh` for instance Dockerfiles |
| Claude Code status detection (pgrep pattern) | claude-tmux | AGPL-3.0 | Reimplement the detection logic independently |
| Egress policy YAML structure + preset concept | NemoClaw (NVIDIA) | Apache-2.0 | Adapt the policy schema and preset pattern directly. Do not copy code, but the YAML format and design philosophy can be followed closely. Read `nemoclaw-blueprint/policies/openclaw-sandbox.yaml` for reference. |
| Binary-level allowlisting + static/dynamic policy model | NemoClaw (NVIDIA) | Apache-2.0 | Design principle: rules specify which binaries can reach which endpoints. Static = applied at creation, dynamic = patched to running container (resets on restart). |

**Important**: Do not copy GPL/AGPL code into this project. Reimplement patterns independently. Apache-2.0 code (NemoClaw) can be more freely referenced, but clean reimplementation is preferred to avoid coupling to their internals.

**Lessons from NemoClaw's issue tracker** (avoid these pitfalls):
- Always include the full binary chain in allowlists — if your script is `#!/usr/bin/env node`, allowlist `node`, not just the script path (NemoClaw issue #396)
- Never mark config directories that the agent writes to as read-only in filesystem policy (NemoClaw issue #719)
- Always allow DNS (port 53, UDP+TCP) explicitly — missing this causes failures that look completely unrelated to network policy
- Dynamic policy changes reset on container restart — document this clearly in the UI

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Manager web UI port |
| `DATA_DIR` | `/data` | SQLite database directory |
| `CLAUDE_IMAGE` | `claude-workspace:latest` | Default image for new instances |
| `CLAUDE_NETWORK` | `claude-manager-net` | Docker network for instances |
| `INSTANCE_LABEL` | `claude-manager.managed=true` | Label applied to managed containers |
| `HOST_CLAUDE_DIR` | `/host-claude` | Mount point for host ~/.claude (read-only) |
| `MAX_INSTANCES` | `10` | Safety limit on concurrent instances |

---

## Build Order for the Claude Instance

Follow this order. Do not skip ahead.

1. **Scaffold** — `package.json`, directory structure, `CLAUDE.md`
2. **Docker service layer** — `server/docker.js` with all functions, write unit tests with a mock Docker client
3. **SQLite layer** — `server/db.js`, schema, sync logic
4. **Fastify app** — `server/index.js`, register plugins, static serving
5. **REST routes** — `server/routes/instances.js`, test with curl
6. **WebSocket state events** — add to instances route, test with `wscat`
7. **React scaffold** — Vite setup, Tailwind, basic routing
8. **Dashboard + InstanceCard** — wire to REST API
9. **useInstances hook** — WebSocket integration, live updates
10. **NewInstanceModal** — create form, wire to POST /api/instances
11. **Terminal WebSocket route** — `server/routes/terminal.js`
12. **Terminal component** — xterm.js, wire to WS
13. **Dockerfile + docker-compose** — containerize, test full stack
14. **End-to-end test** — create instance, open terminal, run `claude --version`, stop instance

---

## Definition of Done for Phase 1

- [ ] Manager starts as a container with docker-compose up
- [ ] Dashboard loads and shows existing claude-workspace containers (if any)
- [ ] "New Instance" creates a container, it appears in the grid within 5 seconds
- [ ] Start/Stop buttons work and status updates in real-time (no page refresh)
- [ ] Terminal panel opens and provides a working shell inside the container
- [ ] Remove button stops and removes the container (with confirmation)
- [ ] Manager survives container restart — SQLite data persists in named volume
- [ ] No hardcoded image names — reads from environment

---

## Notes for the Building Instance

- The Docker socket is available at `/var/run/docker.sock` inside the container (mounted from host)
- Use `dockerode` not the `docker` CLI — no CLI tools in the manager image
- xterm.js version: use v5.x (latest stable), not v4
- For the WebSocket terminal, use `@fastify/websocket` not a raw `ws` server
- The React frontend is built with `npm run build` (Vite) and output goes to `dist/`. Fastify serves it with `@fastify/static` from `dist/`
- In development, Vite dev server runs on 5173, Fastify on 3001. Vite proxies `/api` and `/ws` to Fastify (configure in `vite.config.js`)
- SQLite sync on startup: call `listManagedContainers()`, for each container check if it exists in SQLite, insert if missing, remove SQLite rows for containers that no longer exist in Docker
- Container creation must be idempotent: if a container with the requested name already exists, return it instead of erroring

---

## Repository

Create as: `github.com/FrederikLeed/claude-manager-public`

Push after Phase 1 is working. Use GitHub Issues for Phase 2+ feature tracking.
