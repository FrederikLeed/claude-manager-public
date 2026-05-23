# Claude Manager -- Roadmap

> **Status as of 2026-05-23** — Phase 1 (MVP), much of Phase 2
> (observability), and the network-policy work originally planned as
> Phase 3.5 are all shipped. Implementation differs slightly from what's
> described below — the design notes are kept for context, but see
> [architecture.md](architecture.md) and [brief.md](../brief.md) for
> what actually ships.

## Shipped (May 2026)

- **Per-container network policy enforcement** — squid forward proxy
  (`cm-proxy`) with per-container ACL files, plus an in-container
  iptables lock for defence in depth. Four shipped policies:
  `claude-only`, `claude-github`, `claude-full-dev`, `unrestricted`.
- **Access request flow** — agents call `cm-access --request` from
  inside the container; admins approve / deny in the dashboard.
  Policy upgrades recreate the container (volumes preserved); host
  additions update the ACL in place without restart.
- **Capability grants** — time-bound (default 24 h) grants for
  `docker_socket` and `network_unrestricted`. Expired grants
  auto-stop the container.
- **Per-instance LLM backend selector** — `claude-max` / `local-llm`
  (Qwen3 30B-A3B via Ollama) / `foundry` / `foundry-latest` (Azure AI
  Foundry). Non-Claude backends speak Claude's API via LiteLLM with
  per-instance virtual keys.
- **TOFU device authentication** — first device auto-admin, subsequent
  devices need admin approval. `ADMIN_RESET_TOKEN` for lockout
  recovery.
- **Auto-backup** — manager DB snapshotted to `/data/backups/` on every
  startup, last 3 kept.

What's documented below is largely historical or aspirational —
treat with that lens.

---

## Phase 2 -- Observability (Partially Complete)

**Goal**: Know what each instance is doing without opening a terminal.

### Completed

- [x] **Activity log** -- All lifecycle events (create, start, stop, remove,
  adopt) are recorded in the `activity_log` SQLite table with timestamps,
  instance IDs, and details. Exposed via `GET /api/system/activity` and
  rendered in the `ActivityLog` component on the dashboard.

- [x] **File upload to /shared** -- `POST /api/shared/upload` accepts
  multipart file uploads (50MB limit) and writes them to the `/shared`
  directory, which is bind-mounted into all managed containers. Filename
  sanitization strips path traversal characters.

- [x] **Shared terminal sessions via tmux** -- Terminal connections use
  `tmux -L cm new-session -A -s main` with a dedicated socket namespace.
  Multiple browser tabs (or users) attach to the same session. On WebSocket
  disconnect, the session is detached (not killed), preserving work in
  progress.

### Remaining

- [ ] **Live resource metrics (CPU/memory sparklines)**

  Use the Docker stats stream API to push per-instance CPU percentage and
  memory usage to the frontend.

  Implementation:
  - `dockerode` `container.stats({ stream: true })` returns a continuous
    JSON stream with CPU and memory counters.
  - Parse CPU delta / system delta for percentage. Parse `memory_stats.usage`
    for MB.
  - Push via WebSocket to update `InstanceCard` sparklines every 3 seconds.
  - Store last 20 data points per instance in server memory (not SQLite --
    no need to persist ephemeral metrics).
  - Frontend: Render as a small inline sparkline chart on each instance card.

- [ ] **Claude Code activity detection**

  Detect whether Claude Code is actively running a session inside a container,
  how long the session has been active, and token usage.

  Implementation:
  - Mount the host's `~/.claude` directory into the manager container
    (read-only): `${HOME}/.claude:/host-claude:ro`
  - Watch the SQLite databases under `/host-claude/projects/*/` for changes.
  - Map `~/.claude` project paths to container workspace volume mount paths
    to correlate sessions with managed instances.
  - Emit WebSocket events when session state changes (started, completed).
  - Display session duration and token count on the instance card.

  Reference: The ksred dashboard project demonstrated this approach with
  the same `~/.claude` SQLite schema.

- [ ] **Container log streaming**

  Expose Docker container logs via WebSocket for real-time viewing without
  opening a terminal session.

  API:
  ```
  GET /api/instances/:id/logs?tail=100&follow=true  (REST, non-streaming)
  WS  /api/instances/:id/logs                        (WebSocket, streaming)
  ```

  Implementation:
  - `container.logs({ follow: true, stdout: true, stderr: true, tail: 100 })`
  - Pipe log stream to WebSocket connection.
  - Add a "Logs" tab in the instance detail panel alongside "Terminal".
  - Color stdout and stderr differently in the UI.

- [ ] **Instance status enrichment**

  Detect whether Claude Code is actually running inside the container, not
  just whether the container itself is running.

  Implementation:
  - `execInContainer(id, ['pgrep', '-f', 'claude'])` -- returns exit code 0
    if a Claude process is found.
  - Run on the existing polling/event cycle.
  - Display as a sub-status on the instance card:
    ```
    Container: Running | Claude: Active
    Container: Running | Claude: Idle
    Container: Running | Claude: Not started
    ```

---

## Phase 3 -- Lifecycle Management

**Goal**: Manage instances with the same care as real workspaces.

### 3.1 Instance Templates / Profiles

Inspired by ClaudeBox's profile system. Pre-defined configurations that
pre-fill the "New Instance" modal.

SQLite schema addition:

```sql
CREATE TABLE IF NOT EXISTS templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  image       TEXT NOT NULL,
  env_vars    TEXT,               -- JSON object of environment variables
  volume_config TEXT,             -- JSON array of additional volume mounts
  description TEXT
);
```

Default templates:

| Template        | Image                    | Description                              |
|-----------------|--------------------------|------------------------------------------|
| Basic           | claude-workspace:latest  | Single workspace volume, standard config |
| With Git        | claude-workspace:latest  | Adds git config volume mount             |
| Isolated        | claude-workspace:latest  | No network access except Anthropic API   |

UI changes:
- "New Instance" modal gets a template dropdown at the top.
- Selecting a template pre-fills image, environment variables, and
  volume configuration.
- User can modify any pre-filled value before creating.
- "Save as Template" button to capture the current form as a new template.

### 3.2 Workspace File Browser

Browse files inside a container's `/workspace` without opening a terminal.

Implementation:
- `execInContainer(id, ['ls', '-la', '/workspace/path'])` for directory
  listings.
- `execInContainer(id, ['cat', '/workspace/path/file'])` for file content
  (read-only, with size limits).
- Simple tree view component in the UI.
- File content displayed in a read-only code viewer with syntax highlighting.
- No editing -- editing should happen inside the terminal or via Claude Code.

### 3.3 Scheduled Operations

Simple cron-style scheduler for automated instance lifecycle management.

Features:
- **Auto-stop idle instances**: Stop containers where Claude Code has not been
  active (per Phase 2.4 detection) for N hours. Configurable per-instance or
  globally.
- **Auto-snapshot**: Commit the container to a Docker image before stopping,
  creating a restorable checkpoint. Tag as
  `cm-snapshot-{slug}-{timestamp}`.
- **Scheduled start**: Start instances at a specific time (e.g., workday
  start).

Storage: Schedule definitions in SQLite. Evaluation loop runs every 60
seconds on the server.

### 3.4 Instance Notes and Tagging

The SQLite schema already supports `notes` (TEXT) and `tags` (JSON array).
This phase adds the UI to make them useful.

Features:
- Click instance name on card to edit inline. Save on blur or Enter.
- Notes displayed in instance detail panel. Editable textarea.
- Tags displayed as colored badges on instance cards.
- Dashboard filter bar: filter instances by tag. Combine with text search
  on name and notes.
- Tag management: auto-complete from existing tags when adding.

---

## Phase 3.5 -- Instance Network Policy (SHIPPED — see "Shipped" above)

> The notes below describe the original NemoClaw-inspired design.
> Implementation differs in two important ways: enforcement is
> done with a squid forward proxy (domain-level filtering, no IP
> games) plus an in-container iptables lock, rather than only
> iptables; and policies are YAML files in `workspace/policies/`
> rather than a `policy_yaml` column. The rest of the design notes
> (deny-by-default, presets, access request flow, drift considerations)
> all translated through. See
> [architecture.md → Network policy enforcement](architecture.md#3-network-policy-enforcement)
> for what actually ships.

**Original goal**: Each Claude instance runs with declarative, per-instance egress
policy. Deny by default. No silent data exfiltration. Policy is a YAML file
-- reviewable, versioned, auditable.

### Background -- What NemoClaw Got Right

NVIDIA NemoClaw (Apache 2.0) is a reference stack for running AI agents
securely inside their OpenShell runtime. It solves the same fundamental
problem: an autonomous AI agent running in a container with unrestricted
outbound network access is a risk, even on a private server.

Key design principles adapted for plain Docker (no k3s/OpenShell required):

- **Deny-by-default egress** -- Container starts with no outbound access.
  Only explicitly allowed endpoints work.
- **Policy as YAML** -- Human-readable, diff-able, can be reviewed in a PR.
- **Per-binary allowlisting** -- Not just "allow api.anthropic.com" but
  "allow `node` to reach api.anthropic.com". Other binaries (e.g., a
  compromised shell script) cannot use the same path.
- **Static vs dynamic policy** -- Static policy is baked in at container
  creation. Dynamic patches can be applied to a running container but reset
  on restart.
- **Operator approval flow** -- Unknown egress attempts are logged and
  surfaced to the operator in the web UI rather than silently dropped.

### NemoClaw Lessons Learned (Pitfalls to Avoid)

1. **Binary chain mismatches** (NemoClaw issue #396): If `openclaw` is a
   Node launcher script (`#!/usr/bin/env node`), you must allowlist
   `/usr/bin/node` too, not just the top-level binary. Policy checks happen
   at the syscall level, where the actual binary is `node`, not the script.

2. **Read-only config files** (NemoClaw issue #719): If the policy marks a
   config directory read-only but the agent needs to write to it (e.g.,
   `~/.claude` for session state), the agent breaks silently with no clear
   error. Never mark directories the agent writes to as read-only in
   filesystem policy.

3. **DNS must always be allowed**: Port 53 (UDP + TCP) must be explicitly
   permitted. Missing this causes failures that look completely unrelated
   to network policy (e.g., npm install timeouts, API connection failures).

4. **Dynamic policy resets on restart**: Any iptables rules applied to a
   running container are lost when the container restarts. This must be
   clearly documented in the UI.

### Policy YAML Format

Each instance gets a `policy.yaml` stored in the `policy_yaml` SQLite column
(or as a file in the instance volume).

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
      description: "DNS resolution (required)"
      endpoints:
        - host: "0.0.0.0/0"
          port: 53
      binaries: ["*"]
      rules:
        - protocols: [udp, tcp]

filesystem:
  workspace: /workspace            # read-write (agent workspace)
  claude_config: /root/.claude     # read-write (Claude Code state, must be writable)
  tmp: /tmp                        # read-write
  # everything else: read-only or inaccessible
```

### Policy Presets

Stored as YAML files in `server/policies/presets/`:

| Preset               | Allows                                          |
|----------------------|-------------------------------------------------|
| `claude-only`        | Anthropic API + DNS only. Maximum isolation.     |
| `claude-github`      | + GitHub (git clone, push, pull)                 |
| `claude-full-dev`    | + npm, PyPI, common package registries           |
| `claude-open`        | Unrestricted egress. For trusted use cases.      |

The "New Instance" modal includes a preset dropdown. Users can select a
preset as a baseline and optionally extend it with custom rules.

### Implementation Approach (Plain Docker, No k3s)

Uses Docker's native network isolation + iptables. No extra runtime required.

At container creation (`docker.js`):

1. Connect container to an isolated bridge network (no default internet
   access).
2. Parse the instance's `policy.yaml` egress rules.
3. `docker exec` into the container and apply iptables rules:
   ```
   iptables -A OUTPUT -d api.anthropic.com -p tcp --dport 443 -j ACCEPT
   iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
   iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
   iptables -A OUTPUT -j DROP
   ```
4. Store a SHA-256 hash of the applied rules in SQLite for drift detection.

Key implementation notes:
- Instance containers start with `NET_ADMIN` capability so they can set
  their own iptables rules (avoids the manager needing elevated privileges).
- Allowlisting by resolved IP is fragile (CDNs rotate IPs). Use
  hostname-based rules via iptables + `/etc/hosts` injection or an
  in-container DNS proxy.
- The manager container itself does NOT need `NET_ADMIN`.

### Policy Drift Detection

On the existing polling loop, exec `iptables -L OUTPUT` inside each instance
and compare the output hash against the stored `policy_hash` in SQLite.

If drift is detected (rules were modified inside the container by the agent
or an operator), set `policy_drift = 1` in SQLite and surface a warning in
the UI.

### UI Additions

- **InstanceCard**: Policy badge showing the active preset name
  (`claude-only`, `claude-github`, etc.) or a drift warning indicator.
- **Instance detail panel**: "Network Policy" tab displaying the active YAML
  with a formatted list of allowed endpoints.
- **Edit Policy**: Load a preset or write custom YAML. Apply to a running
  instance (dynamic, resets on restart) or to next restart (static).
- **Blocked Connections log**: Parse container stderr for iptables DROP log
  entries. Display as a time-ordered feed showing destination host, port,
  and binary that attempted the connection.

### SQLite Schema Additions

```sql
ALTER TABLE instances ADD COLUMN policy_preset TEXT DEFAULT 'claude-github';
ALTER TABLE instances ADD COLUMN policy_yaml TEXT;        -- Full YAML if customized
ALTER TABLE instances ADD COLUMN policy_hash TEXT;        -- SHA-256 of applied iptables rules
ALTER TABLE instances ADD COLUMN policy_drift INTEGER DEFAULT 0;  -- 1 = drift detected

CREATE TABLE IF NOT EXISTS policy_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id   TEXT NOT NULL,
  event_type    TEXT NOT NULL,     -- blocked, drift, applied, approved
  detail        TEXT,              -- JSON: { host, port, binary, timestamp }
  created_at    INTEGER NOT NULL
);
```

### What We Explicitly Do NOT Do (Unlike NemoClaw)

- **No OpenShell/k3s** -- Plain Docker is sufficient for this use case.
- **No Landlock LSM enforcement** -- Too complex for this phase; revisit
  if needed.
- **No inference routing proxy** -- Claude Code manages its own API calls.
  We only firewall the egress.
- **No operator approval TUI** -- Blocked connections are logged and surfaced
  in the web UI instead.

---

## Phase 4 -- Multi-Agent Orchestration

**Goal**: Use the manager to coordinate work across multiple Claude Code
instances.

### 4.1 Send Message to Instance

API endpoint that `docker exec`s into a container and sends a string to
Claude Code's stdin.

```
POST /api/instances/:id/message
Body: { "message": "Please continue working on the auth feature" }
```

Implementation:
- `execInContainer(id, ['bash', '-c', 'echo "$MSG" | claude'])` or use
  the Claude Code CLI's message input mechanism.
- Return the exec output (Claude's response or acknowledgment).
- Rate-limit to prevent accidental message flooding.

Inspired by the `send-claude-message.sh` pattern from the Tmux-Orchestrator
approach used in multi-agent setups.

### 4.2 Task Assignment Board

Kanban-style board for tracking what each instance is working on.

Columns:
- **Idle** -- Instance is running but has no assigned task.
- **Working** -- Instance is actively processing a task.
- **Review** -- Task is complete, awaiting operator review.
- **Done** -- Task reviewed and accepted.

Implementation:
- New SQLite table or columns for task state per instance.
- Drag-and-drop between columns in the UI.
- Task context (description, acceptance criteria) stored per instance.
- Auto-transition from Idle to Working when Claude activity is detected
  (Phase 2.4).
- Auto-transition from Working to Review when Claude activity stops after
  a task was assigned.

### 4.3 Shared Context Injection

Mount a shared read-only volume into all instances containing a
`SHARED_CONTEXT.md` file that provides cross-project instructions.

Implementation:
- Bind-mount a directory (e.g., `/shared/context`) as read-only into all
  managed containers at a well-known path (e.g., `/context`).
- The manager UI includes an editor for `SHARED_CONTEXT.md`.
- Changes are immediately visible to all running instances (bind mount,
  no restart required).
- Use cases: shared coding standards, API conventions, project-wide
  instructions that apply to all instances.

---

## Attribution / Inspiration

The following open-source projects informed the design of Claude Manager.
No code was copied; patterns and approaches were studied and reimplemented
independently.

| Project           | Author / Org     | License    | What Was Referenced                                |
|-------------------|------------------|------------|----------------------------------------------------|
| CloudCLI          | siteboon         | GPL-3.0    | xterm.js resize/attach pattern (studied only, no code copied due to GPL) |
| Codeman           | Ark0N            | MIT        | PTY-to-WebSocket bridge pattern, circuit breaker concept |
| ClaudeBox         | RchGrav          | MIT        | Container profile system, `init-firewall.sh` approach for instance isolation |
| claude-tmux       | jotjot           | AGPL-3.0   | Claude Code status detection via pgrep (reimplemented independently) |
| HolyClaude        | --               | --         | Single Claude Code container with browser -- baseline reference |
| ksred dashboard   | ksred            | Not yet OSS | `~/.claude` SQLite schema understanding, WebSocket real-time pattern |
| NemoClaw          | NVIDIA           | Apache-2.0 | Egress policy YAML structure, preset concept, per-binary allowlisting, static/dynamic policy model, lessons from issues #396 and #719 |

**License compliance notes**:
- GPL-3.0 (CloudCLI) and AGPL-3.0 (claude-tmux): Patterns studied only.
  No code copied. Features reimplemented from documentation and API
  references.
- Apache-2.0 (NemoClaw): Policy schema format and design philosophy adapted.
  No code copied; clean reimplementation using Docker-native tools.
- MIT (Codeman, ClaudeBox): Patterns and approaches referenced freely
  per MIT terms.
