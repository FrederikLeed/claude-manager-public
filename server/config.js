export const config = Object.freeze({
  PORT: parseInt(process.env.PORT || '3002', 10),
  DEV_PORT: parseInt(process.env.DEV_PORT || '3002', 10),
  DATA_DIR: process.env.DATA_DIR || '/data',
  CLAUDE_IMAGE: process.env.CLAUDE_IMAGE || 'claude-workspace:latest',
  CLAUDE_NETWORK: process.env.CLAUDE_NETWORK || 'claude-manager-net',
  // Workspace image build context, bind-mounted into the manager so it can
  // rebuild claude-workspace via the Docker API to pick up the latest Claude Code.
  // Empty disables manager-side rebuilds (build the image with compose instead).
  WORKSPACE_SRC_DIR: process.env.WORKSPACE_SRC_DIR || '',
  // How often to check npm for a newer Claude Code and rebuild (hours, 0 = off)
  IMAGE_UPDATE_INTERVAL_HOURS: parseInt(process.env.IMAGE_UPDATE_INTERVAL_HOURS || '24', 10),
  // Trivy security scans of each instance's /workspace (hours, 0 = off)
  SECURITY_SCAN_INTERVAL_HOURS: parseInt(process.env.SECURITY_SCAN_INTERVAL_HOURS || '24', 10),
  TRIVY_IMAGE: process.env.TRIVY_IMAGE || 'aquasec/trivy:latest',
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
  // Network policy defaults
  DEFAULT_NETWORK_POLICY: process.env.DEFAULT_NETWORK_POLICY || 'unrestricted',
  // Host path to workspace/policies/ directory (for bind-mounting into workspace containers)
  POLICIES_HOST_DIR: process.env.POLICIES_HOST_DIR || '',
  // Docker volume name for policies (alternative to POLICIES_HOST_DIR for DinD setups)
  POLICIES_VOLUME: process.env.POLICIES_VOLUME || '',
  // Container-local path where policies are mounted in the manager container
  POLICIES_DIR: process.env.POLICIES_DIR || '/policies',
  // Network proxy (squid)
  PROXY_URL: process.env.PROXY_URL || 'http://cm-proxy:3128',
  PROXY_ACL_DIR: process.env.PROXY_ACL_DIR || '/proxy-acl',
  // LiteLLM proxy
  LITELLM_API_BASE: process.env.LITELLM_API_BASE || '',
  LITELLM_MASTER_KEY: process.env.LITELLM_MASTER_KEY || '',
  LITELLM_DEFAULT_BUDGET: parseFloat(process.env.LITELLM_DEFAULT_BUDGET || '20'),
});
