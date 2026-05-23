import { useEffect } from 'react';

export default function WaitingApproval({ auth }) {
  // Poll for approval every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      auth.checkStatus();
    }, 5000);
    return () => clearInterval(interval);
  }, [auth]);

  return (
    <div className="min-h-dvh bg-gray-950 flex items-center justify-center px-4">
      <div className="text-center max-w-sm">
        <div className="w-12 h-12 mx-auto mb-6 rounded-full bg-yellow-500/10 flex items-center justify-center">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#eab308" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        </div>
        <h1 className="text-xl font-bold text-gray-100 mb-2">Waiting for approval</h1>
        <p className="text-sm text-gray-400 mb-6">
          This device needs to be approved by an admin before you can access Claude Manager.
        </p>
        {auth.deviceName && (
          <p className="text-xs text-gray-500">
            Device: {auth.deviceName}
          </p>
        )}
        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-gray-600">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
          Checking every 5 seconds...
        </div>
      </div>
    </div>
  );
}
