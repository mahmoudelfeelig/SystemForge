import { ArrowClockwise, CircleNotch, Warning, X } from "@phosphor-icons/react";
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

export interface DecisionWorkbenchBoundaryProps {
  open: boolean;
  onClose: () => void;
}

type DecisionWorkbenchModule = {
  DecisionWorkbench: ComponentType<DecisionWorkbenchBoundaryProps>;
};

type DecisionWorkbenchLoader = () => Promise<DecisionWorkbenchModule>;

class DecisionWorkbenchLoadErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function DecisionWorkbenchLoadFailure({
  onRetry,
  onClose,
}: {
  onRetry: () => void;
  onClose: () => void;
}) {
  const retryRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => retryRef.current?.focus(), []);

  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    if (event.shiftKey && document.activeElement === retryRef.current) {
      event.preventDefault();
      closeRef.current?.focus();
    } else if (!event.shiftKey && document.activeElement === closeRef.current) {
      event.preventDefault();
      retryRef.current?.focus();
    }
  };

  return (
    <div className="decision-overlay" role="presentation">
      <div
        className="decision-loading decision-loading--error"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="decision-load-error-title"
        aria-describedby="decision-load-error-description"
        onKeyDown={trapFocus}
      >
        <Warning size={22} weight="fill" aria-hidden="true" />
        <span className="panel-index">DECISION WORKBENCH</span>
        <strong id="decision-load-error-title">
          Decision tools unavailable
        </strong>
        <p id="decision-load-error-description">
          The local comparison module did not load. Retry the module or close
          the workbench and continue in the Lab.
        </p>
        <div className="decision-loading__actions">
          <button
            ref={retryRef}
            className="button button--primary"
            type="button"
            onClick={onRetry}
          >
            <ArrowClockwise size={15} /> Retry
          </button>
          <button
            ref={closeRef}
            className="button"
            type="button"
            onClick={onClose}
          >
            <X size={15} /> Close
          </button>
        </div>
      </div>
    </div>
  );
}

export const createDecisionWorkbenchBoundary = (
  loadDecisionWorkbench: DecisionWorkbenchLoader,
) => {
  return function DecisionWorkbenchBoundary({
    open,
    onClose,
  }: DecisionWorkbenchBoundaryProps) {
    const [activated, setActivated] = useState(open);
    const [loadAttempt, setLoadAttempt] = useState(0);
    const returnFocusRef = useRef<HTMLElement | null>(null);
    const wasOpenRef = useRef(false);

    if (open && !wasOpenRef.current && typeof document !== "undefined") {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    wasOpenRef.current = open;

    const LazyDecisionWorkbench = useMemo(
      () =>
        lazy(async () => {
          const module = await loadDecisionWorkbench();
          return { default: module.DecisionWorkbench };
        }),
      [loadAttempt],
    );

    useEffect(() => {
      if (open) setActivated(true);
    }, [open]);

    const closeAndRestoreFocus = useCallback(() => {
      const returnFocus = returnFocusRef.current;
      onClose();
      queueMicrotask(() => {
        if (returnFocus?.isConnected) returnFocus.focus();
      });
    }, [onClose]);

    const closeAfterLoadFailure = useCallback(() => {
      setActivated(false);
      setLoadAttempt((current) => current + 1);
      closeAndRestoreFocus();
    }, [closeAndRestoreFocus]);

    const retryLoad = useCallback(
      () => setLoadAttempt((current) => current + 1),
      [],
    );

    if (!open && !activated) return null;

    return (
      <DecisionWorkbenchLoadErrorBoundary
        key={loadAttempt}
        fallback={
          open ? (
            <DecisionWorkbenchLoadFailure
              onRetry={retryLoad}
              onClose={closeAfterLoadFailure}
            />
          ) : null
        }
      >
        <Suspense
          fallback={
            open ? (
              <div className="decision-overlay" role="presentation">
                <div
                  className="decision-loading"
                  role="status"
                  aria-live="polite"
                >
                  <CircleNotch className="spin" size={20} aria-hidden="true" />
                  <span className="panel-index">DECISION WORKBENCH</span>
                  <strong>Loading decision tools</strong>
                  <small>
                    Preparing local comparison and analysis modules.
                  </small>
                </div>
              </div>
            ) : null
          }
        >
          <LazyDecisionWorkbench open={open} onClose={closeAndRestoreFocus} />
        </Suspense>
      </DecisionWorkbenchLoadErrorBoundary>
    );
  };
};

export const DecisionWorkbenchBoundary = createDecisionWorkbenchBoundary(
  () => import("./DecisionWorkbench"),
);
