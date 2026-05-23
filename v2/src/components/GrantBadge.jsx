import { useState, useEffect } from 'react';

function getTimeRemaining(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return { expired: true, label: 'Expired', ms: 0 };
  const hours = ms / 3600000;
  if (hours >= 24) return { expired: false, label: `${Math.floor(hours / 24)}d ${Math.floor(hours % 24)}h`, ms };
  if (hours >= 1) return { expired: false, label: `${Math.floor(hours)}h`, ms };
  return { expired: false, label: `${Math.floor(ms / 60000)}m`, ms };
}

function getColor(ms) {
  if (ms <= 0) return 'text-red-400 border-red-800 bg-red-900/20';
  const hours = ms / 3600000;
  if (hours < 4) return 'text-red-400 border-red-800 bg-red-900/20';
  if (hours < 12) return 'text-yellow-400 border-yellow-800 bg-yellow-900/20';
  return 'text-green-400 border-green-800 bg-green-900/20';
}

export default function GrantBadge({ grant, onClick }) {
  const [, setTick] = useState(0);

  // Re-render every 60s to update countdown
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60000);
    return () => clearInterval(id);
  }, []);

  const { expired, label, ms } = getTimeRemaining(grant.expires_at);
  const color = getColor(ms);
  const capLabel = grant.capability_name === 'docker_socket' ? 'Docker'
    : grant.capability_name === 'network_unrestricted' ? 'Net'
    : grant.capability_name;

  return (
    <button
      onClick={onClick}
      className={`text-[10px] border rounded px-1 py-0.5 transition-colors ${color} hover:brightness-125`}
      title={`${grant.capability_name}: ${expired ? 'expired' : `expires in ${label}`}`}
    >
      {capLabel} {expired ? 'expired' : label}
    </button>
  );
}
