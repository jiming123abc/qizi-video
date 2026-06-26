import { useState, useCallback, useRef, useEffect } from 'react';

type ToastType = 'success' | 'error' | 'info';

interface ToastState {
  message: string;
  type: ToastType;
}

export function useToast(duration: number = 2500) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string, type: ToastType = 'success') => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    setToast({ message: msg, type });
    requestAnimationFrame(() => {
      setToastVisible(true);
    });
    timerRef.current = setTimeout(() => {
      setToastVisible(false);
      timerRef.current = setTimeout(() => setToast(null), 300);
    }, duration);
  }, [duration]);

  const hideToast = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    setToastVisible(false);
    setTimeout(() => setToast(null), 300);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return { toast, toastVisible, showToast, hideToast };
}
