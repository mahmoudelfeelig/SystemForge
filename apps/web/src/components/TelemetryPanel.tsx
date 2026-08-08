import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle,
  FlowArrow,
  Info,
  Pulse,
  Warning,
  WarningOctagon,
} from "@phosphor-icons/react";
import type {
  ArchitectureNode,
  CausalEvent,
  NodeMetricSnapshot,
  Scenario,
  SimulationResult,
} from "@systemforge/contracts";

interface TelemetryPanelProps {
  result: SimulationResult | null;
  scenario: Scenario;
  nodes: ArchitectureNode[];
  selectedEventId: string | null;
  currentSecond: number;
  onSelectEvent: (id: string) => void;
  onSeek: (second: number) => void;
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
  result,
  currentSecond,
}: {
  result: SimulationResult;
  currentSecond: number;
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
      const frames = result.frames;
      const series = [
        {
          values: frames.map((frame) => frame.rps),
          maximum: Math.max(...frames.map((frame) => frame.rps), 1),
          color: "#45d9ff",
        },
        {
          values: frames.map((frame) => frame.p95LatencyMs),
          maximum: Math.max(...frames.map((frame) => frame.p95LatencyMs), 1),
          color: "#ffc857",
        },
        {
          values: frames.map((frame) => frame.errorRate),
          maximum: Math.max(...frames.map((frame) => frame.errorRate), 1),
          color: "#ff5d4a",
        },
        {
          values: frames.map((frame) => frame.queueDepth),
          maximum: Math.max(...frames.map((frame) => frame.queueDepth), 1),
          color: "#b6ef5b",
        },
      ];
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
      const cursorX =
        (currentSecond / Math.max(1, result.frames.length - 1)) * width;
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
  }, [currentSecond, result]);

  return (
    <canvas
      ref={canvasRef}
      className="telemetry-canvas"
      aria-label="Traffic, latency, error-rate and queue-depth telemetry chart"
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

export function TelemetryPanel({
  result,
  scenario,
  nodes,
  selectedEventId,
  currentSecond,
  onSelectEvent,
  onSeek,
}: TelemetryPanelProps) {
  const [resourceMetric, setResourceMetric] =
    useState<ResourceMetric>("cpuUtilization");
  const fallbackEventId = useMemo(
    () =>
      [...(result?.events ?? [])]
        .reverse()
        .find((event) => event.severity === "critical")?.id ??
      result?.events.at(-1)?.id ??
      null,
    [result],
  );
  const activeEventId = selectedEventId ?? fallbackEventId;
  const chain = useMemo(
    () => causalChain(result?.events ?? [], activeEventId),
    [activeEventId, result],
  );
  const milestones = useMemo(
    () => milestoneEvents(result?.events ?? []),
    [result],
  );

  if (!result) {
    return (
      <section className="telemetry-panel telemetry-panel--empty">
        <header className="telemetry-empty__heading">
          <span className="panel-index">04 / PRE-RUN ENVELOPE</span>
          <div>
            <Info size={20} weight="duotone" />
            <strong>Telemetry is armed</strong>
            <p>
              The mission contract is visible before execution; measured traces
              appear only after a browser-local or canonical run.
            </p>
          </div>
        </header>
        <section className="telemetry-empty__workload">
          <header>
            <span>Demand envelope</span>
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
            <strong>{scenario.incidents.length} armed</strong>
          </header>
          <ol>
            {scenario.incidents.slice(0, 5).map((incident) => (
              <li key={incident.id}>
                <time>{formatSecond(incident.atSecond)}</time>
                <span>{incident.label}</span>
                <small>{incident.kind.replaceAll("-", " ")}</small>
              </li>
            ))}
          </ol>
        </section>
        <section className="telemetry-empty__objectives">
          <header>
            <span>Success envelope</span>
            <strong>{scenario.requirements.length} objectives</strong>
          </header>
          <ul>
            {scenario.requirements
              .filter((requirement) => requirement.visibility !== "hidden")
              .slice(0, 5)
              .map((requirement) => (
                <li key={requirement.id}>{requirement.label}</li>
              ))}
          </ul>
          <p>
            Run locally to convert this plan into measured modeled evidence.
          </p>
        </section>
      </section>
    );
  }

  const frame =
    result.frames[Math.min(currentSecond, result.frames.length - 1)] ??
    result.frames.at(-1)!;
  const duration = Math.max(1, result.frames.length - 1);
  const axisTicks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const resourceSeries: ResourceSeries[] = nodes
    .map((node, index) => {
      const values = result.frames.map(
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
    <section className="telemetry-panel" aria-label="Simulation telemetry">
      <div className="event-log">
        <header>
          <div>
            <span className="panel-index">04 / EVENTS</span>
            <strong>{result.events.length} causal changes</strong>
          </div>
          <time>
            {String(Math.floor(currentSecond / 60)).padStart(2, "0")}:
            {String(currentSecond % 60).padStart(2, "0")}
          </time>
        </header>
        <div className="event-log__list">
          {result.events.map((event) => {
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
          })}
        </div>
      </div>

      <div className="telemetry-chart">
        <header className="telemetry-toolbar">
          <div className="telemetry-legend" aria-hidden="true">
            <span className="legend-rps">RPS</span>
            <span className="legend-latency">Latency p95</span>
            <span className="legend-error">Error rate</span>
            <span className="legend-queue">Queue depth</span>
          </div>
          <div className="telemetry-current">
            <span>Cursor</span>
            <strong>{formatSecond(currentSecond)}</strong>
            <small>{Math.round(frame.rps).toLocaleString()} RPS</small>
          </div>
        </header>
        <div className="telemetry-plot">
          <div className="telemetry-axis" aria-hidden="true">
            {axisTicks.map((tick) => (
              <span key={tick}>
                {formatSecond(Math.round(duration * tick))}
              </span>
            ))}
          </div>
          <TelemetryCanvas result={result} currentSecond={currentSecond} />
          <div className="telemetry-markers" aria-label="Incident markers">
            {milestones.map((event) => (
              <button
                type="button"
                key={event.id}
                className={`telemetry-marker telemetry-marker--${event.severity} ${selectedEventId === event.id ? "selected" : ""}`}
                style={{ left: `${(event.second / duration) * 100}%` }}
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
                {chain.length} linked signals · {chain.at(-1)?.title}
              </span>
            ) : (
              <span>Select an event to isolate its causal path</span>
            )}
          </div>
        </footer>
      </div>

      <section className="resource-chart" aria-label="Resource utilization">
        <header>
          <div>
            <span>Resource utilization</span>
            <small>Per component</small>
          </div>
          <span>Chart</span>
        </header>
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
          <div className="resource-chart__axis" aria-hidden="true">
            <span>100%</span>
            <span>50%</span>
            <span>0%</span>
          </div>
          <ResourceCanvas series={resourceSeries} />
        </div>
        <div className="resource-chart__legend">
          {resourceSeries.map((item) => (
            <span key={item.id} style={{ color: item.color }}>
              <i /> {item.label} <b>{Math.round(item.current * 100)}%</b>
            </span>
          ))}
        </div>
      </section>

      <aside className="causal-rail" aria-label="Causal path analysis">
        <header>
          <FlowArrow size={14} weight="duotone" /> Causal path analysis
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
              <span>Root signal</span>
              <strong>{chain[0]?.title}</strong>
            </div>
            <section className="run-debrief">
              <span>Run debrief</span>
              <strong>
                {result.score.passed === result.score.total
                  ? "Mission envelope held"
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
            </section>
          </>
        ) : (
          <p>Select an event to isolate the evidence chain.</p>
        )}
      </aside>
    </section>
  );
}
