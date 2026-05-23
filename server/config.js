export const config = Object.freeze({
  PORT: parseInt(process.env.PORT || '3000', 10),
  DEV_PORT: parseInt(process.env.DEV_PORT || '3001', 10),
  DATA_DIR: process.env.DATA_DIR || '/data',
  CLAUDE_IMAGE: process.env.CLAUDE_IMAGE || 'claude-workspace:latest',
  CLAUDE_NETWORK: process.env.CLAUDE_NETWORK || 'claude-manager-net',
  INSTANCE_LABEL: process.env.INSTANCE_LABEL || 'claude-manager.managed=true',
  HOST_CLAUDE_DIR: process.env.HOST_CLAUDE_DIR || '/host-claude',
  MAX_INSTANCES: parseInt(process.env.MAX_INSTANCES || '20', 10),
  SHARED_DIR: process.env.SHARED_DIR || '/shared',
  // Host paths to bind-mount into new instances (these must be HOST paths, not manager container paths)
  INSTANCE_SHARED_DIR: process.env.INSTANCE_SHARED_DIR || '',
  INSTANCE_MEMORY_DIR: process.env.INSTANCE_MEMORY_DIR || '',
  INSTANCE_CLAUDE_DIR: process.env.INSTANCE_CLAUDE_DIR || '',
  // Base directory for per-instance Claude project memory (host path)
  // Each instance gets a subdirectory: <base>/<slug>/ mounted as /workspace/.claude
  INSTANCE_MEMORY_BASE_DIR: process.env.INSTANCE_MEMORY_BASE_DIR || '',
  NODE_ENV: process.env.NODE_ENV || 'development',
  // Emergency admin reset token — pass as query param ?reset_token=XXX on /api/auth/register
  // to force-register as admin even when devices already exist. Leave empty to disable.
  ADMIN_RESET_TOKEN: process.env.ADMIN_RESET_TOKEN || '',
});
