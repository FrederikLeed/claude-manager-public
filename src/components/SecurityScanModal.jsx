import { useState, useEffect } from 'react';
import { fetchInstanceScan } from '../api.js';

const SEV_STYLE = {
  CRITICAL: 'text-red-300 bg-red-900/30 border-red-800',
  HIGH: 'text-amber-300 bg-amber-900/20 border-amber-800',
  MEDIUM: 'text-yellow-300 bg-yellow-900/10 border-yellow-900',
  LOW: 'text-gray-400 bg-gray-800 border-gray-700',
};

export default function SecurityScanModal({ instanceId, instanceName, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchInstanceScan(instanceId).then(setData).catch(() => setData({ findings: [] })).finally(() => setLoading(false));
  }, [instanceId]);

  const findings = data?.findings || [];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-gray-100">Security scan — {instanceName}</h2>
            {data?.scannedAt && <p className="text-xs text-gray-500">scanned {data.scannedAt} UTC (Trivy)</p>}
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200 p-1">&times;</button>
        </div>

        <div className="overflow-y-auto flex-1 p-4">
          {loading && <div className="text-sm text-gray-500 text-center py-8">Loading…</div>}
          {!loading && data?.error && (
            <div className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2 mb-3">Scan error: {data.error}</div>
          )}
          {!loading && (
            <div className="flex gap-2 mb-4 text-xs">
              {['critical', 'high', 'medium', 'secrets'].map((k) => (
                <span key={k} className={`px-2 py-1 rounded border ${
                  k === 'critical' ? SEV_STYLE.CRITICAL : k === 'high' ? SEV_STYLE.HIGH : k === 'secrets' ? SEV_STYLE.CRITICAL : SEV_STYLE.MEDIUM
                }`}>
                  {data?.[k] || 0} {k}
                </span>
              ))}
            </div>
          )}
          {!loading && findings.length === 0 && !data?.error && (
            <div className="text-sm text-green-400 text-center py-8">✓ No findings (CRITICAL/HIGH/MEDIUM)</div>
          )}
          {!loading && findings.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {findings.map((f, i) => (
                <div key={i} className={`px-3 py-2 rounded border text-xs ${SEV_STYLE[f.severity] || SEV_STYLE.LOW}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{f.severity}</span>
                    <span className="font-mono">{f.id}</span>
                    {f.type === 'secret' && <span className="px-1 rounded bg-red-950 text-red-300">secret</span>}
                  </div>
                  <div className="text-gray-300 mt-0.5">{f.title || '(no title)'}</div>
                  <div className="text-gray-500 mt-0.5 font-mono truncate">
                    {f.type === 'vuln'
                      ? `${f.pkg} ${f.installed}${f.fixed ? ` → fixed in ${f.fixed}` : ' (no fix)'}`
                      : `${f.target}${f.line ? `:${f.line}` : ''}`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
