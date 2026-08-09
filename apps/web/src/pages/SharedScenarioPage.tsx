import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { fetchSharedScenario } from "../lib/api";
import {
  clearSensitiveHashParameter,
  readSensitiveHashParameter,
} from "../lib/sensitiveHash";
import { useLabStore } from "../store/useLabStore";
import { RouteStatePage } from "../components/RouteStatePage";

interface SharedRouteError {
  title: string;
  reason: string;
  retryable: boolean;
}

const sharedRouteError = (reason: unknown): SharedRouteError => {
  const status =
    reason && typeof reason === "object" && "status" in reason
      ? Number(reason.status)
      : null;
  if (status === 401 || status === 403)
    return {
      title: "This interviewer link is not valid",
      reason: "Open the candidate link or ask the interviewer for a new link.",
      retryable: false,
    };
  if (status === 404)
    return {
      title: "This scenario link is unavailable",
      reason: "The link may have expired or been removed.",
      retryable: false,
    };
  if (status === 429)
    return {
      title: "The online service is busy",
      reason:
        "Too many link requests are in progress. Wait a moment and retry.",
      retryable: true,
    };
  if (status !== null && status >= 500)
    return {
      title: "The online service is unavailable",
      reason:
        "SystemForge could not load the link. Your local Lab still works.",
      retryable: true,
    };
  if (typeof navigator !== "undefined" && !navigator.onLine)
    return {
      title: "You’re offline",
      reason: "Reconnect to open a server-backed scenario link.",
      retryable: true,
    };
  return {
    title: "This scenario link is unavailable",
    reason: "SystemForge could not verify this link.",
    retryable: true,
  };
};

export function SharedScenarioPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const loadSharedScenario = useLabStore((state) => state.loadSharedScenario);
  const [error, setError] = useState<SharedRouteError | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    setError(null);
    if (!id) {
      setError({
        title: "This scenario link is unavailable",
        reason: "The link is missing its scenario ID.",
        retryable: false,
      });
      return;
    }
    const controller = new AbortController();
    clearSensitiveHashParameter("share");
    const hostToken = readSensitiveHashParameter("hostToken");
    queueMicrotask(() => clearSensitiveHashParameter("hostToken", hostToken));
    void fetchSharedScenario(id, hostToken ?? undefined, controller.signal)
      .then((shared) => {
        if (controller.signal.aborted) return;
        loadSharedScenario(shared.scenario, shared.architecture, shared.role, {
          id: shared.id,
          ...(shared.role === "interviewer" && hostToken ? { hostToken } : {}),
          revealState: shared.revealState,
          collaboration: shared.collaboration,
        });
        void navigate("/lab", { replace: true });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(sharedRouteError(reason));
      });
    return () => controller.abort();
  }, [id, loadSharedScenario, navigate, retryKey]);

  return error ? (
    <RouteStatePage
      state="error"
      variant="shared"
      label="SHARED SCENARIO"
      title={error.title}
      body={`Your local Lab is still available. Reason: ${error.reason}`}
      retry={
        error.retryable
          ? { label: "Retry", onClick: () => setRetryKey((key) => key + 1) }
          : undefined
      }
      primary={{ label: "Open local Lab", to: "/lab" }}
      secondary={{ label: "Home", to: "/" }}
    />
  ) : (
    <RouteStatePage
      state="loading"
      variant="shared"
      label="SHARED SCENARIO"
      title="Opening shared scenario"
      body="Verifying the link and loading the scenario."
      context="Private interview criteria load only from an authenticated interviewer link."
    />
  );
}
