import { useAuth } from './hooks/useAuth.js';
import Dashboard from './components/Dashboard.jsx';
import WaitingApproval from './components/WaitingApproval.jsx';

export default function App() {
  const auth = useAuth();

  if (auth.status === 'loading') {
    return (
      <div className="min-h-dvh bg-gray-950 flex items-center justify-center">
        <div className="text-gray-500 text-sm">Connecting...</div>
      </div>
    );
  }

  if (auth.status === 'pending') {
    return <WaitingApproval auth={auth} />;
  }

  if (auth.status !== 'approved') {
    // Unknown state — re-registering, show spinner
    return (
      <div className="min-h-dvh bg-gray-950 flex items-center justify-center">
        <div className="text-gray-500 text-sm">Connecting...</div>
      </div>
    );
  }

  return <Dashboard isAdmin={auth.isAdmin} deviceId={auth.deviceId} />;
}
