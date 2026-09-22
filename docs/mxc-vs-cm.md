# Claude Manager vs. Microsoft Execution Containers (MXC) — what CM does today, and what MXC could replace later

*Prepared 2026-06-04, after Microsoft Build 2026 (June 2, 2026). MXC and most of the surrounding stack are **preview/alpha** — several specifics (network-egress rules, policy file format/SDK) are explicitly **not yet public**; those are flagged below rather than guessed at.*

---

## TL;DR

MXC is Microsoft's bet that **agent containment belongs in the OS, not in a bespoke app**. That overlaps hard with claude-manager's *plumbing* — the per-project sandbox, the squid+iptables network policy, the per-instance credential story we keep wanting and don't have. Where it does **not** overlap is claude-manager's *reason to exist for you*: a self-hosted, model-agnostic, human-in-the-loop **fleet console** for Claude Code that runs on your own Docker host and isn't tied to Windows or Entra.

So the realistic future isn't "MXC replaces CM." It's **"MXC replaces CM's containment layer; CM (or something like it) keeps the driving experience"** — and even that only if you accept a Windows/Entra-centric stack. If you don't, MXC is mostly a reference design (and a validation that CM bet on the right problems).

---

## What Microsoft actually announced (the relevant pieces)

- **Microsoft Execution Containers (MXC)** — a *policy-driven execution layer built into Windows itself*. Declare an agent's containment requirements **once**; the OS kernel enforces them at runtime via lightweight, hypervisor-protected enclaves (think Hyper-V / Windows Sandbox). Isolation semantics are **dynamically composable by intent/risk**; "session isolation" separates the agent from the user's desktop, clipboard, UI and input, and binds it to a strong user identity. **Preview now**, cross-platform across **Windows + WSL**. Benchmarks claim **94% faster boot than a Hyper-V VM** and **40% less memory than an equivalent Docker container** on a typical agent loop. [VentureBeat](https://venturebeat.com/security/microsoft-launches-mxc-an-os-level-sandbox-for-ai-agents-with-openai-and-nvidia-already-on-board), [Windows Dev Blog](https://blogs.windows.com/windowsdeveloper/2026/06/02/build-2026-furthering-windows-as-the-trusted-platform-for-development/)
- **Agent identity** — agents get *distinct, cryptographically-backed identities separate from the user*, managed through Active Directory / **Entra ID**. [Visual Studio Magazine](https://visualstudiomagazine.com/articles/2026/06/02/at-build-2026-microsoft-sets-up-windows-as-an-os-for-ai-agents.aspx)
- **Containment controls named**: filesystem access restrictions, **network-call limitations**, IPC controls, "prevent the agent from influencing user behavior." ⚠️ **Network egress specifics (allowlists/firewall rules) were *not* disclosed** — promised for Windows Developer Day with a preview SDK. [Windows News](https://windowsnews.ai/article/build-2026-windows-secure-runtime-for-ai-agents-with-containment-identity-mxc.422103)
- **Policy declaration**: via **Group Policy / MDM (Intune)** for enterprise, plus a prototype dashboard. File format/schema/API **TBD**.
- **Agent 365** — native MXC integration bringing **Defender, Entra, Intune, Purview** to agents ("start secure, stay secure"); preview in July. [MS Security Blog](https://www.microsoft.com/en-us/security/blog/2026/06/02/microsoft-build-2026-securing-code-agents-and-models-across-the-development-lifecycle/)
- **Windows 365 for Agents** (GA) — managed, Entra-joined, Intune-managed **Cloud PCs** for agents, consumption-priced.
- **Foundry Hosted Agents** (coming weeks) — per-session sandbox, **sub-100 ms cold start**, zero idle cost, persistent memory, framework-agnostic.
- **Ecosystem**: launch partners **OpenAI, NVIDIA, Manus, Nous Research, and the OpenClaw open-source project**. **NVIDIA OpenShell** integrates with MXC (sandboxing, policy management, **inference routing**, PII obfuscation). **OpenClaw on Windows** (alpha) runs inside MXC. [Live blog](https://news.microsoft.com/build-2026-live-blog)

> Note the ecosystem overlap with our earlier landscape review: **OpenShell** and **OpenClaw** — the two projects we benchmarked CM against — are now *both* MXC partners. Microsoft is positioning MXC as the substrate those agent runtimes sit on.

---

## Capability-by-capability: CM today → MXC equivalent → replaceable?

| CM capability today | How CM does it | MXC / Build-2026 equivalent | Replaceable? | When |
|---|---|---|---|---|
| **Per-project sandbox / cognitive isolation** | One Docker container per project, fresh memory | MXC OS-enforced per-session enclave; Foundry per-session sandbox | **Yes — and better** (kernel-enforced, faster boot, less memory) | Preview now |
| **Network policy enforcement** (claude-only / github / full-dev / unrestricted) | squid forward-proxy ACLs + in-container iptables lock | MXC "network-call limitations," OS-enforced | **Likely** — but ⚠️ egress/allowlist detail not yet public | TBD (Win Dev Day) |
| **Stale-allowlist breakage** (the `platform.claude.com` incident + our new connectivity guard) | squid 403 → manual allowlist edits + lint + smoke test | Declarative OS policy *should* reduce per-host ACL plumbing — but you still maintain an allowlist somewhere | Partially | TBD |
| **Per-instance identity / least-privilege creds** (CM's known gap — shared Claude Max login) | ❌ shared `~/.claude` bind across instances | **MXC's headline feature**: per-agent cryptographic identity via Entra/AD | **Yes — this is the big unlock** | Preview now (Entra-bound) |
| **Pluggable LLM backends** | LiteLLM virtual keys (Claude Max / Qwen3 / Azure Foundry) | NVIDIA OpenShell **inference routing** in MXC; Foundry models; Foundry Local | Partially (routing yes; *your* Claude-Max/Qwen mix is yours to wire) | Preview |
| **Human-in-the-loop driving** (web terminal, fleet dashboard, completion notifications) | xterm.js + Fastify + WS, per-instance bell/usage badges | ❌ **No equivalent** — MXC is containment plumbing; MS's UX is the GitHub Copilot app + a *policy* dashboard | **No** — stays in CM's court | — |
| **Per-instance memory isolation** | bind-mounted `/workspace/.claude` per slug | Foundry hosted agents: persistent per-session memory | Yes (if you move to Foundry) | Coming weeks |
| **Capability grants / access requests** (admin approves more egress) | in-container `cm-access` → admin approves → ACL update | Group Policy / Intune policy + Agent 365 governance | Partially (enterprise-shaped, not per-request-in-terminal) | Jul (Agent 365) |
| **Security scanning** (Trivy vuln/secret per instance) | throwaway Trivy container vs `/workspace` | **Defender** via Agent 365 | Yes (if Entra/Agent 365) | Jul |
| **Always-latest Claude Code + per-instance update** | manager rebuilds workspace image over Docker API | N/A (CM-specific to Claude Code) | No | — |
| **Self-hosted, model-agnostic, OS-agnostic** | Docker on your WSL2/Docker Desktop host | ❌ MXC is **Windows + WSL only**, Entra-centric | **No — this is the philosophical fork** | — |

---

## What MXC genuinely replaces (and improves)

1. **The containment layer.** squid + iptables + per-container ACL files + the entrypoint firewall lock is *exactly* the kind of bespoke plumbing MXC is built to delete. Kernel-enforced isolation that boots faster and uses less memory than the Docker container it replaces is a real upgrade — and it removes a whole class of "did the iptables lock actually apply / did NET_ADMIN get added" bugs.
2. **Per-instance identity — CM's single biggest gap.** We've twice written down that CM's shared `~/.claude` login is the wrong model and that per-instance OAuth / a GitHub App is the right unlock. MXC ships *cryptographically-backed per-agent identity via Entra* out of the box. If you live in Microsoft's identity world, MXC solves the exact problem CM has been deferring.
3. **The "stale allowlist" class** we just spent a session hardening against. A declarative, OS-enforced policy doesn't make endpoint allowlists disappear, but it does move them out of hand-rolled squid ACL files into a managed policy surface — fewer moving parts to drift.

## What MXC does *not* replace

1. **The driving experience.** MXC contains agents; it doesn't give you a **web terminal + fleet view** to sit down and *work in* a box, watch many instances, get completion chimes, and drive Claude Code by hand. Microsoft's human surface is the GitHub Copilot desktop app (a different product, Copilot-shaped) and a *policy* dashboard. CM's console has no MXC equivalent.
2. **Model-agnostic, self-hosted independence.** CM runs on your hardware, routes to Claude Max **and** local Qwen3 **and** Azure Foundry, and doesn't require Entra, Intune, or a Microsoft tenant. MXC is Windows/WSL-only and assumes Microsoft identity + management. Adopting MXC means adopting that gravity well.
3. **Claude-Code-specific lifecycle** (always-latest image rebuilds, per-instance "Update Claude," the Stop/Notification usage hook). That's CM knowing Claude Code intimately; MXC is deliberately agent-agnostic.

---

## The realistic end-states

**A. Stay on CM, borrow MXC's ideas (most likely near-term).** MXC's network-egress and policy SDK aren't public yet, it's preview, and it's Windows/Entra-centric. Treat MXC (and OpenShell, already an MXC partner) as a **reference architecture** for the two things CM should still do itself: per-instance identity and declarative policy. Nothing forces a migration in 2026.

**B. Hybrid — MXC as containment under CM as console (the interesting one).** CM stops shipping squid/iptables/ACL plumbing and instead **launches instances *into* MXC enclaves**, delegating isolation + per-agent Entra identity + network policy to the OS, while CM keeps the fleet UI, terminal, LLM routing, and Claude-Code lifecycle on top. This is the same "console over a standard substrate" shape Microsoft itself uses (OpenClaw/OpenShell *on* MXC). Gated on MXC exposing a programmatic API (Build only showed Group Policy/MDM + a prototype dashboard).

**C. Full handoff to the Microsoft stack (only if you go all-in on Entra).** Windows 365 for Agents + Foundry Hosted Agents + Agent 365 could subsume CM entirely *if* you accept Cloud PCs, consumption pricing, Microsoft identity, and Foundry-hosted models — and give up self-hosting and model independence. For your setup (Claude Max + local Qwen3 on a 3090, no tenant dependency) this is the **least likely** path.

---

## Risks / unknowns before betting on MXC

- ⚠️ **Network egress is the unknown that matters most to CM.** CM's whole policy value is *outbound* allowlisting (the `claude-only` "customer-data, reach nowhere else" guarantee). MXC names "network-call limitations" but published **no egress/allowlist mechanism**. Until Windows Developer Day's SDK, you can't confirm MXC matches `claude-only`'s guarantee.
- **No programmatic provisioning shown.** Group Policy / Intune / a prototype dashboard ≠ an API CM can call to spin an enclave per instance. Hybrid (B) depends on an API that doesn't visibly exist yet.
- **Windows + Entra lock-in.** Cross-platform "Windows + WSL" still means Windows. CM's portability and model-agnosticism are sacrificed.
- **Preview/alpha maturity.** MXC preview, OpenClaw-on-Windows alpha, Foundry hosted "coming weeks," Agent 365 "July." Don't re-architect on dates that haven't landed.

---

## Recommendation

1. **Don't migrate.** Nothing here is GA-on-your-terms today, and the egress story — CM's core differentiator — is undisclosed.
2. **Mine MXC + OpenShell for the two things CM keeps deferring:** per-instance identity and a single declarative policy surface (replacing the squid/iptables/ACL triad). These are CM's weakest seams and exactly what Microsoft just validated as the right problems.
3. **Watch for an MXC API** (Windows Developer Day). If MXC becomes programmatically launchable, prototype **hybrid (B)**: CM as the console, MXC as the containment substrate. That's the path that keeps everything you value about CM while deleting its most painful plumbing.
4. **Re-confirm the egress guarantee** before trusting MXC for `claude-only`-style customer-data isolation. Until then, CM's squid allowlist (now guarded by the connectivity lint + smoke test) remains the stronger, verifiable control.

---

### Sources
- [Microsoft Build 2026 — official blog](https://blogs.microsoft.com/blog/2026/06/02/microsoft-build-2026-be-yourself-at-work/)
- [Build 2026 live blog](https://news.microsoft.com/build-2026-live-blog)
- [Windows Developer Blog — Windows as the trusted platform for development](https://blogs.windows.com/windowsdeveloper/2026/06/02/build-2026-furthering-windows-as-the-trusted-platform-for-development/)
- [Microsoft Security Blog — securing code, agents, and models](https://www.microsoft.com/en-us/security/blog/2026/06/02/microsoft-build-2026-securing-code-agents-and-models-across-the-development-lifecycle/)
- [VentureBeat — Microsoft launches MXC, an OS-level sandbox for AI agents](https://venturebeat.com/security/microsoft-launches-mxc-an-os-level-sandbox-for-ai-agents-with-openai-and-nvidia-already-on-board)
- [Visual Studio Magazine — Windows as an OS for AI agents](https://visualstudiomagazine.com/articles/2026/06/02/at-build-2026-microsoft-sets-up-windows-as-an-os-for-ai-agents.aspx)
- [Windows News — Windows Secure Runtime for AI Agents (MXC)](https://windowsnews.ai/article/build-2026-windows-secure-runtime-for-ai-agents-with-containment-identity-mxc.422103)
- [CSO Online — Microsoft builds a security perimeter for AI agents](https://www.csoonline.com/article/4180467/microsoft-wants-to-put-ai-agents-on-a-short-leash.html)
