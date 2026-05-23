import {
  createGrant,
  getExpiredGrants,
  deactivateGrant,
  logActivity,
} from './db.js';
import { stopInstance, recreateInstance } from './docker.js';
import { DEFAULT_EXPIRY_MS, CAPABILITY_NAMES } from '../shared/constants.js';

/**
 * Create grants for high-risk capabilities on instance creation.
 */
export function createGrantsForInstance(instanceId, { dockerSocket, networkPolicy, expiryHours } = {}) {
  if (dockerSocket) {
    const ms = expiryHours ? expiryHours * 3600000 : DEFAULT_EXPIRY_MS.docker_socket;
    const expiresAt = new Date(Date.now() + ms).toISOString();
    createGrant({
      instanceId,
      capabilityName: CAPABILITY_NAMES.DOCKER_SOCKET,
      expiresAt,
      source: 'instance-creation',
    });
  }

  if (networkPolicy === 'unrestricted') {
    const ms = expiryHours ? expiryHours * 3600000 : DEFAULT_EXPIRY_MS.network_unrestricted;
    const expiresAt = new Date(Date.now() + ms).toISOString();
    createGrant({
      instanceId,
      capabilityName: CAPABILITY_NAMES.NETWORK_UNRESTRICTED,
      expiresAt,
      source: 'instance-creation',
    });
  }
}

/**
 * Check for expired grants and stop affected containers.
 * Called every 60s by the expiry timer.
 * Returns the broadcast function for WebSocket notifications.
 */
export async function checkExpiredGrants(broadcast, log) {
  try {
    const expired = getExpiredGrants();
    for (const grant of expired) {
      try {
        await stopInstance(grant.instance_id);
      } catch {
        // Container may already be stopped
      }
      deactivateGrant(grant.id);
      logActivity('grant_expired', grant.instance_id, null, `Capability "${grant.capability_name}" expired`);

      if (broadcast) {
        broadcast({
          type: 'grant_expired',
          instanceId: grant.instance_id,
          capability: grant.capability_name,
        });
      }

      if (log) {
        log.info({ instanceId: grant.instance_id, capability: grant.capability_name }, 'Grant expired, container stopped');
      }
    }
  } catch (err) {
    if (log) log.error({ err: err.message }, 'Error checking expired grants');
  }
}

/**
 * Recreate instance without a specific capability.
 * Preserves volume and project memory.
 */
export async function recreateWithoutCapability(instanceId, capabilityName) {
  const opts = {};
  if (capabilityName === CAPABILITY_NAMES.DOCKER_SOCKET) {
    opts.dockerSocket = false;
  } else if (capabilityName === CAPABILITY_NAMES.NETWORK_UNRESTRICTED) {
    opts.networkPolicy = 'claude-github';
  }
  return recreateInstance(instanceId, opts);
}
