export const CONTAINER_STATES = {
  RUNNING: 'running',
  STOPPED: 'exited',
  CREATED: 'created',
  REMOVING: 'removing',
  PAUSED: 'paused',
  RESTARTING: 'restarting',
  DEAD: 'dead',
};

export const DISPLAY_STATES = {
  running: { label: 'Running', color: 'green' },
  exited: { label: 'Stopped', color: 'gray' },
  created: { label: 'Created', color: 'yellow' },
  removing: { label: 'Removing', color: 'red' },
  paused: { label: 'Paused', color: 'blue' },
  restarting: { label: 'Restarting', color: 'yellow' },
  dead: { label: 'Dead', color: 'red' },
};

export const LABELS = {
  MANAGED: 'claude-manager.managed',
  ID: 'claude-manager.id',
  NAME: 'claude-manager.name',
};

export const CONTAINER_PREFIX = 'cm-instance-';
export const VOLUME_PREFIX = 'cm-workspace-';

export const WS_EVENTS = {
  INSTANCE_UPDATED: 'instance_updated',
  INSTANCE_CREATED: 'instance_created',
  INSTANCE_REMOVED: 'instance_removed',
};
