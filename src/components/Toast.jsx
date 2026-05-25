import { useState, useEffect, useCallback } from 'react';

const typeStyles = {
  success: 'bg-green-900/90 border-green-700 text-green-300',
  error: 'bg-red-900/90 border-red-700 text-red-300',
  info: 'bg-blue-900/90 border-blue-700 text-blue-300',
};

let _toastId = 0;
let _addToast = null;

/** Show a toast notification from anywhere */
export function showToast(message, type = 'info', duration = 4000) {
  _addToast?.({ id: ++_toastId, message, type, duration });
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState([]);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  _addToast = useCallback((toast) => {
    setToasts((prev) => [...prev, toast]);
    if (toast.duration > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      }, toast.duration);
    }
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-14 right-4 z-[70] flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          onClick={() => dismissToast(toast.id)}
          title="Click to dismiss"
          className={`px-4 py-3 rounded-lg text-sm shadow-lg border animate-slide-in cursor-pointer ${typeStyles[toast.type] || typeStyles.info}`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
