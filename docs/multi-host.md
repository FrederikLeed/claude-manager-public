# Multi-host Claude Manager — design

*Written 2026-10-04. Driver: a second Tiny joins the fleet. The manager runs on one
host and must create and drive instances on several.*

## The fleet

| Host | Role | Notes |
|---|---|---|
| **tiny2** (new) | manager + instances | 32 GB RAM. The fleet's home once provisioned. |
| **host-b** | *nothing* — production | Runs elastiflow, monitoring, example-app, mail-*. Currently hosts the manager as a stopgap while the workstation is serviced; that ends when tiny2 is up. Registered with `accepts_instances = 0` if registered at all. |
| **workstation** | instances | Out for service. Rejoins as a managed host afterwards; has the RTX 3090. |

`accepts_instances` exists for exactly the host-b case: a host the manager may
know about without ever scheduling work onto it.

## Shape

One manager (the **control host**), N **managed hosts**. Every host runs the Docker
daemon, the `claude-workspace` image and — once restricted policies are needed — its
own `cm-proxy`. The manager keeps a host registry and picks a host per instance.

The control host is itself just a row in that registry (`kind: local`), so there is
one code path, not two.

### Transport: SSH, not TLS

dockerode speaks SSH natively (`docker-modem` 5.x bundles `ssh2`). Verified from a
workspace container against host-b: `protocol:'ssh', host, username, sshOptions.privateKey`
→ `docker.version()` returns 29.8.2 / API 1.56 and `listContainers()` works.

That means **no Docker TCP port on the LAN and no cert plumbing**. The private key is
read from the 1Password Claude vault at startup (`op://Claude/<item>/private key`) and
held in memory — no key material on disk, matching how instances already get secrets.

Note: pass the bare host (no `ssh://` prefix) or docker-modem logs a URL deprecation warning.

## Schema

New table:

```sql
CREATE TABLE hosts (
  id TEXT PRIMARY KEY,            -- 'local', 'host-b', 'tiny2'
  name TEXT NOT NULL,
  kind TEXT NOT NULL,             -- 'local' | 'ssh'
  address TEXT,                   -- host/IP for ssh
  ssh_user TEXT,
  ssh_key_ref TEXT,               -- op:// reference, never the key
  data_root TEXT,                 -- host path holding claude-home/, instance-memory/, shared/
  manager_url TEXT,               -- what instances ON THIS HOST call back to
  proxy_container TEXT DEFAULT 'cm-proxy',
  network TEXT DEFAULT 'claude-manager-net',
  enabled INTEGER DEFAULT 1,
  labels TEXT,                    -- JSON: {"gpu":false,"ram_gb":30}
  last_seen INTEGER, status TEXT, status_detail TEXT
);
```

`instances` gains `host_id TEXT NOT NULL DEFAULT 'local'` (migration backfills `'local'`).
`docker_id` is only unique per daemon, so every lookup that joins on it
(`db.js:181-184`, `docker.js:105,199,247,678,908-911`) becomes `(host_id, docker_id)`.

## The architecture (design panel, 2026-10-05)

Four architectures were designed independently under opposed biases (minimal-change,
host-agent, central-services, pull/edge), each judged by three lenses, then synthesized
and attacked by four skeptics reading the source. Scores were close — 17/16/16/16 — so
the result is a graft, not a winner.

**One manager on host-a, N dumb daemons reached over one swappable `http.Agent`, with
egress enforced by network topology instead of inside the container.**

### Transport: the socket, not the CLI

Not `docker-modem`'s `protocol:'ssh'` (a fresh SSH handshake and a `dial-stdio` exec per
HTTP request) and not a hand-rolled `ssh -N -L` supervisor. One pooled `ssh2.Client` per
host, channels opened with `openssh_forwardOutStreamLocal('/var/run/docker.sock')`
(`ssh2/lib/client.js:1533`), wrapped in a custom `http.Agent` handed to
`new Docker({protocol:'http', agent})` — `docker-modem` keeps `opts.agent` (`modem.js:112`)
and applies it to every request (`:183`). About 80 lines, modelled on ssh2's own
`SSHTTPAgent`. No `docker` CLI on the host, no `dial-stdio`, no shell, no inbound port,
ssh2's own channel flow control, and `hostVerifier` pinning in exactly one place.

`dockerFor(hostId)` stays the only entry point and still returns an ordinary dockerode
client, so that one seam is also the escape hatch: a host that must dial *out* (the
workstation) drops in a second Agent implementation behind the same function.

Two traps the verifiers caught by running the code: `timeout` on a remote client throws,
because `docker-modem` implements it as `socket.setTimeout` and an ssh2 Channel has no
such method — use `connectionTimeout`, which is a plain timer (`modem.js:289-294`).
And hijack (terminal PTY) works, because modem delivers it as `req.on('upgrade')` +
`sock.unshift(head)` (`:304-312`).

### Egress: enforce outside the container

A restricted instance joins only a per-host `Internal: true` network with `cm-proxy` as
the single dual-homed member, so the namespace has no route out at all. The in-container
iptables lock stays as defence in depth but becomes fail-closed-and-alive (deny-all, log
loudly, keep running — never `exit 1` into a crash loop), and `NET_ADMIN` goes away.

This is the C1/C2/C3 fix and MXC's "model 2" arriving by the same door — see
[`mxc-vs-cm.md`](mxc-vs-cm.md). Multi-host is what finally makes it cheaper to do than
to defer.

### State, per topic

| Topic | Decision |
|---|---|
| Claude auth | **One `claude login` per host.** Never copy `.credentials.json` — two hosts refreshing one OAuth token fight. `POST /api/hosts/:id/login-shell` opens a throwaway container with only the claude-home bind; the operator completes the device flow in the existing terminal. A metadata-only probe tracks expiry without reading the token. |
| `/shared` | Per host, named explicitly in the UI. Upload takes a `hostId` and streams via `putArchive` into a helper container. No NFS in v1 — a file-server outage would otherwise take out `ls /shared` in every instance on every host. |
| instance-memory | Bind stays per host; the **backup becomes a manager-side pull** (`getArchive` → the git repo), so the git corpus keeps meaning across hosts. |
| `/workspace` volume | **Pinned for life.** `host_id` immutable after create; migration exists only as an explicit admin-confirmed `POST /api/instances/:id/migrate`, source kept until confirmed. |
| LiteLLM | **One per instance host**, on that host's own bridge. Nothing LLM-shaped crosses the LAN; the manager drives each admin API through the tunnel. `litellm_url` null → non-claude-max backends refused at create with a typed 409. |
| Callbacks | Per-instance bearer token (`CM_EVENT_TOKEN`, sha256 stored), replacing the blanket auth-exempt regexes, bound to the path id. |
| Image distribution | Build per host from the manager's context; no registry at this size. Per-host version tracking. |
| Background loops | One scheduler, N queues: `forEachHost(fn, {concurrency, timeoutMs})` with a per-host circuit breaker, per-host mutex and `${hostId}:${key}` problem keys. |

## Work, in order of what unblocks what

### Phase 1 — registry and transport (nothing user-visible)

- `server/hosts.js`: `dockerFor(hostId)` returning a cached dockerode client; `local`
  → `{socketPath}`, `ssh` → `{protocol:'ssh', ...}` with the key from the vault.
- Replace all 8 `new Docker({socketPath})` (`docker.js:49`, `proxy.js:25`, `health.js:23`,
  `proxy-log.js:16`, `idle-stop.js:25`, `security-scan.js:15`, `connectivity-check.js:24`,
  `workspace-image.js:15`) with `dockerFor(...)`.
- `hosts` + `instances.host_id` migrations.
- **Fix `syncWithDocker` first** (`db.js:220-246`): reconcile per host, and never delete
  rows belonging to a host that errored or wasn't polled. As written it would GC every
  instance on a host that is merely unreachable.
- Per-host Docker event streams with independent reconnect (`routes/instances.js:466-528`).

### Phase 2 — create and drive instances anywhere

- `createInstance(hostId, ...)`: paths come from `hosts.data_root`, not the global
  `INSTANCE_*` env (`config.js:27`). The env vars stay as the default for `local`.
- **Retire mount-template learning for remote hosts** (`docker.js:83-159`). Replaying
  another container's `m.Source` is host-specific by construction; a remote host gets
  explicit binds derived from `data_root`.
- Directory pre-creation (`docker.js:371-378` does `mkdirSync`/`chownSync` through the
  manager's own mount) can't reach a remote filesystem. Do it by running a throwaway
  `alpine` on the target host with `data_root` bound — a "host bootstrap" helper that
  also seeds `claude-home` and sets ownership to 1001:1001.
- `CM_MANAGER_URL` (`docker.js:19`, hardcoded `http://claude-manager:3002`) comes from
  `hosts.manager_url`. For a remote host that is a LAN URL, which means the callback
  leaves the Docker network.
- **Therefore: give the event endpoint a per-instance token.** `POST /api/instances/:id/event`
  is auth-exempt (`auth.js:11`) because it was only reachable from the bridge. Add an
  `event_token` column, inject it as `CM_EVENT_TOKEN`, have `cm-notify` send it, and
  verify. Same for `request-access`/`access` used by `cm-access`.
- `ensureNetwork` / `ensureImage` run per host.

### Phase 3 — per-host proxy (needed only for restricted policies)

All five current instances are `unrestricted`, so this can follow Phase 2 rather than block it.

- Each managed host runs its own `cm-proxy`. ACLs can no longer be a `writeFileSync` into
  a shared volume (`proxy.js:115-116`): write them over the Docker API instead
  (`putArchive` into the proxy container, or `exec sh -c 'cat >'`), keeping the existing
  inotify reload (`watch-acls.sh:18-21`).
- Key ACLs and denial attribution by `(host_id, ip)` — `proxy.js:32-45` and
  `proxy-log.js:29-44` assume one IP space.
- `squid.conf:36`'s blanket `docker_internal 172.16.0.0/12` is per-host; each host's
  proxy gets its own subnet.
- `health.js:47-73` compares ACL IP vs container IP — per host.
- Instances reach their host's proxy by bridge DNS (`cm-proxy`) as today, so
  `HTTP_PROXY` stays unchanged. Only the manager's side becomes host-aware.

### Phase 4 — images, scans, the rest

- Images: `docker.buildImage({context, src})` uploads the context to whichever daemon it
  is called on, so **no registry is needed** — build on each host from the manager's local
  `WORKSPACE_SRC_DIR`. Track `workspace_claude_version` per host (`meta` is global today).
- `security-scan.js` must run Trivy on the daemon owning the instance's volume, and its
  `.th-exclude.txt` bind (`219-223`) needs a path on that host.
- `connectivity-check.js` creates its probe container on the instance's host.
- `idle-stop`, `grants`, `discoverContainers`/`adoptContainer` iterate hosts.
- `routes/shared.js` writes to the manager's own `/shared`; a remote instance won't see
  it. Either per-host shares or drop the mount for remote instances.

### Phase 5 — UI

Host selector on create, host badge per instance card/row, host filter, per-host system
panel (`routes/system.js:8-21` returns one `docker.info()` today), and a hosts admin page.

## Deliberately not doing

- **Swarm / Kubernetes.** The fleet is a handful of Tinys; an orchestrator buys
  scheduling we don't need and costs the "it's just containers" simplicity.
- **Overlay networking between hosts.** Each host's instances stay on their own bridge.
  Nothing needs to talk across hosts except the manager, which uses SSH.
- **A shared `claude-home`.** Each host gets its own copy of the Claude credentials.
  Note the risk: concurrent OAuth refresh from two hosts can race. If it bites,
  per-host logins are the fix.
</content>

---

## What the skeptics broke (2026-10-05)

Four adversarial readers produced 40 breakages, 8 fatal. The two that were live bugs in
the shipped phase-1 code are fixed in `e4b3b37` (silent host reassignment on every
`upsertInstance` that omits `hostId`; reaping on a successful-but-empty poll). The rest
that change the plan:

- **The vault is the hole.** `OP_SERVICE_ACCOUNT_TOKEN` is injected into every instance
  (`docker.js:24-26`), and host SSH keys live in the same `Claude` vault — so **any
  instance can read any host's private key** and reach a daemon that is root-equivalent.
  Phases 2-4 are "building authentication on top of an authentication bypass" until a
  separate `Claude-Fleet` vault exists, with a service-account token held only by the
  manager and never injected. The manager should refuse any `ssh_key_ref` resolving to
  the instance-readable vault.
- **`ADMIN_RESET_TOKEN` travels in a query string** and is logged by `index.js:52-61` —
  which Alloy now ships to Loki on host-b. Move it out of the URL before the manager
  runs on a host with log shipping.
- **The `dockerSocket` toggle on the manager's own host** hands an instance the fleet
  daemon. `placement.js#admit()` must refuse it there.
- **Host-key pinning needs its un-pin shipped with it**, or the documented recovery
  procedure (regenerating host keys) locks the manager out with no HTTP route to clear it.
- **`local` and a registered `host-a` can be the same engine**, silently double-counting
  it. Store `docker.info().ID` with a UNIQUE constraint.
- **The health report has no consumer** — `GET /api/system/health` is referenced nowhere
  in `src/`. Per-host rot is invisible until something breaks. Expose it as `/metrics` and
  let the existing Prometheus scrape it.

## Step zero, which the plan was missing

The completeness critic's first finding: the manager still runs on the workstation, so
`local` does not mean host-a yet, and every phase assumes it does. Before phase 1:
drain the five live instances (push in-progress work, export memory) **while the
workstation manager still works**, since the workstation has no SSH server and once the
manager moves there is no path back to it. The agent performing the cutover is itself one
of those instances.
