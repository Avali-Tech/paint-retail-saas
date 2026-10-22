import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './Icon.js';

export interface ToastOptions {
  readonly title: string;
  readonly description?: string;
  readonly tone?: 'success' | 'danger' | 'info';
}

interface ToastItem extends ToastOptions {
  readonly id: number;
}

type ShowToast = (options: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);

export interface ToastProviderProps {
  readonly children: ReactNode;
  /** Milliseconds before a toast disappears on its own. */
  readonly duration?: number;
  readonly regionLabel?: string;
  readonly dismissLabel?: string;
}

/** Short messages ("Saved") in a live region, so screen readers announce them. */
export function ToastProvider({
  children,
  duration = 5000,
  regionLabel = 'Messages',
  dismissLabel = 'Dismiss',
}: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  // Timers still to fire, cleared on unmount so none sets state after it.
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback<ShowToast>(
    (options) => {
      nextId.current += 1;
      const id = nextId.current;
      setToasts((list) => [...list, { ...options, id }]);
      const timer = window.setTimeout(() => {
        timers.current.delete(timer);
        dismiss(id);
      }, duration);
      timers.current.add(timer);
    },
    [dismiss, duration],
  );

  return (
    <ToastContext value={show}>
      {children}
      <section className="ui-toasts" aria-label={regionLabel} aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="ui-toast"
            data-tone={toast.tone ?? 'info'}
            role={toast.tone === 'danger' ? 'alert' : 'status'}
          >
            <div className="ui-toast__text">
              <strong>{toast.title}</strong>
              {toast.description !== undefined && <span>{toast.description}</span>}
            </div>
            <button
              type="button"
              className="ui-icon-button"
              aria-label={dismissLabel}
              onClick={() => {
                dismiss(toast.id);
              }}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
      </section>
    </ToastContext>
  );
}

/** Shows a toast. Must be inside ToastProvider. */
export function useToast(): ShowToast {
  const show = use(ToastContext);
  if (!show) throw new Error('useToast must be used inside <ToastProvider>');
  return show;
}
