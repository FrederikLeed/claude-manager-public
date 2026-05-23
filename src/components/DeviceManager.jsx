import { useState, useEffect, useCallback } from 'react';
import { fetchDevices, approveDeviceApi, revokeDeviceApi, renameDeviceApi } from '../api.js';

function timeAgo(isoString) {
  if (!isoString) return 'never';
  const seconds = Math.floor((Date.now() - new Date(isoString + 'Z').getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function shortUA(ua) {
  if (!ua) return '';
  if (ua.includes('iPhone')) return 'iPhone';
  if (ua.includes('iPad')) return 'iPad';
  if (ua.includes('Android')) return 'Android';
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Macintosh')) return 'Mac';
  if (ua.includes('Linux')) return 'Linux';
  return 'Unknown';
}

export default function DeviceManager({ currentDeviceId, onClose }) {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadDevices = useCallback(async () => {
    try {
      const data = await fetchDevices();
      setDevices(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadDevices(); }, [loadDevices]);

  const handleApprove = async (id) => {
    await approveDeviceApi(id);
    loadDevices();
  };

  const handleRevoke = async (id) => {
    if (!window.confirm('Revoke access for this device?')) return;
    await revokeDeviceApi(id);
    loadDevices();
  };

  const handleRename = async (id, currentName) => {
    const name = window.prompt('Device name:', currentName);
    if (!name || name === currentName) return;
    await renameDeviceApi(id, name);
    loadDevices();
  };

  const pending = devices.filter((d) => !d.approved);
  const approved = devices.filter((d) => d.approved);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between shrink-0">
          <h2 className="text-lg font-semibold text-gray-100">Devices</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200 p-1">&times;</button>
        </div>

        <div className="overflow-y-auto flex-1 p-4">
          {loading && <div className="text-sm text-gray-500 text-center py-8">Loading...</div>}

          {!loading && pending.length > 0 && (
            <div className="mb-6">
              <h3 className="text-xs font-medium text-yellow-400 uppercase tracking-wide mb-2">
                Pending approval ({pending.length})
              </h3>
              <div className="flex flex-col gap-2">
                {pending.map((device) => (
                  <div key={device.id} className="flex items-center gap-3 px-3 py-2.5 bg-yellow-900/10 border border-yellow-800/30 rounded-lg">
                    <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span
                        className="text-sm text-gray-200 cursor-pointer hover:underline truncate block"
                        onClick={() => handleRename(device.id, device.name)}
                      >
                        {device.name || 'Unnamed'}
                      </span>
                      <span className="text-xs text-gray-500">{shortUA(device.user_agent)}</span>
                    </div>
                    <button
                      onClick={() => handleApprove(device.id)}
                      className="px-2.5 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-medium rounded transition-colors"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleRevoke(device.id)}
                      className="px-2.5 py-1.5 text-gray-500 hover:text-red-400 hover:bg-red-900/30 text-xs font-medium rounded transition-colors"
                    >
                      Deny
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!loading && approved.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                Approved ({approved.length})
              </h3>
              <div className="flex flex-col gap-2">
                {approved.map((device) => {
                  const isSelf = device.id === currentDeviceId;
                  return (
                    <div key={device.id} className="flex items-center gap-3 px-3 py-2.5 bg-gray-800/50 border border-gray-800 rounded-lg">
                      <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className="text-sm text-gray-200 cursor-pointer hover:underline truncate"
                            onClick={() => handleRename(device.id, device.name)}
                          >
                            {device.name || 'Unnamed'}
                          </span>
                          {isSelf && (
                            <span className="text-[10px] text-blue-400 border border-blue-800 rounded px-1 py-0.5">You</span>
                          )}
                          {device.is_admin === 1 && (
                            <span className="text-[10px] text-yellow-400 border border-yellow-800 rounded px-1 py-0.5">Admin</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500">
                          {shortUA(device.user_agent)} &middot; Last seen {timeAgo(device.last_seen)}
                        </div>
                      </div>
                      {!isSelf && (
                        <button
                          onClick={() => handleRevoke(device.id)}
                          className="px-2.5 py-1.5 text-gray-500 hover:text-red-400 hover:bg-red-900/30 text-xs font-medium rounded transition-colors shrink-0"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!loading && devices.length === 0 && (
            <div className="text-sm text-gray-500 text-center py-8">No devices registered</div>
          )}
        </div>
      </div>
    </div>
  );
}
