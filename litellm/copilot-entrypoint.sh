#!/bin/sh
# LiteLLM's github_copilot provider reads its GitHub OAuth token from a file
# ($GITHUB_COPILOT_TOKEN_DIR/access-token) and caches the short-lived Copilot
# token next to it. Write the file from the env at start, onto a tmpfs, so the
# token is never in the image or on the host's disk outside .env.
set -e
if [ -n "${GITHUB_COPILOT_OAUTH:-}" ] && [ -n "${GITHUB_COPILOT_TOKEN_DIR:-}" ]; then
  mkdir -p "$GITHUB_COPILOT_TOKEN_DIR"
  umask 077
  printf '%s' "$GITHUB_COPILOT_OAUTH" > "$GITHUB_COPILOT_TOKEN_DIR/access-token"
fi
unset GITHUB_COPILOT_OAUTH
exec docker/prod_entrypoint.sh "$@"
