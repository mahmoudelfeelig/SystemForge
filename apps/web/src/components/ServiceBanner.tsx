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
  if (!notice) return null;
  const Icon =
    availability === "online"
      ? CloudCheck
      : availability === "busy"
        ? Gauge
        : CloudSlash;
  return (
    <div
      className={`service-banner service-banner--${availability}`}
      role="status"
    >
      <Icon size={18} weight="duotone" aria-hidden="true" />
      <span>{notice}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss notice">
        <X size={16} />
      </button>
    </div>
  );
}
