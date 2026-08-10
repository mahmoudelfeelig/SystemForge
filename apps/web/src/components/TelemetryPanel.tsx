import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  CaretLeft,
  CaretRight,
  CheckCircle,
  FlowArrow,
  HardDrives,
  Info,
  LinkBreak,
  Pause,
  Play,
  Pulse,
  Queue,
  Warning,
  WarningOctagon,
} from "@phosphor-icons/react";
import type {
  ArchitectureEdge,
  ArchitectureNode,
  CausalEvent,
  MetricFrame,
  NodeMetricSnapshot,
  SampledSpan,
  SampledTrace,
  Scenario,
  SimulationResult,
} from "@systemforge/contracts";

interface TelemetryPanelProps {
  result: SimulationResult | null;
  liveFrames?: MetricFrame[];
  liveEvents?: CausalEvent[];
  running?: boolean;
  progress?: number;
  scenario: Scenario;
  nodes: ArchitectureNode[];
  edges?: ArchitectureEdge[];
  selectedEventId: string | null;
  currentSecond: number;
  onSelectEvent: (id: string) => void;
  onSeek: (second: number) => void;
  onTracePlaybackChange?: (selection: TracePlaybackSelection | null) => void;
}

export interface TracePlaybackSelection {
  trace: SampledTrace;
  span: SampledSpan;
  spanIndex: number;
  spanCount: number;
  playing: boolean;
  reducedMotion: boolean;
}

type ResourceMetric = keyof Pick<
  NodeMetricSnapshot,
  | "cpuUtilization"
  | "memoryUtilization"
  | "networkUtilization"
  | "iopsUtilization"
>;

interface ResourceSeries {
  id: string;
  label: string;
  color: string;
  values: number[];
  current: number;
}

const resourceMetrics: Array<{ key: ResourceMetric; label: string }> = [
  { key: "cpuUtilization", label: "CPU" },
  { key: "memoryUtilization", label: "Memory" },
  { key: "networkUtilization", label: "Network" },
  { key: "iopsUtilization", label: "Disk" },
];

const resourceColors = ["#ff604f", "#58bfff", "#75d48a", "#f2bf4b", "#b993e8"];

type TelemetrySeriesId = "rps" | "latency" | "error" | "queue";
type DiagnosticView = "resources" | "traces";

const telemetrySeries: Array<{
  id: TelemetrySeriesId;
  label: string;
  unit: string;
  color: string;
  value: (frame: MetricFrame) => number;
}> = [
  {
    id: "rps",
    label: "Throughput",
    unit: "RPS",
    color: "#58bfff",
    value: (frame) => frame.rps,
  },
  {
    id: "latency",
    label: "Latency p95",
    unit: "ms",
    color: "#f2bf4b",
    value: (frame) => frame.p95LatencyMs,
  },
  {
    id: "error",
    label: "Error rate",
    unit: "%",
    color: "#ff604f",
    value: (frame) => frame.errorRate,
  },
  {
    id: "queue",
    label: "Queue depth",
    unit: "messages",
    color: "#75d48a",
    value: (frame) => frame.queueDepth,
  },
];

const defaultVisibleSeries: Record<TelemetrySeriesId, boolean> = {
  rps: true,
  latency: true,
  error: true,
  queue: true,
};

function ResourceCanvas({ series }: { series: ResourceSeries[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
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
      context.strokeStyle = "#172b36";
      context.lineWidth = 1;
      for (let index = 1; index < 4; index += 1) {
        const y = (height / 4) * index;
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }
      const maximum = Math.max(1, ...series.flatMap((item) => item.values));
      for (const item of series) {
        if (item.values.length < 2) continue;
        context.beginPath();
        context.strokeStyle = item.color;
        context.lineWidth = 1.4;
        item.values.forEach((value, index) => {
          const x = (index / Math.max(1, item.values.length - 1)) * width;
          const y = height - 5 - (value / maximum) * (height - 10);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.stroke();
      }
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [series]);

  return (
    <canvas
      className="resource-canvas"
      ref={canvasRef}
      aria-label="Per-component resource utilization history"
    />
  );
}

function TelemetryCanvas({
  frames,
  currentSecond,
  visibleSeries,
  onHoverSecond,
}: {
  frames: MetricFrame[];
  currentSecond: number;
  visibleSeries: Record<TelemetrySeriesId, boolean>;
  onHoverSecond: (second: number | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
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
      context.strokeStyle = "#172b36";
      context.lineWidth = 1;
      for (let index = 1; index < 5; index += 1) {
        const y = (height / 5) * index;
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }
      const series = telemetrySeries
        .filter((item) => visibleSeries[item.id])
        .map((item) => {
          const values = frames.map(item.value);
          return {
            values,
            maximum: Math.max(...values, 1),
            color: item.color,
          };
        });
      for (const line of series) {
        context.beginPath();
        context.lineWidth = 1.6;
        context.strokeStyle = line.color;
        line.values.forEach((value, index) => {
          const x = (index / Math.max(1, line.values.length - 1)) * width;
          const y = height - 7 - (value / line.maximum) * (height - 14);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.stroke();
      }
      const firstSecond = frames[0]?.second ?? 0;
      const lastSecond = frames.at(-1)?.second ?? firstSecond;
      const cursorX =
        ((currentSecond - firstSecond) /
          Math.max(1, lastSecond - firstSecond)) *
        width;
      context.strokeStyle = "#eef8fb";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(cursorX, 0);
      context.lineTo(cursorX, height);
      context.stroke();
      context.fillStyle = "#eef8fb";
      context.fillRect(cursorX - 2, 0, 4, 4);
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [currentSecond, frames, visibleSeries]);

  return (
    <canvas
      ref={canvasRef}
      className="telemetry-canvas"
      aria-label="Telemetry chart. Each visible series uses its own labeled unit scale."
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const ratio = Math.min(
          1,
          Math.max(
            0,
            (event.clientX - bounds.left) / Math.max(1, bounds.width),
          ),
        );
        const index = Math.round(ratio * Math.max(0, frames.length - 1));
        onHoverSecond(frames[index]?.second ?? null);
      }}
      onPointerLeave={() => onHoverSecond(null)}
    />
  );
}

const causalChain = (
  events: CausalEvent[],
  selectedEventId: string | null,
): CausalEvent[] => {
  const selected = events.find((event) => event.id === selectedEventId);
  if (!selected) return [];
  const byId = new Map(events.map((event) => [event.id, event]));
  const ordered: CausalEvent[] = [];
  const visited = new Set<string>();
  const visit = (event: CausalEvent) => {
    if (visited.has(event.id)) return;
    for (const parentId of event.parentIds) {
      const parent = byId.get(parentId);
      if (parent) visit(parent);
    }
    visited.add(event.id);
    ordered.push(event);
  };
  visit(selected);
  return ordered;
};

const formatSecond = (second: number) =>
  `${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}`;

const milestoneEvents = (events: CausalEvent[]): CausalEvent[] => {
  const firstAtSecond = events.filter(
    (event, index) => index === 0 || events[index - 1]?.second !== event.second,
  );
  const preferred = firstAtSecond.filter(
    (event) =>
      event.parentIds.length === 0 ||
      /traffic|fail|unavailable|recover|retry|slow|storm/i.test(event.title),
  );
  const candidates = preferred.length >= 3 ? preferred : firstAtSecond;
  const selected: CausalEvent[] = [];
  for (const event of candidates) {
    const previous = selected.at(-1);
    if (!previous || event.second - previous.second >= 10) selected.push(event);
    if (selected.length === 5) break;
  }
  return selected;
};

const spanKindLabel: Record<SampledSpan["kind"], string> = {
  entry: "Entry",
  edge: "Edge",
  retry: "Retry",
  cache: "Cache",
  "async-queue": "Async queue",
  terminal: "Terminal",
};

type TraceSpanSignalKind =
  "retry" | "cache" | "async" | "failure" | "degraded" | "ok";

export interface TraceSpanSignal {
  kind: TraceSpanSignalKind;
  label: string;
}

export const traceSpanSignals = (span: SampledSpan): TraceSpanSignal[] => {
  const signals: TraceSpanSignal[] = [];
  if (span.kind === "retry" || span.retryAttempt !== undefined)
    signals.push({
      kind: "retry",
      label: `Retry attempt ${span.retryAttempt ?? 1}`,
    });
  if (
    span.kind === "cache" ||
    span.cacheHitRps !== undefined ||
    span.cacheMissRps !== undefined
  )
    signals.push({
      kind: "cache",
      label: `Cache ${formatTraceNumber(span.cacheHitRps ?? 0)} hit / ${formatTraceNumber(span.cacheMissRps ?? 0)} miss RPS`,
    });
  if (span.asynchronous || span.kind === "async-queue")
    signals.push({
      kind: "async",
      label: span.parentMessageId
        ? `Async lineage · ${span.messageId ?? "unresolved message"} from ${span.parentMessageId}`
        : `Async boundary · ${span.messageId ?? "message lineage unresolved"}`,
    });
  if (span.failureCause)
    signals.push({
      kind: "failure",
      label: `Failure · ${span.failureCause.replaceAll("-", " ")}`,
    });
  if (span.status === "degraded")
    signals.push({ kind: "degraded", label: "Degraded delivery" });
  if (span.status === "dropped")
    signals.push({ kind: "failure", label: "Dropped delivery" });
  if (signals.length === 0) signals.push({ kind: "ok", label: "Delivered" });
  return signals;
};

function TraceSignalIcon({ kind }: { kind: TraceSpanSignalKind }) {
  const Icon =
    kind === "retry"
      ? ArrowClockwise
      : kind === "cache"
        ? HardDrives
        : kind === "async"
          ? Queue
          : kind === "failure"
            ? WarningOctagon
            : kind === "degraded"
              ? Warning
              : CheckCircle;
  return <Icon size={12} weight="duotone" aria-hidden="true" />;
}

const referencedSpanEntityIds = (span: SampledSpan): string[] =>
  [span.nodeId, span.sourceNodeId, span.targetNodeId, span.edgeId].filter(
    (id): id is string => Boolean(id),
  );

export const unresolvedTraceEntityIds = (
  span: SampledSpan,
  nodes: readonly Pick<ArchitectureNode, "id">[],
  edges: readonly Pick<ArchitectureEdge, "id" | "source" | "target">[],
): string[] => {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edge = span.edgeId
    ? edges.find((candidate) => candidate.id === span.edgeId)
    : undefined;
  const unresolved = new Set<string>();
  for (const nodeId of [span.nodeId, span.sourceNodeId, span.targetNodeId]) {
    if (nodeId && !nodeIds.has(nodeId)) unresolved.add(nodeId);
  }
  if (span.edgeId && !edge) unresolved.add(span.edgeId);
  if (
    edge &&
    ((span.sourceNodeId && edge.source !== span.sourceNodeId) ||
      (span.targetNodeId && edge.target !== span.targetNodeId))
  )
    unresolved.add(span.edgeId ?? `${edge.source} → ${edge.target}`);
  if (!span.edgeId && span.sourceNodeId && span.targetNodeId) {
    const tupleMatches = edges.filter(
      (candidate) =>
        candidate.source === span.sourceNodeId &&
        candidate.target === span.targetNodeId,
    );
    if (tupleMatches.length !== 1)
      unresolved.add(`${span.sourceNodeId} → ${span.targetNodeId}`);
  }
  return [...unresolved];
};

const useReducedMotionPreference = (): boolean => {
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    )
      return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  return reducedMotion;
};

const formatTraceNumber = (value: number): string =>
  value.toLocaleString("en-US", { maximumFractionDigits: 2 });

const formatModeledRate = (value: number): string =>
  `${formatTraceNumber(value)} RPS`;

function TraceSpanDetail({
  span,
  index,
  nodeLabel,
}: {
  span: SampledSpan;
  index: number;
  nodeLabel: (nodeId: string | undefined) => string;
}) {
  return (
    <section
      className={`trace-span-detail trace-span-detail--${span.status}`}
      aria-label="Selected span details"
      aria-live="polite"
    >
      <header>
        <span>
          {String(index + 1).padStart(2, "0")} / {spanKindLabel[span.kind]}
        </span>
        <strong>{span.name}</strong>
        <b>{span.status}</b>
      </header>
      <dl>
        <div>
          <dt>Span ID</dt>
          <dd>{span.spanId}</dd>
        </div>
        <div>
          <dt>Parent span</dt>
          <dd>{span.parentSpanId ?? "Root span · none"}</dd>
        </div>
        {span.nodeId ? (
          <div>
            <dt>Node</dt>
            <dd>{nodeLabel(span.nodeId)}</dd>
          </div>
        ) : null}
        {span.edgeId ? (
          <div>
            <dt>Edge ID</dt>
            <dd>{span.edgeId}</dd>
          </div>
        ) : null}
        {span.sourceNodeId ? (
          <div>
            <dt>Source</dt>
            <dd>{nodeLabel(span.sourceNodeId)}</dd>
          </div>
        ) : null}
        {span.targetNodeId ? (
          <div>
            <dt>Target</dt>
            <dd>{nodeLabel(span.targetNodeId)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Traffic</dt>
          <dd>
            Attempted {formatModeledRate(span.attemptedRps)} · delivered{" "}
            {formatModeledRate(span.throughputRps)} · retry{" "}
            {formatModeledRate(span.retryRps)} · lost{" "}
            {formatModeledRate(span.lostRps)}
          </dd>
        </div>
        <div>
          <dt>Latency</dt>
          <dd>{formatTraceNumber(span.latencyMs)} ms modeled</dd>
        </div>
        <div>
          <dt>Boundary</dt>
          <dd>{span.asynchronous ? "Asynchronous" : "Synchronous"}</dd>
        </div>
        {span.retryAttempt !== undefined ? (
          <div>
            <dt>Retry attempt</dt>
            <dd>{span.retryAttempt}</dd>
          </div>
        ) : null}
        {span.cacheHitRps !== undefined || span.cacheMissRps !== undefined ? (
          <div>
            <dt>Cache decision</dt>
            <dd>
              Hit {formatModeledRate(span.cacheHitRps ?? 0)} · miss{" "}
              {formatModeledRate(span.cacheMissRps ?? 0)}
            </dd>
          </div>
        ) : null}
        {span.queryClass ? (
          <div>
            <dt>Query class</dt>
            <dd>{span.queryClass}</dd>
          </div>
        ) : null}
        {span.connectionPoolWaitMs !== undefined ? (
          <div>
            <dt>Pool wait</dt>
            <dd>{formatTraceNumber(span.connectionPoolWaitMs)} ms modeled</dd>
          </div>
        ) : null}
        {span.failureCause ? (
          <div>
            <dt>Failure cause</dt>
            <dd>{span.failureCause.replaceAll("-", " ")}</dd>
          </div>
        ) : null}
        {span.messageId ? (
          <div>
            <dt>Message ID</dt>
            <dd>{span.messageId}</dd>
          </div>
        ) : null}
        {span.parentMessageId ? (
          <div>
            <dt>Parent message</dt>
            <dd>{span.parentMessageId}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function TraceExplorer({
  traces,
  completed,
  running,
  progress,
  nodes,
  edges,
  onSeek,
  onPlaybackChange,
}: {
  traces: SampledTrace[] | undefined;
  completed: boolean;
  running: boolean;
  progress: number;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  onSeek: (second: number) => void;
  onPlaybackChange?: (selection: TracePlaybackSelection | null) => void;
}) {
  const orderedTraces = useMemo(
    () =>
      [...(traces ?? [])].sort(
        (left, right) =>
          left.second - right.second ||
          left.requestClass.localeCompare(right.requestClass) ||
          left.traceId.localeCompare(right.traceId),
      ),
    [traces],
  );
  const nodeNames = useMemo(
    () => new Map(nodes.map((node) => [node.id, node.name])),
    [nodes],
  );
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [playbackActive, setPlaybackActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const spanButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const reducedMotion = useReducedMotionPreference();
  const selectedTrace =
    orderedTraces.find((trace) => trace.traceId === selectedTraceId) ??
    orderedTraces[0] ??
    null;
  const selectedSpan =
    selectedTrace?.spans.find((span) => span.spanId === selectedSpanId) ??
    selectedTrace?.spans[0] ??
    null;
  const selectedSpanIndex =
    selectedTrace && selectedSpan
      ? Math.max(
          0,
          selectedTrace.spans.findIndex(
            (span) => span.spanId === selectedSpan.spanId,
          ),
        )
      : 0;

  useEffect(() => {
    const firstTrace = orderedTraces[0] ?? null;
    setSelectedTraceId(firstTrace?.traceId ?? null);
    setSelectedSpanId(firstTrace?.spans[0]?.spanId ?? null);
    setPlaybackActive(false);
    setPlaying(false);
    spanButtonRefs.current = [];
  }, [orderedTraces]);

  useEffect(
    () => () => {
      onPlaybackChange?.(null);
    },
    [onPlaybackChange],
  );

  useEffect(() => {
    if (!playbackActive || !selectedTrace || !selectedSpan) {
      onPlaybackChange?.(null);
      return;
    }
    onPlaybackChange?.({
      trace: selectedTrace,
      span: selectedSpan,
      spanIndex: selectedSpanIndex,
      spanCount: selectedTrace.spans.length,
      playing,
      reducedMotion,
    });
  }, [
    onPlaybackChange,
    playbackActive,
    playing,
    reducedMotion,
    selectedSpan,
    selectedSpanIndex,
    selectedTrace,
  ]);

  useEffect(() => {
    if (!playbackActive || !selectedTrace) return;
    onSeek(selectedTrace.second);
  }, [onSeek, playbackActive, selectedTrace]);

  useEffect(() => {
    if (!playbackActive || !playing || !selectedTrace) return;
    if (selectedSpanIndex >= selectedTrace.spans.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(
      () =>
        setSelectedSpanId(
          selectedTrace.spans[selectedSpanIndex + 1]?.spanId ?? null,
        ),
      reducedMotion ? 1_200 : 850,
    );
    return () => window.clearTimeout(timer);
  }, [
    playbackActive,
    playing,
    reducedMotion,
    selectedSpanIndex,
    selectedTrace,
  ]);

  if (!completed)
    return (
      <div className="trace-empty" role="status">
        <Pulse size={20} weight="duotone" />
        <strong>
          {running ? "Trace sample pending" : "No completed trace sample"}
        </strong>
        <p>
          {running
            ? `${Math.round(progress * 100)}% of modeled frames delivered. Request trace samples publish with the completed result.`
            : "Complete a modeled run to inspect its bounded request-class trace sample."}
        </p>
      </div>
    );

  if (traces === undefined)
    return (
      <div className="trace-empty" role="status">
        <FlowArrow size={20} weight="duotone" />
        <strong>Trace samples unavailable</strong>
        <p>
          This result does not include request trace evidence. It may predate
          trace sampling or may have produced no request class eligible for the
          bounded sample; the result cannot distinguish those cases.
        </p>
      </div>
    );

  if (orderedTraces.length === 0)
    return (
      <div className="trace-empty" role="status">
        <FlowArrow size={20} weight="duotone" />
        <strong>No request traces sampled</strong>
        <p>
          Trace sampling completed with zero representative request traces.
          Aggregate frames and events remain available.
        </p>
      </div>
    );

  if (!selectedTrace) return null;
  const nodeLabel = (nodeId: string | undefined): string => {
    if (!nodeId) return "—";
    const name = nodeNames.get(nodeId);
    return name && name !== nodeId ? `${name} · ${nodeId}` : nodeId;
  };
  const spanRoute = (span: SampledSpan): string => {
    if (span.sourceNodeId && span.targetNodeId)
      return `${nodeLabel(span.sourceNodeId)} → ${nodeLabel(span.targetNodeId)}`;
    if (span.nodeId) return nodeLabel(span.nodeId);
    return "No component ID sampled";
  };
  const selectTrace = (traceId: string) => {
    const nextTrace = orderedTraces.find((trace) => trace.traceId === traceId);
    if (!nextTrace) return;
    setSelectedTraceId(traceId);
    setSelectedSpanId(nextTrace.spans[0]?.spanId ?? null);
    setPlaybackActive(nextTrace.spans.length > 0);
    setPlaying(false);
    spanButtonRefs.current = [];
  };
  const selectSpanAt = (index: number, focus = true) => {
    const span = selectedTrace.spans[index];
    if (!span) return;
    setSelectedSpanId(span.spanId);
    setPlaybackActive(true);
    if (focus) spanButtonRefs.current[index]?.focus();
  };
  const stepPath = (direction: -1 | 1) => {
    setPlaying(false);
    selectSpanAt(
      Math.min(
        selectedTrace.spans.length - 1,
        Math.max(0, selectedSpanIndex + direction),
      ),
      false,
    );
  };
  const togglePlayback = () => {
    if (selectedTrace.spans.length === 0) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    if (selectedSpanIndex >= selectedTrace.spans.length - 1)
      setSelectedSpanId(selectedTrace.spans[0]?.spanId ?? null);
    setPlaybackActive(true);
    setPlaying(true);
  };
  const handlePlaybackKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "ArrowLeft") stepPath(-1);
    else if (event.key === "ArrowRight") stepPath(1);
    else if (event.key === "Home") {
      setPlaying(false);
      selectSpanAt(0, false);
    } else if (event.key === "End") {
      setPlaying(false);
      selectSpanAt(selectedTrace.spans.length - 1, false);
    } else if (event.key === " " || event.key === "Enter") togglePlayback();
    else return;
    event.preventDefault();
  };
  const handleSpanKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number;
    if (event.key === "ArrowDown")
      nextIndex = Math.min(selectedTrace.spans.length - 1, index + 1);
    else if (event.key === "ArrowUp") nextIndex = Math.max(0, index - 1);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = selectedTrace.spans.length - 1;
    else return;
    event.preventDefault();
    selectSpanAt(nextIndex);
  };
  const selectedSignals = selectedSpan ? traceSpanSignals(selectedSpan) : [];
  const unresolvedEntities = selectedSpan
    ? unresolvedTraceEntityIds(selectedSpan, nodes, edges)
    : [];
  const hasTopologyReference = selectedSpan
    ? referencedSpanEntityIds(selectedSpan).length > 0
    : false;

  return (
    <div className="trace-explorer">
      <section className="trace-selector">
        <label>
          Request trace
          <select
            aria-label="Request trace"
            value={selectedTrace.traceId}
            onChange={(event) => selectTrace(event.target.value)}
          >
            {orderedTraces.map((trace) => (
              <option key={trace.traceId} value={trace.traceId}>
                {formatSecond(trace.second)} · {trace.requestClass} ·{" "}
                {formatTraceNumber(trace.modeledRps)} RPS
              </option>
            ))}
          </select>
        </label>
        <dl aria-label="Selected trace summary">
          <div>
            <dt>Trace ID</dt>
            <dd>{selectedTrace.traceId}</dd>
          </div>
          <div>
            <dt>Route</dt>
            <dd>
              {(selectedTrace.entryNodeIds ?? [selectedTrace.entryNodeId])
                .map(nodeLabel)
                .join(" + ")}{" "}
              → {nodeLabel(selectedTrace.terminalNodeId)}
            </dd>
          </div>
          <div>
            <dt>Sample</dt>
            <dd>
              {formatSecond(selectedTrace.second)} ·{" "}
              {formatModeledRate(selectedTrace.modeledRps)}
            </dd>
          </div>
          <div>
            <dt>Class</dt>
            <dd>{selectedTrace.requestClass}</dd>
          </div>
        </dl>
        {selectedTrace.truncated ? (
          <p className="trace-truncated" role="status">
            Truncated by the bounded span cap; later spans or retry attempts may
            be omitted.
          </p>
        ) : null}
      </section>

      <section
        className={`trace-playback${playbackActive ? " trace-playback--active" : ""}`}
        aria-label="Path playback controls"
        aria-keyshortcuts="ArrowLeft ArrowRight Home End Space Enter"
        tabIndex={selectedTrace.spans.length ? 0 : -1}
        onKeyDown={handlePlaybackKeyDown}
      >
        <header>
          <span>
            <FlowArrow size={13} weight="duotone" aria-hidden="true" /> Path
            playback
          </span>
          <strong aria-live="polite">
            {selectedTrace.spans.length
              ? `Step ${selectedSpanIndex + 1} of ${selectedTrace.spans.length}`
              : "No playable spans"}
          </strong>
        </header>
        <div className="trace-playback__transport">
          <button
            type="button"
            disabled={
              selectedTrace.spans.length === 0 || selectedSpanIndex === 0
            }
            onClick={() => stepPath(-1)}
            aria-label="Previous path step"
          >
            <CaretLeft size={14} weight="bold" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={selectedTrace.spans.length === 0}
            onClick={togglePlayback}
            aria-label={playing ? "Pause path" : "Play path"}
            aria-pressed={playing}
          >
            {playing ? (
              <Pause size={13} weight="fill" aria-hidden="true" />
            ) : (
              <Play size={13} weight="fill" aria-hidden="true" />
            )}
            {playing ? "Pause" : playbackActive ? "Play" : "Start path"}
          </button>
          <button
            type="button"
            disabled={
              selectedTrace.spans.length === 0 ||
              selectedSpanIndex >= selectedTrace.spans.length - 1
            }
            onClick={() => stepPath(1)}
            aria-label="Next path step"
          >
            <CaretRight size={14} weight="bold" aria-hidden="true" />
          </button>
          <label>
            <span>Path step</span>
            <input
              type="range"
              min="1"
              max={Math.max(1, selectedTrace.spans.length)}
              value={selectedTrace.spans.length ? selectedSpanIndex + 1 : 1}
              disabled={selectedTrace.spans.length === 0}
              onChange={(event) => {
                setPlaying(false);
                selectSpanAt(Number(event.target.value) - 1, false);
              }}
              aria-label="Path step"
            />
          </label>
        </div>
        {selectedSpan ? (
          <div className="trace-playback__focus" aria-live="polite">
            <span>
              <b>{spanKindLabel[selectedSpan.kind]}</b>
              <strong>{selectedSpan.name}</strong>
            </span>
            <div aria-label="Selected span evidence">
              {selectedSignals.map((signal, index) => (
                <span
                  className={`trace-signal trace-signal--${signal.kind}`}
                  key={`${signal.kind}-${index}`}
                >
                  <TraceSignalIcon kind={signal.kind} />
                  {signal.label}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {reducedMotion ? (
          <p className="trace-playback__motion" role="status">
            Reduced motion is on. Playback uses discrete, static topology
            highlights.
          </p>
        ) : null}
        {selectedSpan &&
        (!hasTopologyReference || unresolvedEntities.length) ? (
          <p className="trace-playback__resolution" role="status">
            <LinkBreak size={13} weight="duotone" aria-hidden="true" />
            {!hasTopologyReference
              ? "No topology entity was sampled for this span. The textual trace remains available."
              : `Topology focus unavailable for ${unresolvedEntities.join(", ")}. The textual trace remains available.`}
          </p>
        ) : null}
      </section>

      {selectedTrace.spans.length === 0 ? (
        <div className="trace-empty" role="status">
          <FlowArrow size={20} weight="duotone" />
          <strong>No spans in this sample</strong>
          <p>The trace was emitted without a sampled span sequence.</p>
        </div>
      ) : null}

      <section className="trace-span-order">
        <header>
          <span>Modeled span sequence</span>
          <small>{selectedTrace.spans.length} sampled spans</small>
        </header>
        <ol role="listbox" aria-label="Modeled span sequence">
          {selectedTrace.spans.map((span, index) => (
            <li key={span.spanId} role="none">
              <button
                ref={(element) => {
                  spanButtonRefs.current[index] = element;
                }}
                type="button"
                role="option"
                aria-selected={selectedSpan?.spanId === span.spanId}
                tabIndex={selectedSpan?.spanId === span.spanId ? 0 : -1}
                className={`trace-span-row trace-span-row--${span.status}`}
                onClick={() => selectSpanAt(index, false)}
                onKeyDown={(event) => handleSpanKeyDown(event, index)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <span>
                  <strong>
                    {spanKindLabel[span.kind]} · {span.name}
                  </strong>
                  <small>
                    {spanRoute(span)}
                    {span.edgeId ? ` · ${span.edgeId}` : ""}
                  </small>
                  <span className="trace-span-row__signals">
                    {traceSpanSignals(span).map((signal, signalIndex) => (
                      <span
                        className={`trace-signal trace-signal--${signal.kind}`}
                        key={`${signal.kind}-${signalIndex}`}
                      >
                        <TraceSignalIcon kind={signal.kind} />
                        {signal.label}
                      </span>
                    ))}
                  </span>
                </span>
                <span>
                  <b>{span.status}</b>
                  <small>{formatTraceNumber(span.latencyMs)} ms</small>
                </span>
              </button>
              {selectedSpan?.spanId === span.spanId ? (
                <TraceSpanDetail
                  span={span}
                  index={index}
                  nodeLabel={nodeLabel}
                />
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      <p className="trace-boundary">
        Representative request-class sample only, capped by the engine. It is
        not an exhaustive request log, captured distributed trace, individual
        request replay, or production telemetry. Pool wait is inferred from
        modeled connection pressure; failure cause is one prioritized modeled
        cause. Message IDs are deterministic lineage, not broker records.
      </p>
    </div>
  );
}

export function TelemetryPanel({
  result,
  liveFrames = [],
  liveEvents = [],
  running = false,
  progress = 0,
  scenario,
  nodes,
  edges = [],
  selectedEventId,
  currentSecond,
  onSelectEvent,
  onSeek,
  onTracePlaybackChange,
}: TelemetryPanelProps) {
  const [resourceMetric, setResourceMetric] =
    useState<ResourceMetric>("cpuUtilization");
  const [visibleSeries, setVisibleSeries] = useState(defaultVisibleSeries);
  const [chartWindow, setChartWindow] = useState<"full" | "30" | "60">("full");
  const [hoverSecond, setHoverSecond] = useState<number | null>(null);
  const [diagnosticView, setDiagnosticView] = useState<DiagnosticView>(() =>
    result?.traces?.length ? "traces" : "resources",
  );
  const frames = result?.frames ?? liveFrames;
  const events = result?.events ?? liveEvents;
  const traces = result?.traces;
  const lastFrameSecond = frames.at(-1)?.second ?? 0;
  const windowSeconds = chartWindow === "full" ? null : Number(chartWindow);
  const chartStartLimit = windowSeconds
    ? Math.max(0, lastFrameSecond - windowSeconds + 1)
    : 0;
  const chartFrames = frames.filter(
    (historyFrame) => historyFrame.second >= chartStartLimit,
  );
  const hoverFrame =
    hoverSecond === null
      ? null
      : frames.reduce<MetricFrame | null>(
          (closest, candidate) =>
            !closest ||
            Math.abs(candidate.second - hoverSecond) <
              Math.abs(closest.second - hoverSecond)
              ? candidate
              : closest,
          null,
        );
  const fallbackEventId = useMemo(
    () =>
      [...events].reverse().find((event) => event.severity === "critical")
        ?.id ??
      events.at(-1)?.id ??
      null,
    [events],
  );
  const activeEventId = selectedEventId ?? fallbackEventId;
  const chain = useMemo(
    () => causalChain(events, activeEventId),
    [activeEventId, events],
  );
  const milestones = useMemo(() => milestoneEvents(events), [events]);
  const visibleRequirements = scenario.requirements.filter(
    (requirement) => requirement.visibility !== "hidden",
  );

  if (!result && frames.length === 0) {
    return (
      <section className="telemetry-panel telemetry-panel--empty">
        <header className="telemetry-empty__heading">
          <span className="panel-index">
            {running ? "04 / LIVE RUN" : "04 / BEFORE RUN"}
          </span>
          <div>
            {running ? (
              <Pulse size={20} weight="duotone" />
            ) : (
              <Info size={20} weight="duotone" />
            )}
            <strong>
              {running
                ? `Preparing modeled output · ${Math.round(progress * 100)}%`
                : "No modeled run yet"}
            </strong>
            <p>
              {running
                ? "The worker is computing this run. Frames and linked events will stream into this panel as they are delivered."
                : "These are planned workload, incident, and objective inputs. Modeled time-series data appears after a local or server run."}
            </p>
          </div>
        </header>
        <section className="telemetry-empty__workload">
          <header>
            <span>Workload</span>
            <strong>{scenario.workload.arrivalPattern ?? "steady"}</strong>
          </header>
          <dl>
            <div>
              <dt>Base</dt>
              <dd>{scenario.workload.baseRps.toLocaleString("en-US")} RPS</dd>
            </div>
            <div>
              <dt>Peak</dt>
              <dd>{scenario.workload.peakRps.toLocaleString("en-US")} RPS</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatSecond(scenario.workload.durationSeconds)}</dd>
            </div>
            <div>
              <dt>Read ratio</dt>
              <dd>{Math.round(scenario.workload.readRatio * 100)}%</dd>
            </div>
          </dl>
          <div
            className="demand-envelope"
            aria-label={`Demand rises from ${scenario.workload.baseRps} to ${scenario.workload.peakRps} requests per second`}
          >
            {[0.38, 0.46, 0.58, 0.72, 1, 0.81, 0.62, 0.49, 0.42].map(
              (ratio, index) => (
                <i
                  key={index}
                  style={{ height: `${Math.max(12, ratio * 100)}%` }}
                />
              ),
            )}
          </div>
        </section>
        <section className="telemetry-empty__incidents">
          <header>
            <span>Incident schedule</span>
            <strong>{scenario.incidents.length} scheduled</strong>
          </header>
          {scenario.incidents.length ? (
            <ol>
              {scenario.incidents.slice(0, 5).map((incident) => (
                <li key={incident.id}>
                  <time>{formatSecond(incident.atSecond)}</time>
                  <span>{incident.label}</span>
                  <small>{incident.kind.replaceAll("-", " ")}</small>
                </li>
              ))}
            </ol>
          ) : (
            <p>No incidents are scheduled for this scenario.</p>
          )}
        </section>
        <section className="telemetry-empty__objectives">
          <header>
            <span>Objectives</span>
            <strong>{visibleRequirements.length} objectives</strong>
          </header>
          {visibleRequirements.length ? (
            <ul>
              {visibleRequirements.slice(0, 5).map((requirement) => (
                <li key={requirement.id}>{requirement.label}</li>
              ))}
            </ul>
          ) : (
            <p>No visible objectives are defined for this role.</p>
          )}
          <p>
            {running
              ? "Request trace sampling is pending and appears only with the completed modeled result."
              : "Run locally to evaluate this architecture. Request traces are sampled, not exhaustive."}
          </p>
        </section>
      </section>
    );
  }

  const frame =
    frames[Math.min(currentSecond, frames.length - 1)] ?? frames.at(-1)!;
  const duration = Math.max(1, frames.length - 1);
  const chartStartSecond = chartFrames[0]?.second ?? 0;
  const chartEndSecond = chartFrames.at(-1)?.second ?? chartStartSecond;
  const chartDuration = Math.max(1, chartEndSecond - chartStartSecond);
  const axisTicks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const summaryFrame = hoverFrame ?? frame;
  const seriesSummary = telemetrySeries.map((series) => ({
    ...series,
    current: series.value(summaryFrame),
    peak: Math.max(...frames.map(series.value), 0),
  }));
  const resourceSeries: ResourceSeries[] = nodes
    .map((node, index) => {
      const values = frames.map(
        (historyFrame) =>
          historyFrame.nodeMetrics[node.id]?.[resourceMetric] ?? 0,
      );
      return {
        id: node.id,
        label: node.name,
        color: resourceColors[index % resourceColors.length]!,
        values,
        current: values[Math.min(currentSecond, values.length - 1)] ?? 0,
      };
    })
    .filter((item) => item.values.some((value) => value > 0))
    .sort((left, right) => right.current - left.current)
    .slice(0, 5);

  return (
    <section
      className="telemetry-panel"
      aria-label="Modeled simulation results"
    >
      <div className="event-log">
        <header>
          <div>
            <span className="panel-index">04 / EVENTS</span>
            <strong>
              {events.length} linked events
              {running ? ` · ${Math.round(progress * 100)}% delivered` : ""}
            </strong>
          </div>
          <time>
            {String(Math.floor(currentSecond / 60)).padStart(2, "0")}:
            {String(currentSecond % 60).padStart(2, "0")}
          </time>
        </header>
        <div className="event-log__list">
          {events.length ? (
            events.map((event) => {
              const Icon =
                event.severity === "critical"
                  ? WarningOctagon
                  : event.severity === "warning"
                    ? Warning
                    : CheckCircle;
              return (
                <button
                  type="button"
                  className={`event-row event-row--${event.severity} ${selectedEventId === event.id ? "selected" : ""}`}
                  key={event.id}
                  onClick={() => {
                    onSelectEvent(event.id);
                    onSeek(event.second);
                  }}
                >
                  <time>{formatSecond(event.second)}</time>
                  <Icon size={14} weight="fill" aria-hidden="true" />
                  <span>{event.title}</span>
                </button>
              );
            })
          ) : (
            <p>No modeled events were emitted for this run.</p>
          )}
        </div>
      </div>

      <div className="telemetry-chart">
        <header className="telemetry-toolbar">
          <div>
            <div className="telemetry-legend" aria-label="Chart series">
              {telemetrySeries.map((series) => (
                <button
                  type="button"
                  className={`legend-${series.id} ${visibleSeries[series.id] ? "active" : ""}`}
                  aria-pressed={visibleSeries[series.id]}
                  key={series.id}
                  onClick={() =>
                    setVisibleSeries((current) => ({
                      ...current,
                      [series.id]: !current[series.id],
                    }))
                  }
                >
                  {series.label} ({series.unit})
                </button>
              ))}
            </div>
            <small className="telemetry-scale-note">
              Separate labeled scale per series · hover for exact values
            </small>
          </div>
          <div className="telemetry-toolbar__right">
            <label className="telemetry-window">
              Window
              <select
                aria-label="Telemetry zoom window"
                value={chartWindow}
                onChange={(event) =>
                  setChartWindow(event.target.value as "full" | "30" | "60")
                }
              >
                <option value="full">Full run</option>
                <option value="60">Last 60 s</option>
                <option value="30">Last 30 s</option>
              </select>
            </label>
            <div className="telemetry-current">
              <span>{hoverFrame ? "Hover" : "Cursor"}</span>
              <strong>{formatSecond(summaryFrame.second)}</strong>
            </div>
          </div>
        </header>
        <dl
          className="telemetry-series-summary"
          aria-label="Current and peak telemetry values"
        >
          {seriesSummary
            .filter((series) => visibleSeries[series.id])
            .map((series) => (
              <div key={series.id} style={{ color: series.color }}>
                <dt>{series.label}</dt>
                <dd>
                  <span>
                    current {Math.round(series.current * 100) / 100}{" "}
                    {series.unit}
                  </span>
                  <span>
                    peak {Math.round(series.peak * 100) / 100} {series.unit}
                  </span>
                </dd>
              </div>
            ))}
        </dl>
        <div className="telemetry-plot">
          <div className="telemetry-axis" aria-hidden="true">
            {axisTicks.map((tick) => (
              <span key={tick}>
                {formatSecond(
                  Math.round(chartStartSecond + chartDuration * tick),
                )}
              </span>
            ))}
          </div>
          <TelemetryCanvas
            frames={chartFrames}
            currentSecond={currentSecond}
            visibleSeries={visibleSeries}
            onHoverSecond={setHoverSecond}
          />
          {hoverFrame &&
          hoverFrame.second >= chartStartSecond &&
          hoverFrame.second <= chartEndSecond ? (
            <div
              className="telemetry-tooltip"
              style={{
                left: `${((hoverFrame.second - chartStartSecond) / chartDuration) * 100}%`,
              }}
              role="status"
            >
              <strong>{formatSecond(hoverFrame.second)}</strong>
              {seriesSummary
                .filter((series) => visibleSeries[series.id])
                .map((series) => (
                  <span key={series.id} style={{ color: series.color }}>
                    {series.label}: {Math.round(series.current * 100) / 100}{" "}
                    {series.unit}
                  </span>
                ))}
            </div>
          ) : null}
          <div className="telemetry-markers" aria-label="Linked event markers">
            {milestones
              .filter(
                (event) =>
                  event.second >= chartStartSecond &&
                  event.second <= chartEndSecond,
              )
              .map((event) => (
                <button
                  type="button"
                  key={event.id}
                  className={`telemetry-marker telemetry-marker--${event.severity} ${selectedEventId === event.id ? "selected" : ""}`}
                  style={{
                    left: `${((event.second - chartStartSecond) / chartDuration) * 100}%`,
                  }}
                  onClick={() => {
                    onSelectEvent(event.id);
                    onSeek(event.second);
                  }}
                  aria-label={`${formatSecond(event.second)} ${event.title}`}
                >
                  <span>{event.title}</span>
                </button>
              ))}
          </div>
        </div>
        <footer className="telemetry-footer">
          <label className="timeline-scrubber">
            <span>00:00</span>
            <input
              type="range"
              min="0"
              max={duration}
              value={currentSecond}
              onChange={(event) => onSeek(Number(event.target.value))}
              aria-label="Simulation time"
            />
            <span>{formatSecond(duration)}</span>
          </label>
          <div className="signal-summary">
            <Pulse size={13} aria-hidden="true" />
            {chain.length ? (
              <span>
                {chain.length} linked events · {chain.at(-1)?.title}
              </span>
            ) : events.length ? (
              <span>Select an event to inspect its linked path</span>
            ) : (
              <span>No linked events in this modeled run</span>
            )}
          </div>
        </footer>
      </div>

      <section
        className={`resource-chart${diagnosticView === "traces" ? " resource-chart--traces" : ""}`}
        aria-label={
          diagnosticView === "resources"
            ? "Resource utilization"
            : "Sampled request traces"
        }
      >
        <header>
          <div>
            <span>Modeled diagnostics</span>
            <small>Aggregate or sampled</small>
          </div>
          <nav className="diagnostic-tabs" aria-label="Diagnostic view">
            <button
              type="button"
              aria-pressed={diagnosticView === "resources"}
              className={diagnosticView === "resources" ? "active" : ""}
              onClick={() => setDiagnosticView("resources")}
            >
              Resources
            </button>
            <button
              type="button"
              aria-pressed={diagnosticView === "traces"}
              className={diagnosticView === "traces" ? "active" : ""}
              onClick={() => setDiagnosticView("traces")}
            >
              Traces{traces?.length ? ` ${traces.length}` : ""}
            </button>
          </nav>
        </header>
        {diagnosticView === "resources" ? (
          <>
            <nav aria-label="Resource metric">
              {resourceMetrics.map((metric) => (
                <button
                  type="button"
                  className={resourceMetric === metric.key ? "active" : ""}
                  aria-pressed={resourceMetric === metric.key}
                  key={metric.key}
                  onClick={() => setResourceMetric(metric.key)}
                >
                  {metric.label}
                </button>
              ))}
            </nav>
            <div className="resource-chart__plot">
              {resourceSeries.length ? (
                <>
                  <div className="resource-chart__axis" aria-hidden="true">
                    <span>100%</span>
                    <span>50%</span>
                    <span>0%</span>
                  </div>
                  <ResourceCanvas series={resourceSeries} />
                </>
              ) : (
                <div className="why-empty" role="status">
                  <Pulse size={20} weight="duotone" />
                  <strong>No modeled utilization</strong>
                  <p>
                    No modeled utilization was recorded for{" "}
                    {resourceMetrics.find(
                      (metric) => metric.key === resourceMetric,
                    )?.label ?? "this metric"}
                    .
                  </p>
                </div>
              )}
            </div>
            <div className="resource-chart__legend">
              {resourceSeries.map((item) => (
                <span key={item.id} style={{ color: item.color }}>
                  <i /> {item.label} <b>{Math.round(item.current * 100)}%</b>
                </span>
              ))}
            </div>
          </>
        ) : (
          <TraceExplorer
            traces={traces}
            completed={result !== null}
            running={running}
            progress={progress}
            nodes={nodes}
            edges={edges}
            onSeek={onSeek}
            onPlaybackChange={onTracePlaybackChange}
          />
        )}
      </section>

      <aside className="causal-rail" aria-label="Linked event path">
        <header>
          <FlowArrow size={14} weight="duotone" /> Linked event path
        </header>
        {chain.length ? (
          <>
            <ol>
              {chain.map((event) => (
                <li
                  className={`causal-rail__event causal-rail__event--${event.severity}`}
                  key={event.id}
                >
                  <span>{formatSecond(event.second)}</span>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectEvent(event.id);
                      onSeek(event.second);
                    }}
                  >
                    {event.title}
                  </button>
                </li>
              ))}
            </ol>
            <div className="causal-root">
              <span>First linked event</span>
              <strong>{chain[0]?.title}</strong>
            </div>
            <section className="run-debrief">
              <span>Modeled run debrief</span>
              {result ? (
                <>
                  <strong>
                    {result.score.total === 0
                      ? "No objectives defined"
                      : result.score.passed === result.score.total
                        ? "All modeled objectives passed"
                        : `${result.score.total - result.score.passed} objectives missed`}
                  </strong>
                  <p>{result.analysis.bottleneckLabel}</p>
                  {result.analysis.risks[0] ? (
                    <small>Risk · {result.analysis.risks[0]}</small>
                  ) : null}
                  {result.analysis.tradeoffs[0] ? (
                    <small>Trade-off · {result.analysis.tradeoffs[0]}</small>
                  ) : null}
                  <b>
                    Next experiment ·{" "}
                    {chain.at(-1)?.recommendations?.[0] ??
                      "Open Compare to test bounded architecture alternatives."}
                  </b>
                </>
              ) : (
                <>
                  <strong>{Math.round(progress * 100)}% delivered</strong>
                  <p>
                    This is streamed playback of a deterministic modeled run.
                    Final objective scoring appears when delivery completes.
                  </p>
                </>
              )}
            </section>
          </>
        ) : (
          <p>
            {events.length
              ? "Select an event to inspect its modeled parent links."
              : "No modeled events were emitted for this run."}
          </p>
        )}
      </aside>
    </section>
  );
}
