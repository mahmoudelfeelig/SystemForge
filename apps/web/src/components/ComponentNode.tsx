import {
  ArrowClockwise,
  CheckCircle,
  FlowArrow,
  HardDrives,
  Pulse,
  Queue,
  Warning,
  WarningOctagon,
  XCircle,
} from "@phosphor-icons/react";
import type {
  ArchitectureNode,
  NodeMetricSnapshot,
  SampledSpan,
} from "@systemforge/contracts";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useEffect, useRef, type CSSProperties } from "react";
import { COMPONENT_ICONS } from "./componentIcons";

export interface SystemNodeData extends Record<string, unknown> {
  component: ArchitectureNode;
  metrics?: NodeMetricSnapshot;
  detail: string;
  causalFocus: boolean;
  throughputRps?: number;
  history: number[];
  pathPlayback?: {
    role: "node" | "source" | "target";
    kind: SampledSpan["kind"];
    status: SampledSpan["status"];
    failureCause?: SampledSpan["failureCause"];
  };
}

export type SystemFlowNode = Node<SystemNodeData, "system">;

const metricLabel = (
  component: ArchitectureNode,
  metrics: NodeMetricSnapshot | undefined,
): string => {
  if (!metrics) return "modeled result unavailable";
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
  if (!metrics) {
    if (
      component.kind === "users" ||
      component.kind === "database" ||
      component.kind === "queue" ||
      component.kind === "stream" ||
      component.kind === "network" ||
      component.kind === "cdn"
    ) {
      return {
        value: "—",
        label:
          component.kind === "users"
            ? "RPS"
            : component.kind === "database"
              ? "IOPS"
              : component.kind === "queue" || component.kind === "stream"
                ? "queued"
                : "network",
      };
    }
    return {
      value: String(component.config.instances),
      label:
        component.config.instances === 1
          ? "configured instance"
          : "configured instances",
    };
  }
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
    if (!canvas) return;
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
    if (values.length < 2) return;
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
  const state = metrics?.state ?? "not-run";
  const topology = component.config.behavior?.topology;
  const utilization = metrics?.utilization ?? 0;
  const primary = primaryMetric(component, metrics, data.throughputRps);
  const pathPlayback = data.pathPlayback;
  const PathIcon = pathPlayback?.failureCause
    ? WarningOctagon
    : pathPlayback?.kind === "retry"
      ? ArrowClockwise
      : pathPlayback?.kind === "cache"
        ? HardDrives
        : pathPlayback?.kind === "async-queue"
          ? Queue
          : FlowArrow;
  const StateIcon = !metrics
    ? Pulse
    : state === "offline"
      ? XCircle
      : state === "critical"
        ? WarningOctagon
        : state === "warning"
          ? Warning
          : CheckCircle;

  return (
    <article
      className={`system-node system-node--kind-${component.kind} system-node--${state} ${selected ? "system-node--selected" : ""} ${data.causalFocus ? "system-node--causal" : ""} ${pathPlayback ? `system-node--path system-node--path-${pathPlayback.role} system-node--path-${pathPlayback.status}` : ""}`}
      aria-label={
        metrics
          ? `${component.name}, ${state}, ${Math.round(utilization * 100)} percent utilized`
          : `${component.name}, not run, utilization unavailable`
      }
      style={
        metrics
          ? undefined
          : ({
              "--node-health": "var(--muted)",
              boxShadow: "inset 0 0 18px rgba(126, 150, 161, 0.025)",
            } as CSSProperties)
      }
    >
      <Handle type="target" position={Position.Left} />
      <header>
        <span className="system-node__kind" aria-hidden="true">
          <Icon size={15} weight="duotone" />
        </span>
        <div>
          <small>
            {component.kind.replaceAll("-", " ")}
            {topology?.region ? ` · ${topology.region}` : ""}
          </small>
          <strong>{component.name}</strong>
        </div>
        <StateIcon
          className="system-node__state"
          size={15}
          weight={metrics ? "fill" : "regular"}
          aria-label={metrics ? state : "not run"}
        />
      </header>
      <div className="system-node__readout">
        <span>
          <strong>{primary.value}</strong>
          <small>{primary.label}</small>
        </span>
        <NodeSparkline values={metrics ? data.history : []} />
      </div>
      <span className="system-node__track" aria-hidden="true">
        <span style={{ width: `${Math.min(100, utilization * 100)}%` }} />
      </span>
      <footer>
        <span>{metricLabel(component, metrics)}</span>
        <small>
          {metrics ? `${Math.round(utilization * 100)}% ${state}` : "not run"}
          {topology?.failureDomain ? ` · ${topology.failureDomain}` : ""}
        </small>
      </footer>
      {pathPlayback ? (
        <span
          className="system-node__path-badge"
          aria-label={`Path playback ${pathPlayback.kind.replaceAll("-", " ")} ${pathPlayback.role}${pathPlayback.failureCause ? `, failure ${pathPlayback.failureCause.replaceAll("-", " ")}` : ""}`}
        >
          <PathIcon size={11} weight="duotone" aria-hidden="true" />
          <b>{pathPlayback.failureCause ? "failure" : pathPlayback.kind}</b>
          <small>{pathPlayback.role}</small>
        </span>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </article>
  );
}
