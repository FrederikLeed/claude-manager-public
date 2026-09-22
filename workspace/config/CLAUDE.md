# Claude Manager workspace

You run inside a Claude Manager instance (a Docker container). These instructions come from the workspace image.

## Secrets: 1Password vault "Claude"

The 1Password vault **Claude** is the only place to exchange secrets with the user, in both directions. Use the `op` CLI; it authenticates with `OP_SERVICE_ACCOUNT_TOKEN`, a service account limited to that vault. If the variable is unset, 1Password isn't configured for this instance: say so, don't try to log in.

**Getting secrets from the user.** When you need a credential, look in the vault first. If it isn't there, ask the user to add it to the Claude vault, and give the item title and field names you'll read. Never ask for secrets in chat.
- List items: `op item list --vault Claude`
- See field labels and references (not values): `op item get "<item>" --vault Claude --format json | jq '.fields[] | {label, reference}'`

**No secrets on local disk.** The Claude vault is where secrets are stored; this container is not. No plaintext secrets in `.env` files, config files, scripts, notes or shell history. Local files hold `op://Claude/...` references only, and values are resolved when needed with `op run` / `op inject` / `op read`.
- If you find a plaintext secret in the workspace, move it to the vault: create an item, replace the value with an `op://` reference, update how it's used (`op run --env-file=...`), then delete the plaintext copy. Tell the user the item title.
- A generated file that has to contain the real value (for example a deploy step that writes `.env` on a remote host) is created at the moment it's used and never kept in the workspace or git.
- Ask before changing how a running service loads its secrets.

**Using secrets without printing them.**
- Single value: `export API_KEY="$(op read 'op://Claude/<item>/<field>')"`
- For a command: put `op://` references in an env file, then run `op run --env-file=.env.op -- <command>`. `op run` masks secrets in output.
- Config files: `op inject -i config.tpl -o config`. Keep the generated `config` out of git.

**Giving secrets to the user.** Every secret you create or receive goes into the vault, never into chat, files or memory. That includes generated passwords, API keys, tokens from a setup flow, and secrets the user pastes into chat.
- Create: `op item create --vault Claude --category "API Credential" --title "<project>: <what>" "credential=<value>" "notesPlain=<purpose, where it's used>"`
- For passwords, prefer `--category Login --generate-password`.
- Update: `op item edit "<item>" --vault Claude "<field>=<value>"`. To keep the value out of your shell history, read it from a variable, not a literal.
- Tell the user only the item title.
- If the user pasted a secret into chat, store it, then tell them it's now in this session's transcript and they should rotate it.

**Never:**
- echo, cat or log a secret value, or put one in a URL, commit, memory file or CLAUDE.md.
- bypass the gitleaks pre-commit hook.
- delete or overwrite an item you didn't create without asking.

`.env.op` files hold references only, so they're safe to commit.

## Network

Run `cm-access --status` when a request fails. If the policy is `unrestricted`, Claude Manager isn't blocking you: the error comes from the site or the network, so don't request access. On a restricted policy, request the host with `cm-access --request --hosts "<host>" --reason "<why>"`, then run `cm-access --poll`.
