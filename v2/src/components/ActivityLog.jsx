import { useState, useEffect } from 'react';
import { fetchActivityLog } from '../api.js';

const actionLabels = {
  created: 'Created',
  started: 'Started',
  stopped: 'Stopped',
  removed: 'Removed',
  adopted: 'Adopted',
};

const actionColors = {
  created: 'text-blue-400',
  started: 'text-green-400',
  stopped: 'text-yellow-400',
  removed: 'text-red-400',
  adopted: 'text-purple-400',
};

const actionIcons = {
  created: '+',
  started: '\u25B6',
  stopped: '\u25A0',
  removed: '\u00D7',
  adopted: '\u2190',
};

function timeAgo(isoString) {
  const seconds = Math.floor((Date.now() - new Date(isoString + 'Z').getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function ActivityLog({ refreshTrigger }) {
  const [entries, setEntries] = useState([]);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    fetchActivityLog()
      .then((data) => setEntries(data.slice(0, 20)))
      .catch(() => setEntries([]));
  }, [refreshTrigger]);

  return (
    <div className="mt-8 bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-800/50 transition-colors"
      >
        <div>
          <h2 className="text-sm font-medium text-gray-400">
            Activity Log
          </h2>
          <p className="text-xs text-gray-600 mt-0.5">
            Recent instance actions
          </p>
        </div>
        <span className={`text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`}>
          &#9660;
        </span>
      </button>
      {expanded && (
        <div className="border-t border-gray-800 divide-y divide-gray-800/50">
          {entries.length === 0 && (
            <div className="px-4 py-3 text-xs text-gray-600">No activity logged yet. Actions will appear here.</div>
          )}
          {entries.map((entry) => (
            <div key={entry.id} className="px-4 py-2 flex items-center gap-3 text-sm">
              <span className={`font-mono text-xs w-5 text-center ${actionColors[entry.action] || 'text-gray-400'}`}>
                {actionIcons[entry.action] || '?'}
              </span>
              <span className={`text-xs font-medium w-16 ${actionColors[entry.action] || 'text-gray-400'}`}>
                {actionLabels[entry.action] || entry.action}
              </span>
              <span className="text-gray-200 truncate flex-1">
                {entry.instance_name || entry.instance_id || ''}
              </span>
              {entry.details && (
                <span className="text-xs text-gray-600 truncate max-w-48 hidden md:inline">
                  {entry.details}
                </span>
              )}
              <span className="text-xs text-gray-600 whitespace-nowrap">
                {timeAgo(entry.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
