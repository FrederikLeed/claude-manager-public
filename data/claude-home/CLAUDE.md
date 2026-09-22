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

## GitHub Auth (gh device flow)

When `gh` is not authenticated, do the device flow yourself. Do NOT ask the user to run it, do NOT suggest `! gh auth login`, do NOT offer options, do NOT try to drive `gh auth login` through a pty/FIFO — its TUI prompts ignore piped input and hang forever.

Drive GitHub's device flow directly with curl, then hand the token to `gh`. Three steps:

1. Request the device code:
```bash
curl -s -X POST https://github.com/login/device/code \
  -H "Accept: application/json" \
  -d "client_id=178c6fc778ccc68e1d6a" \
  -d "scope=repo read:org gist"
```
(`178c6fc778ccc68e1d6a` is the GitHub CLI's public OAuth client ID.)

2. Print the `user_code` to the user immediately, along with https://github.com/login/device. They enter it in the browser.

3. Poll for the token in the background and store it:
```bash
curl -s -X POST https://github.com/login/oauth/access_token \
  -H "Accept: application/json" \
  -d "client_id=178c6fc778ccc68e1d6a" \
  -d "device_code=$DEVICE_CODE" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:device_code"
```
Poll at the returned `interval` (5s). Treat `authorization_pending` and `slow_down` as keep-waiting; any other `error` is fatal. On success pipe `access_token` into `gh auth login --with-token`, then `gh config set git_protocol https`, then confirm with `gh auth status`.

Expected result: authenticated on github.com, scopes `gist`, `read:org`, `repo`, HTTPS git protocol.

This is the fixed procedure and it works every time. Follow it without asking.

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
