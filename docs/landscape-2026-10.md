# Claude Manager vs. the field — October 2026

*Surveyed 2026-10-11/12. Status, stars and last-push dates were checked against each project's repo, docs or changelog on that date. Microsoft MXC has its own document, [mxc-vs-cm.md](mxc-vs-cm.md).*

## Bottom line

Nothing replaces CM for a single operator who wants all of these at once:
- several Docker hosts;
- per-instance egress policy with an approval flow;
- per-instance model routing with keys and budgets (Claude Max, local models, Anthropic API, Copilot);
- agents that can reach the LAN.

The nearest peer is **Coder** (coder.com, `coder/coder`, AGPL core). Its agent-security features need a Premium licence plus an AI Governance add-on. The closest replacement for GitHub-only work on the public internet is Anthropic's own stack: cloud sessions, routines and Remote Control.

Others do now clearly beat CM in five areas, listed below in order of how much they matter.

## 1. Containment — CM is behind

| What others do | Who | CM today |
|---|---|---|
| Enforce network policy **outside** the agent: host, outer namespace or VM | Docker Sandboxes (`sbx`), Anthropic `sandbox-runtime` (srt), Coder Agent Firewall (nsjail mode), MXC | iptables lock inside the container, which has `NET_ADMIN` and sudo (finding C1) |
| Deny RFC1918, link-local and metadata addresses by default, and check the address a hostname **resolves** to | `sbx`, srt | `10/8`, `172.16/12` and `192.168/16` accepted (C2); no IPv6 rules (C3) |
| The agent holds a **placeholder**; a proxy outside swaps in the real credential for listed hosts | `sbx` (can read 1Password references), srt `mask`, Claude Code cloud "network secrets", Codex, Cloudflare Sandboxes, [iron-proxy](https://github.com/paradigmxyz/iron-proxy) | Every instance gets the 1Password service-account token, which can read the whole vault |
| L7 rules (method and path) and an audit log that names the rule that matched | Coder Agent Firewall, `sbx policy log` | Host allowlist only; denials logged without a rule |
| Each agent has its own private Docker daemon, not the host's socket | `sbx` (microVM), gVisor/Kata as runtimes | Time-limited grant of the host Docker socket |

Sources: [Docker Sandboxes network policies](https://docs.docker.com/ai/sandboxes/network-policies) · [credentials](https://docs.docker.com/ai/sandboxes/security/credentials/) · [srt](https://github.com/anthropic-experimental/sandbox-runtime) · [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing) · [Coder Agent Firewall](https://coder.com/docs/ai-coder/agent-firewall) · [rules engine](https://coder.com/docs/ai-coder/agent-firewall/rules-engine) · [Cloudflare sandbox auth](https://blog.cloudflare.com/sandbox-auth/)

## 2. Review and triggers — everyone has them, CM doesn't

- **Changes panel.** A diff per task; comments on lines go back to the agent as its next message; a button to push or open a PR. Claude Code on the web, Superset, Vibe Kanban, Emdash, Sculptor, Paseo.
- **Scheduled and webhook prompts.** Claude Code [routines](https://code.claude.com/docs/en/routines) (schedule, `/fire` API with the payload marked untrusted, GitHub events), Codex [automations](https://developers.openai.com/codex/app/automations/), Superset Automations, OpenHands automations, Paperclip heartbeats. This fits CM's idle stop and resume: wake the instance, send the prompt, let it stop again.
- **PR watching.** When CI fails or a review comment arrives, the agent is woken to fix it. Claude Code auto-fix, Jules, Copilot "agent merge".

## 3. Operator attention

- **Supervisor agent.** One agent watches the others, answers routine prompts when confident and escalates the rest to the phone. Agent Deck's "Conductor" ([repo](https://github.com/asheshgoplani/agent-deck)). CM's needs-input hook events are already the signal it needs.
- **Answer from the notification.** Allow, Deny or reply in the notification itself, and one inbox for every instance. Paseo, Happy, Superset mobile. CM notifies; the operator then opens a terminal.
- **CLI, API or MCP for the manager itself,** so an agent can start a sibling instance, send it work and read the result. Paseo (`run/ls/attach/send --host`), Superset, Agent Deck. Also a queued follow-up like `claude -p --cloud <id>`.
- **Move a session to another account or backend** when a budget runs out (Agent Deck), and **pause at a hard budget** (Paperclip).

## 4. Observability

- **Claude Code OpenTelemetry export.** `claude_code.cost.usage`, `claude_code.token.usage` (cache read and creation split out), and `api_request` / `tool_decision` events, broken down by model, subagent and MCP server. `OTEL_RESOURCE_ATTRIBUTES=cm.instance=<id>` tags each instance. Setting it in managed settings stops an instance redirecting it. Mostly configuration for CM. [Monitoring usage](https://code.claude.com/docs/en/monitoring-usage)
- **Search across every instance's conversations, and a cost dashboard.** Agent Deck; Langfuse can ingest sessions through a Stop hook.

## 5. Supply chain

LiteLLM PyPI releases 1.82.7 and 1.82.8 shipped a credential stealer on 2026-03-24 ([NetSPI](https://www.netspi.com/blog/executive-blog/ai-ml-pentesting/litellm-supply-chain-compromise/)). The deployed router runs 1.106.0, so CM is unaffected. But `litellm/Dockerfile` builds from the unpinned `ghcr.io/berriai/litellm:main-latest`, so the next rebuild takes whatever is current. Pin by digest.

LLM gateways: nothing found that justifies leaving LiteLLM. Bifrost (Go) and Envoy AI Gateway 1.1 (Kubernetes-oriented) are the alternatives if it causes trouble.

## Only CM does

- Local models next to Max, Copilot and Anthropic API backends, each instance with its own LiteLLM key and budget.
- Agents that reach the LAN, on your own hardware, at no marginal cost.
- An approval flow for an agent's network-access requests.
- A persistent shared tmux shell, in the browser and on mobile.
- Instance images rebuilt automatically on each Claude Code release.
- Claude Code itself running on a Copilot subscription.

Vendors offer bring-your-own-compute only on Team/Enterprise or early-access plans: Claude Code self-hosted environments, Devin Outposts, Warp self-hosted workers. Cursor "My Machines" is the exception, with its plan eligibility unstated.

## Survey notes

### Self-hosted and open-source managers

| Tool | Status 2026-10-11 | Better than CM | Lacks vs CM |
|---|---|---|---|
| [Paseo](https://github.com/getpaseo/paseo) | Active, 20.5k★, AGPL | Native mobile/desktop clients with an E2E relay; agents start and talk to other agents; diff/PR panes; CLI and SDK | No network policy, no container fleet |
| [Agent Deck](https://github.com/asheshgoplani/agent-deck) | Active, 1.1k★ | Conductor supervisor; session fork and account move; cost dashboard; search across conversations; shared MCP pool | Single host; basic sandbox |
| [Superset](https://github.com/superset-sh/superset) | Active, 15k★ | Diff with line-to-agent comments; Automations; browser pane; remote hosts with wake | Desktop app, no containers or policy |
| [Happy](https://github.com/slopus/happy) | Active, 24k★, MIT | E2E mobile app; several people steer one session | Wrapper only |
| [CloudCLI](https://github.com/siteboon/claudecodeui) | Active, 14k★ | File editor, git stage/commit, finds sessions automatically | Single host, no policy or budgets |
| [OpenHands](https://github.com/OpenHands/OpenHands) | Active, 90.6k★, MIT core | Runs Claude Code/Codex via ACP; container per conversation; schedule/webhook automations | Heavier platform, no tmux workflow |
| [Coder](https://github.com/coder/coder) | Active, 17k★, AGPL + paid add-ons | Agent Firewall, AI Gateway, Tasks | Paid for the security parts; heavy to run |
| [Paperclip](https://github.com/paperclipai/paperclip) | Very active, 100k★ | Heartbeat/schedule wakeups; budgets that pause work | General agent org tool, not a fleet |
| [Emdash](https://github.com/generalaction/emdash) | Active, 6k★ | Remote worktrees over SSH; tickets from Linear/Jira/GitHub/GitLab | Desktop app |
| Nimbalyst (was Crystal), Claude Squad, Sculptor, Conductor | Active | Worktree per task, diff review | Desktop or TUI, single machine |
| Vibe Kanban | Company shut down Apr 2026; community-maintained | — | — |
| opcode, Terragon, catnip, Uzi | Dead or gone | — | — |

### Vendor-hosted agents

| Product | Better than CM | CM wins on |
|---|---|---|
| Claude Code on the web, routines, Remote Control, Projects | Network levels and network secrets; diff review and PR; auto-fix PRs; routines; `--teleport`; Remote Control server mode (`--spawn worktree --capacity N`) | Local and mixed backends, LAN, persistent shell; self-hosted runners are Team/Enterprise only |
| GitHub Copilot coding agent / Agent HQ | Tasks from issues, Slack, Teams; per-repo Agents tab; third-party agents; agent merge; OpenTelemetry | 59-minute session cap, one repo and PR per task |
| OpenAI Codex cloud | Reusable environments; registry allowlist with secret injection; RFC 5545 schedules; Linear and Slack triggers | No bring-your-own compute |
| Cursor cloud agents | "My Machines" workers; Projects coordinator; Bugbot | Local models, egress policy |
| Devin, Warp, Amp, Jules, Factory | Enterprise self-hosted workers (Devin Outposts, Warp); Slack/Jira triggers; meta-agents (Amp) | All cloud-first; no local models |

## Suggested order for CM

1. **Pin LiteLLM by digest.** Trivial; closes a real supply-chain risk.
2. **Move network enforcement to the host** (C1–C3). Instances on an `internal: true` Docker network whose only exit is squid; DOCKER-USER rules for IPv4 and IPv6; LAN denied by default except approved hosts; remove `NET_ADMIN` and passwordless sudo from instances.
3. **Keep secrets out of instances.** Proxy-injected placeholders, or at least a scoped vault per instance.
4. **Claude Code OpenTelemetry** into the existing Prometheus/Grafana, tagged per instance and compared with LiteLLM spend.
5. **Features, in this order:** Allow/Deny/reply from notifications; scheduled and webhook prompts; Changes panel; a CM CLI/MCP; then the supervisor agent.
