# Global Instructions

These instructions apply to all Claude Code workspace instances.

## Project Brief

Every project must maintain a `brief.md` file in the repository root. This file serves as the project's self-documentation — a concise summary that other team members (human or AI) can read to quickly understand the project.

### When to update

Update `brief.md` after meaningful changes: new features, architectural decisions, status changes, or completed milestones. Do not update it for every minor commit — use judgement.

### Format

Use a frontmatter header followed by free-form content. There is no rigid template — describe the project in whatever way makes sense for its domain. The only required fields are:

```markdown
---
project: <project-name>
repo: <github-repo-url>
updated: <date>
status: active | paused | completed | archived
---
```

Below the frontmatter, cover at minimum:
- What the project is and its purpose
- Current state and recent progress
- Key technical decisions and why they were made
- Notable dependencies, gotchas, or constraints

Keep it concise. Aim for something a new team member could read in 2 minutes and understand the project.

### Workflow

After updating `brief.md`, commit and push it with your other changes. It is a normal part of the repo, not a separate step.

## Network Access

This workspace has network access managed via proxy. You can access ANY host on the internet — you just need to request approval first if it's not already in your allowlist. Always attempt requests normally first — use `curl`, `WebFetch`, `npm install`, etc. as you normally would. Blocked requests fail instantly with HTTP 403 (no timeouts), so there is no cost to trying.

### When a request fails with 403 or "connection refused"

This just means the host isn't in your allowlist yet. Do NOT give up or tell the user you can't access it. Instead, request access — it will be approved:

1. Request what you need:
   - For specific hosts: `cm-access --request --hosts "dr.dk,www.dr.dk" --reason "User asked to fetch dr.dk content"`
   - For a policy upgrade: `cm-access --request --policy claude-full-dev --reason "Need npm install for project dependencies"`
2. Wait for approval: `cm-access --poll` (polls every 5s, times out after 10 min).
3. Once approved, retry your original command.

Always provide a clear, specific reason — the admin sees it in the approval UI.

### Other useful commands

- `cm-access --status` — see your current policy and approved extras
- `cm-access --list` — see all available policies and their allowed hosts
- `cm-access --show <policy>` — details on a specific policy

## Completion notifications

- When you have finished the user's task and are waiting for the next prompt, emit a single ASCII BEL (`\a`) on its own line so the UI can notify the operator.
- Do not emit the bell during intermediate tool calls or partial progress updates.
