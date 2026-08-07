import { CloudCheck, CloudSlash, Gauge, X } from "@phosphor-icons/react";
import type { ApiAvailability } from "../lib/api";

interface ServiceBannerProps {
  availability: ApiAvailability;
  notice: string | null;
  onDismiss: () => void;
}

export function ServiceBanner({
  availability,
  notice,
  onDismiss,
}: ServiceBannerProps) {
  if (!notice && availability === "online") return null;
  const Icon =
    availability === "online"
      ? CloudCheck
      : availability === "busy"
        ? Gauge
        : CloudSlash;
  const message =
    notice ??
    (availability === "checking"
      ? "Checking canonical-run capacity. Local mode is ready."
      : availability === "busy"
        ? "Canonical capacity is busy. Build and run locally without interruption."
        : "Server features are offline. Build, simulate, save and share locally in this browser.");
  return (
    <div
      className={`service-banner service-banner--${availability}`}
      role="status"
    >
      <Icon size={18} weight="duotone" aria-hidden="true" />
      <span>{message}</span>
      {notice ? (
        <button type="button" onClick={onDismiss} aria-label="Dismiss notice">
          <X size={16} />
        </button>
      ) : null}
    </div>
  );
}
