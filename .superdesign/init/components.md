# Shared UI components

SystemForge uses custom React components and plain CSS rather than a third-party component system. The reusable visual primitives below are the actual source.

## ComponentNode

- File: `apps/web/src/components/ComponentNode.tsx`
- Description: Reusable topology node rendered on the lab canvas.

```tsx
import {
  CheckCircle,
  Warning,
  WarningOctagon,
  XCircle,
} from "@phosphor-icons/react";
import type {
  ArchitectureNode,
  NodeMetricSnapshot,
} from "@systemforge/contracts";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useEffect, useRef } from "react";
import { COMPONENT_ICONS } from "./componentIcons";

export interface SystemNodeData extends Record<string, unknown> {
  component: ArchitectureNode;
  metrics?: NodeMetricSnapshot;
  detail: string;
  causalFocus: boolean;
  throughputRps?: number;
  history: number[];
}

export type SystemFlowNode = Node<SystemNodeData, "system">;

const metricLabel = (
  component: ArchitectureNode,
  metrics: NodeMetricSnapshot | undefined,
): string => {
  if (!metrics) return "capacity armed";
  if (component.kind === "database")
    return `${Math.round(metrics.iopsUtilization * 100)}% IOPS · ${Math.round(metrics.connectionUtilization * 100)}% CONN`;
  if (component.kind === "queue" || component.kind === "stream")
    return `${Math.round(metrics.queueDepth).toLocaleString()} queued`;
  if (component.kind === "network" || component.kind === "cdn")
    return `${Math.round(metrics.networkUtilization * 100)}% network`;
  return `${metrics.activeInstances} active · ${Math.round(metrics.latencyMs)} ms`;
};

const primaryMetric = (
  component: ArchitectureNode,
  metrics: NodeMetricSnapshot | undefined,
  throughputRps: number | undefined,
): { value: string; label: string } => {
  if (component.kind === "users")
    return {
      value: Math.round(throughputRps ?? 0).toLocaleString(),
      label: "RPS",
    };
  if (component.kind === "database")
    return {
      value: `${Math.round((metrics?.iopsUtilization ?? 0) * 100)}%`,
      label: "IOPS",
    };
  if (component.kind === "queue" || component.kind === "stream")
    return {
      value: Math.round(metrics?.queueDepth ?? 0).toLocaleString(),
      label: "queued",
    };
  if (component.kind === "network" || component.kind === "cdn")
    return {
      value: `${Math.round((metrics?.networkUtilization ?? 0) * 100)}%`,
      label: "network",
    };
  return {
    value: String(metrics?.activeInstances ?? component.config.instances),
    label:
      (metrics?.activeInstances ?? component.config.instances) === 1
        ? "instance"
        : "instances",
  };
};

function NodeSparkline({ values }: { values: number[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || values.length < 2) return;
    if (typeof CanvasRenderingContext2D === "undefined") return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values, minimum + 0.01);
    context.strokeStyle = getComputedStyle(canvas).color;
    context.lineWidth = 1.25;
    context.beginPath();
    values.forEach((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * width;
      const y =
        height -
        1 -
        ((value - minimum) / Math.max(0.01, maximum - minimum)) * (height - 2);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }, [values]);

  return <canvas className="system-node__sparkline" ref={canvasRef} />;
}

export function ComponentNode({ data, selected }: NodeProps<SystemFlowNode>) {
  const { component, metrics } = data;
  const Icon = COMPONENT_ICONS[component.kind];
  const state = metrics?.state ?? "healthy";
  const utilization = metrics?.utilization ?? 0;
  const primary = primaryMetric(component, metrics, data.throughputRps);
  const StateIcon =
    state === "offline"
      ? XCircle
      : state === "critical"
        ? WarningOctagon
        : state === "warning"
          ? Warning
          : CheckCircle;

  return (
    <article
      className={`system-node system-node--kind-${component.kind} system-node--${state} ${selected ? "system-node--selected" : ""} ${data.causalFocus ? "system-node--causal" : ""}`}
      aria-label={`${component.name}, ${state}, ${Math.round(utilization * 100)} percent utilized`}
    >
      <Handle type="target" position={Position.Left} />
      <header>
        <span className="system-node__kind" aria-hidden="true">
          <Icon size={15} weight="duotone" />
        </span>
        <div>
          <small>{component.kind.replaceAll("-", " ")}</small>
          <strong>{component.name}</strong>
        </div>
        <StateIcon
          className="system-node__state"
          size={15}
          weight="fill"
          aria-label={state}
        />
      </header>
      <div className="system-node__readout">
        <span>
          <strong>{primary.value}</strong>
          <small>{primary.label}</small>
        </span>
        <NodeSparkline values={data.history} />
      </div>
      <span className="system-node__track" aria-hidden="true">
        <span style={{ width: `${Math.min(100, utilization * 100)}%` }} />
      </span>
      <footer>
        <span>{metricLabel(component, metrics)}</span>
        <small>
          {Math.round(utilization * 100)}% {state}
        </small>
      </footer>
      <Handle type="source" position={Position.Right} />
    </article>
  );
}
```

## ServiceBanner

- File: `apps/web/src/components/ServiceBanner.tsx`
- Description: Reusable non-blocking service state and local-mode guidance banner.

```tsx
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
```

## componentIcons

- File: `apps/web/src/components/componentIcons.tsx`
- Description: Shared mapping from system component kinds to Phosphor icon components.

```tsx
import {
  Archive,
  ArrowsLeftRight,
  Broadcast,
  Cloud,
  Database,
  GlobeHemisphereWest,
  HardDrives,
  Lightning,
  PlugsConnected,
  Queue,
  ShareNetwork,
  TreeStructure,
  UsersThree,
  type Icon,
} from "@phosphor-icons/react";
import type { ArchitectureNode } from "@systemforge/contracts";

export const COMPONENT_ICONS: Record<ArchitectureNode["kind"], Icon> = {
  users: UsersThree,
  region: GlobeHemisphereWest,
  dns: TreeStructure,
  cdn: Cloud,
  network: ShareNetwork,
  "load-balancer": ArrowsLeftRight,
  api: Lightning,
  cache: HardDrives,
  database: Database,
  queue: Queue,
  stream: Broadcast,
  worker: HardDrives,
  "object-store": Archive,
  "third-party": PlugsConnected,
};
```
