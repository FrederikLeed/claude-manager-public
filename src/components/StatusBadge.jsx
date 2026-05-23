import { DISPLAY_STATES } from '../../shared/constants.js';

const colorMap = {
  green: 'bg-green-500',
  gray: 'bg-gray-500',
  yellow: 'bg-yellow-500',
  red: 'bg-red-500',
  blue: 'bg-blue-500',
};

const bgMap = {
  green: 'bg-green-500/10 text-green-400',
  gray: 'bg-gray-500/10 text-gray-400',
  yellow: 'bg-yellow-500/10 text-yellow-400',
  red: 'bg-red-500/10 text-red-400',
  blue: 'bg-blue-500/10 text-blue-400',
};

export default function StatusBadge({ state }) {
  const display = DISPLAY_STATES[state] || { label: state, color: 'gray' };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${bgMap[display.color] || bgMap.gray}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${colorMap[display.color] || colorMap.gray} ${state === 'running' ? 'animate-pulse' : ''}`} />
      {display.label}
    </span>
  );
}
