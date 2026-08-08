import {
  CheckCircle,
  Cpu,
  FlowArrow,
  Gear,
  HardDrive,
  Lightning,
  Memory,
  Pulse,
  Warning,
  WarningOctagon,
  XCircle,
} from "@phosphor-icons/react";
import type {
  ArchitectureEdge,
  ArchitectureNode,
  CausalEvent,
  MetricFrame,
  NodeMetricSnapshot,
} from "@systemforge/contracts";
import { useEffect, useRef, useState } from "react";

interface InspectorPanelProps {
  node: ArchitectureNode | null;
  edge?: ArchitectureEdge | null;
  metrics: NodeMetricSnapshot | null;
  metricHistory?: NodeMetricSnapshot[];
  globalFrame?: MetricFrame | null;
  allNodes?: ArchitectureNode[];
  event: CausalEvent | null;
  workspaceMode: "build" | "run" | "investigate";
  onUpdateNode: (node: ArchitectureNode) => void;
  onUpdateEdge?: (edge: ArchitectureEdge) => void;
}

type InspectorTab = "overview" | "metrics" | "config" | "why";
type NodeBehavior = NonNullable<ArchitectureNode["config"]["behavior"]>;
type UtilizationMetricKey = keyof Pick<
  NodeMetricSnapshot,
  | "utilization"
  | "cpuUtilization"
  | "memoryUtilization"
  | "connectionUtilization"
  | "iopsUtilization"
  | "networkUtilization"
>;

const diagnostics: Array<{
  key: Exclude<UtilizationMetricKey, "utilization">;
  label: string;
  icon: typeof Cpu;
}> = [
  { key: "cpuUtilization", label: "CPU", icon: Cpu },
  { key: "memoryUtilization", label: "Memory", icon: Memory },
  { key: "connectionUtilization", label: "Connections", icon: FlowArrow },
  { key: "iopsUtilization", label: "IOPS", icon: HardDrive },
  { key: "networkUtilization", label: "Network", icon: Pulse },
];

const stateIcon = (state: NodeMetricSnapshot["state"]) =>
  state === "offline"
    ? XCircle
    : state === "critical"
      ? WarningOctagon
      : state === "warning"
        ? Warning
        : CheckCircle;

const signalTone = (value: number) =>
  value >= 0.9 ? "critical" : value >= 0.7 ? "warning" : "healthy";

const signalColor = (tone: ReturnType<typeof signalTone>) =>
  tone === "critical" ? "#ff604f" : tone === "warning" ? "#f2b84b" : "#75d48a";

const healthScore = (metrics: NodeMetricSnapshot | undefined): number => {
  if (!metrics) return 100;
  const pressure = Math.max(
    metrics.utilization,
    metrics.cpuUtilization,
    metrics.memoryUtilization,
    metrics.connectionUtilization,
    metrics.iopsUtilization,
    metrics.networkUtilization,
  );
  return Math.max(
    0,
    Math.min(100, Math.round(100 - Math.max(0, pressure - 0.45) * 113)),
  );
};

const stateRank = (state: NodeMetricSnapshot["state"]): number =>
  state === "offline"
    ? 4
    : state === "critical"
      ? 3
      : state === "warning"
        ? 2
        : 1;

function InspectorSparkline({
  values,
  tone,
  label,
}: {
  values: number[];
  tone: ReturnType<typeof signalTone>;
  label: string;
}) {
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
    context.strokeStyle = "#263540";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, height - 1);
    context.lineTo(width, height - 1);
    context.stroke();
    if (values.length < 2) return;
    const minimum = Math.min(...values, 0);
    const maximum = Math.max(...values, 1);
    context.strokeStyle = signalColor(tone);
    context.lineWidth = 1.6;
    context.beginPath();
    values.forEach((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * width;
      const y =
        height -
        3 -
        ((value - minimum) / Math.max(0.01, maximum - minimum)) * (height - 7);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }, [tone, values]);

  return (
    <canvas
      className="inspector-sparkline"
      ref={canvasRef}
      aria-label={`${label} history`}
    />
  );
}

export function InspectorPanel({
  node,
  edge = null,
  metrics,
  metricHistory = [],
  globalFrame = null,
  allNodes = [],
  event,
  workspaceMode,
  onUpdateNode,
  onUpdateEdge,
}: InspectorPanelProps) {
  const [tab, setTab] = useState<InspectorTab>("overview");

  useEffect(() => {
    if (workspaceMode === "build") setTab("config");
    if (workspaceMode === "run") setTab("overview");
    if (workspaceMode === "investigate") setTab(event ? "why" : "overview");
  }, [event, workspaceMode]);

  if (!node && edge) {
    const updateEdgeConfig = (patch: NonNullable<ArchitectureEdge["config"]>) =>
      onUpdateEdge?.({
        ...edge,
        config: { ...edge.config, ...patch },
      });
    return (
      <aside className="inspector inspector--edge">
        <header className="inspector__header">
          <div>
            <span className="panel-index">03 / LINK INSPECTOR</span>
            <small>transport contract</small>
            <strong>
              {edge.source} → {edge.target}
            </strong>
          </div>
          <FlowArrow size={20} weight="duotone" />
        </header>
        <div className="inspector__body inspector__fields">
          <header>
            <span>Link behavior</span>
            <small>Bandwidth, delay, loss and routing share</small>
          </header>
          <div className="field-grid">
            <label>
              Bandwidth (Mbps)
              <input
                type="number"
                min="1"
                value={edge.config?.bandwidthMbps ?? 10_000}
                onChange={(event_) =>
                  updateEdgeConfig({
                    bandwidthMbps: Number(event_.target.value),
                  })
                }
              />
            </label>
            <label>
              Base latency (ms)
              <input
                type="number"
                min="0"
                value={edge.config?.baseLatencyMs ?? 0}
                onChange={(event_) =>
                  updateEdgeConfig({
                    baseLatencyMs: Number(event_.target.value),
                  })
                }
              />
            </label>
            <label>
              Jitter (ms)
              <input
                type="number"
                min="0"
                step="0.1"
                value={edge.config?.jitterMs ?? 0}
                onChange={(event_) =>
                  updateEdgeConfig({ jitterMs: Number(event_.target.value) })
                }
              />
            </label>
            <label>
              Packet loss (0–1)
              <input
                type="number"
                min="0"
                max="1"
                step="0.0001"
                value={edge.config?.packetLossRate ?? 0}
                onChange={(event_) =>
                  updateEdgeConfig({
                    packetLossRate: Number(event_.target.value),
                  })
                }
              />
            </label>
            <label>
              Traffic share (0–1)
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={edge.config?.trafficShare ?? 1}
                onChange={(event_) =>
                  updateEdgeConfig({
                    trafficShare: Number(event_.target.value),
                  })
                }
              />
            </label>
          </div>
          <label className="toggle-field">
            <input
              type="checkbox"
              checked={edge.config?.asynchronous ?? false}
              onChange={(event_) =>
                updateEdgeConfig({ asynchronous: event_.target.checked })
              }
            />
            <span>Asynchronous boundary</span>
          </label>
        </div>
      </aside>
    );
  }

  if (!node)
    return (
      <aside className="inspector inspector--empty">
        <span className="panel-index">03 / INSPECTOR</span>
        <Pulse size={28} weight="duotone" />
        <strong>No component selected</strong>
        <p>Select a node or a causal event to open its live evidence.</p>
      </aside>
    );

  const state = metrics?.state ?? "healthy";
  const StateIcon = stateIcon(state);
  const updateConfig = (patch: Partial<ArchitectureNode["config"]>) =>
    onUpdateNode({ ...node, config: { ...node.config, ...patch } });
  const updateNumber = (
    field:
      | "instances"
      | "capacityRps"
      | "baseLatencyMs"
      | "maxConnections"
      | "replicas"
      | "monthlyCostEur"
      | "maxInstances",
    value: number,
  ) => updateConfig({ [field]: value });
  const behavior = node.config.behavior;
  const updateBehavior = <Key extends keyof NodeBehavior>(
    key: Key,
    patch: Partial<NonNullable<NodeBehavior[Key]>>,
  ) =>
    updateConfig({
      behavior: {
        ...behavior,
        [key]: { ...(behavior?.[key] ?? {}), ...patch },
      },
    });
  const computeCapable = node.kind !== "users" && node.kind !== "region";
  const cacheCapable = node.kind === "cache" || node.kind === "cdn";
  const storageCapable =
    node.kind === "database" ||
    node.kind === "object-store" ||
    node.kind === "cache";
  const messagingCapable = node.kind === "queue" || node.kind === "stream";
  const currentHealthScore = healthScore(metrics ?? undefined);
  const healthTone = signalTone(1 - currentHealthScore / 100);
  const impactedNodes = allNodes
    .filter((candidate) => candidate.id !== node.id)
    .map((candidate) => ({
      component: candidate,
      metrics: globalFrame?.nodeMetrics[candidate.id],
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        component: ArchitectureNode;
        metrics: NodeMetricSnapshot;
      } => candidate.metrics !== undefined,
    )
    .sort(
      (left, right) =>
        stateRank(right.metrics.state) - stateRank(left.metrics.state) ||
        right.metrics.utilization - left.metrics.utilization,
    )
    .slice(0, 4);
  const overviewSignals: Array<{
    key: UtilizationMetricKey;
    label: string;
  }> =
    node.kind === "database"
      ? [
          { key: "cpuUtilization", label: "CPU utilization" },
          { key: "iopsUtilization", label: "IOPS" },
          { key: "connectionUtilization", label: "Connections" },
        ]
      : node.kind === "cache"
        ? [
            { key: "memoryUtilization", label: "Memory utilization" },
            { key: "networkUtilization", label: "Network" },
            { key: "connectionUtilization", label: "Connections" },
          ]
        : node.kind === "queue" || node.kind === "stream"
          ? [
              { key: "utilization", label: "Throughput pressure" },
              { key: "memoryUtilization", label: "Memory utilization" },
              { key: "networkUtilization", label: "Network" },
            ]
          : [
              { key: "cpuUtilization", label: "CPU utilization" },
              { key: "memoryUtilization", label: "Memory utilization" },
              { key: "networkUtilization", label: "Network" },
            ];

  return (
    <aside className="inspector">
      <header className="inspector__header">
        <div>
          <span className="panel-index">03 / INSPECTOR</span>
          <small>{node.kind.replaceAll("-", " ")}</small>
          <strong>{node.name}</strong>
        </div>
        <span className={`state-token state-token--${state}`}>
          <StateIcon size={15} weight="fill" aria-hidden="true" /> {state}
        </span>
      </header>
      <nav aria-label="Inspector sections">
        {(["overview", "metrics", "config", "why"] as const).map((item) => (
          <button
            className={tab === item ? "active" : ""}
            type="button"
            key={item}
            onClick={() => setTab(item)}
          >
            {item === "why" ? "Why?" : item}
          </button>
        ))}
      </nav>

      {tab === "overview" ? (
        <div className="inspector__body">
          <section
            className={`inspector-health inspector-health--${healthTone}`}
            aria-label={`Derived health score ${currentHealthScore} out of 100`}
          >
            <header>
              <div>
                <span>Derived health score</span>
                <small>Current resource envelope</small>
              </div>
              <strong>
                {currentHealthScore}
                <small>/100</small>
              </strong>
            </header>
            <InspectorSparkline
              values={metricHistory
                .slice(-72)
                .map((sample) => healthScore(sample) / 100)}
              tone={healthTone}
              label="Derived health score"
            />
          </section>
          <section className="inspector-kpis" aria-label="Live diagnostics">
            {overviewSignals.map(({ key, label }) => {
              const value = metrics?.[key] ?? 0;
              const tone = signalTone(value);
              return (
                <article
                  className={`inspector-kpi inspector-kpi--${tone}`}
                  key={key}
                >
                  <header>
                    <span>{label}</span>
                    <strong>{Math.round(value * 100)}%</strong>
                  </header>
                  <InspectorSparkline
                    values={metricHistory
                      .slice(-72)
                      .map((sample) => sample[key])}
                    tone={tone}
                    label={label}
                  />
                </article>
              );
            })}
          </section>
          <section className="signal-ledger">
            <div>
              <span>p95 latency</span>
              <strong>
                {Math.round(metrics?.latencyMs ?? node.config.baseLatencyMs)} ms
              </strong>
            </div>
            <div>
              <span>p99 latency</span>
              <strong>
                {Math.round(
                  globalFrame?.p99LatencyMs ?? metrics?.latencyMs ?? 0,
                )}{" "}
                ms
              </strong>
            </div>
            <div>
              <span>Error</span>
              <strong>{(metrics?.errorRate ?? 0).toFixed(2)}%</strong>
            </div>
            <div>
              <span>Disk / work queue</span>
              <strong>
                {Math.round(metrics?.queueDepth ?? 0).toLocaleString()}
              </strong>
            </div>
            <div>
              <span>Replica lag</span>
              <strong>{Math.round(metrics?.replicaLagMs ?? 0)} ms</strong>
            </div>
          </section>
          {impactedNodes.length ? (
            <section className="impact-list" aria-label="Top impacted services">
              <header>
                <span>Top impacted services</span>
                <small>Current cursor</small>
              </header>
              {impactedNodes.map(({ component, metrics: itemMetrics }) => (
                <div key={component.id}>
                  <span
                    className={`impact-list__state impact-list__state--${itemMetrics.state}`}
                  />
                  <strong>{component.name}</strong>
                  <small>{Math.round(itemMetrics.utilization * 100)}%</small>
                </div>
              ))}
            </section>
          ) : null}
        </div>
      ) : null}

      {tab === "metrics" ? (
        <div className="inspector__body diagnostic-stack">
          <header>
            <span>Resource banks</span>
            <small>Current timeline cursor</small>
          </header>
          {diagnostics.map(({ key, label, icon: Icon }) => {
            const value = metrics?.[key] ?? 0;
            return (
              <div className="diagnostic-row" key={key}>
                <span>
                  <Icon size={14} /> {label}
                </span>
                <strong>{Math.round(value * 100)}%</strong>
                <span className="diagnostic-track" aria-hidden="true">
                  <span
                    className={
                      value >= 1
                        ? "critical"
                        : value >= 0.72
                          ? "warning"
                          : "healthy"
                    }
                    style={{ width: `${Math.min(100, value * 100)}%` }}
                  />
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {tab === "config" ? (
        <div className="inspector__body inspector__fields">
          <header>
            <span>Capacity envelope</span>
            <small>Changes invalidate the current run</small>
          </header>
          <div className="field-grid">
            <label>
              Instances
              <input
                type="number"
                min="1"
                max="10000"
                value={node.config.instances}
                onChange={(event_) => {
                  const instances = Number(event_.target.value);
                  updateConfig({
                    instances,
                    maxInstances: Math.max(node.config.maxInstances, instances),
                  });
                }}
              />
            </label>
            <label>
              Capacity / instance
              <input
                type="number"
                min="1"
                value={node.config.capacityRps}
                onChange={(event_) =>
                  updateNumber("capacityRps", Number(event_.target.value))
                }
              />
            </label>
            <label>
              Base latency (ms)
              <input
                type="number"
                min="0"
                value={node.config.baseLatencyMs}
                onChange={(event_) =>
                  updateNumber("baseLatencyMs", Number(event_.target.value))
                }
              />
            </label>
            <label>
              Max connections
              <input
                type="number"
                min="1"
                value={node.config.maxConnections}
                onChange={(event_) =>
                  updateNumber("maxConnections", Number(event_.target.value))
                }
              />
            </label>
            <label>
              Replicas
              <input
                type="number"
                min="0"
                max="100"
                value={node.config.replicas}
                onChange={(event_) =>
                  updateNumber("replicas", Number(event_.target.value))
                }
              />
            </label>
            <label>
              Monthly cost / instance
              <input
                type="number"
                min="0"
                value={node.config.monthlyCostEur}
                onChange={(event_) =>
                  updateNumber("monthlyCostEur", Number(event_.target.value))
                }
              />
            </label>
          </div>
          <section className="config-bank">
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={node.config.autoscale}
                onChange={(event_) =>
                  updateConfig({ autoscale: event_.target.checked })
                }
              />
              <span>Autoscaling enabled</span>
            </label>
            {node.config.autoscale ? (
              <label>
                Maximum instances
                <input
                  type="number"
                  min={Math.max(
                    node.config.instances,
                    behavior?.scaling?.minInstances ?? 1,
                  )}
                  value={node.config.maxInstances}
                  onChange={(event_) =>
                    updateNumber("maxInstances", Number(event_.target.value))
                  }
                />
              </label>
            ) : null}
            <label>
              Consistency
              <select
                value={node.config.consistency}
                onChange={(event_) =>
                  updateConfig({
                    consistency: event_.target.value as "strong" | "eventual",
                  })
                }
              >
                <option value="strong">Strong</option>
                <option value="eventual">Eventual</option>
              </select>
            </label>
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={behavior?.resilience?.circuitBreaker ?? false}
                onChange={(event_) =>
                  updateBehavior("resilience", {
                    circuitBreaker: event_.target.checked,
                  })
                }
              />
              <span>Circuit breaker</span>
            </label>
          </section>

          {computeCapable ? (
            <section className="behavior-bank">
              <header>
                <span>Compute model</span>
                <small>Independent saturation dimensions</small>
              </header>
              <div className="field-grid">
                <label>
                  CPU cores
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={behavior?.compute?.cpuCores ?? 4}
                    onChange={(event_) =>
                      updateBehavior("compute", {
                        cpuCores: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Memory (GB)
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={behavior?.compute?.memoryGb ?? 8}
                    onChange={(event_) =>
                      updateBehavior("compute", {
                        memoryGb: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Concurrency / instance
                  <input
                    type="number"
                    min="1"
                    value={behavior?.compute?.concurrencyPerInstance ?? 1000}
                    onChange={(event_) =>
                      updateBehavior("compute", {
                        concurrencyPerInstance: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Service time (ms)
                  <input
                    type="number"
                    min="0"
                    value={behavior?.compute?.serviceTimeMs ?? 5}
                    onChange={(event_) =>
                      updateBehavior("compute", {
                        serviceTimeMs: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  GC pause (ms)
                  <input
                    type="number"
                    min="0"
                    value={behavior?.compute?.gcPauseMs ?? 0}
                    onChange={(event_) =>
                      updateBehavior("compute", {
                        gcPauseMs: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  GC interval (seconds)
                  <input
                    type="number"
                    min="1"
                    value={behavior?.compute?.gcIntervalSeconds ?? 30}
                    onChange={(event_) =>
                      updateBehavior("compute", {
                        gcIntervalSeconds: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Leak (MB / minute)
                  <input
                    type="number"
                    min="0"
                    value={behavior?.compute?.memoryLeakMbPerMinute ?? 0}
                    onChange={(event_) =>
                      updateBehavior("compute", {
                        memoryLeakMbPerMinute: Number(event_.target.value),
                      })
                    }
                  />
                </label>
              </div>
            </section>
          ) : null}

          {computeCapable ? (
            <section className="behavior-bank">
              <header>
                <span>Network model</span>
                <small>Transport and egress</small>
              </header>
              <div className="field-grid">
                <label>
                  Bandwidth (Mbps)
                  <input
                    type="number"
                    min="1"
                    value={behavior?.network?.bandwidthMbps ?? 10000}
                    onChange={(event_) =>
                      updateBehavior("network", {
                        bandwidthMbps: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Round trip (ms)
                  <input
                    type="number"
                    min="0"
                    value={behavior?.network?.rttMs ?? 2}
                    onChange={(event_) =>
                      updateBehavior("network", {
                        rttMs: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Jitter (ms)
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={behavior?.network?.jitterMs ?? 0}
                    onChange={(event_) =>
                      updateBehavior("network", {
                        jitterMs: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Packet loss (0–1)
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.0001"
                    value={behavior?.network?.packetLossRate ?? 0}
                    onChange={(event_) =>
                      updateBehavior("network", {
                        packetLossRate: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Egress / GB (EUR)
                  <input
                    type="number"
                    min="0"
                    step="0.001"
                    value={behavior?.network?.egressCostPerGb ?? 0}
                    onChange={(event_) =>
                      updateBehavior("network", {
                        egressCostPerGb: Number(event_.target.value),
                      })
                    }
                  />
                </label>
              </div>
            </section>
          ) : null}

          {cacheCapable ? (
            <section className="behavior-bank">
              <header>
                <span>Cache policy</span>
                <small>Hit quality and recovery</small>
              </header>
              <div className="field-grid">
                <label>
                  Capacity (GB)
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={behavior?.cache?.capacityGb ?? 32}
                    onChange={(event_) =>
                      updateBehavior("cache", {
                        capacityGb: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Baseline hit rate (0–1)
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={node.config.cacheHitRate}
                    onChange={(event_) =>
                      updateConfig({
                        cacheHitRate: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  TTL (seconds)
                  <input
                    type="number"
                    min="0"
                    value={behavior?.cache?.ttlSeconds ?? 300}
                    onChange={(event_) =>
                      updateBehavior("cache", {
                        ttlSeconds: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Eviction policy
                  <select
                    value={behavior?.cache?.evictionPolicy ?? "lru"}
                    onChange={(event_) =>
                      updateBehavior("cache", {
                        evictionPolicy: event_.target.value as
                          "lru" | "lfu" | "fifo" | "random",
                      })
                    }
                  >
                    <option value="lru">LRU</option>
                    <option value="lfu">LFU</option>
                    <option value="fifo">FIFO</option>
                    <option value="random">Random</option>
                  </select>
                </label>
                <label>
                  Hot-key share (0–1)
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={behavior?.cache?.hotKeyFraction ?? 0}
                    onChange={(event_) =>
                      updateBehavior("cache", {
                        hotKeyFraction: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Warmup (seconds)
                  <input
                    type="number"
                    min="0"
                    value={behavior?.cache?.warmupSeconds ?? 0}
                    onChange={(event_) =>
                      updateBehavior("cache", {
                        warmupSeconds: Number(event_.target.value),
                      })
                    }
                  />
                </label>
              </div>
            </section>
          ) : null}

          {storageCapable ? (
            <section className="behavior-bank">
              <header>
                <span>Storage and replication</span>
                <small>IOPS, partitions, durability</small>
              </header>
              <div className="field-grid">
                <label>
                  Read IOPS
                  <input
                    type="number"
                    min="1"
                    value={behavior?.storage?.readIops ?? 50000}
                    onChange={(event_) =>
                      updateBehavior("storage", {
                        readIops: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Write IOPS
                  <input
                    type="number"
                    min="1"
                    value={behavior?.storage?.writeIops ?? 30000}
                    onChange={(event_) =>
                      updateBehavior("storage", {
                        writeIops: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Disk Mbps
                  <input
                    type="number"
                    min="1"
                    value={behavior?.storage?.diskThroughputMbps ?? 1000}
                    onChange={(event_) =>
                      updateBehavior("storage", {
                        diskThroughputMbps: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Buffer hit (0–1)
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={behavior?.storage?.bufferHitRate ?? 0.8}
                    onChange={(event_) =>
                      updateBehavior("storage", {
                        bufferHitRate: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Lock contention (0–1)
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={behavior?.storage?.lockContention ?? 0}
                    onChange={(event_) =>
                      updateBehavior("storage", {
                        lockContention: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Partitions
                  <input
                    type="number"
                    min="1"
                    value={behavior?.storage?.partitions ?? 1}
                    onChange={(event_) =>
                      updateBehavior("storage", {
                        partitions: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Hot partition (0–1)
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={behavior?.storage?.hotPartitionFraction ?? 0}
                    onChange={(event_) =>
                      updateBehavior("storage", {
                        hotPartitionFraction: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Replication
                  <select
                    value={behavior?.storage?.replicationMode ?? "none"}
                    onChange={(event_) =>
                      updateBehavior("storage", {
                        replicationMode: event_.target.value as
                          "none" | "async" | "sync" | "quorum",
                      })
                    }
                  >
                    <option value="none">None</option>
                    <option value="async">Asynchronous</option>
                    <option value="sync">Synchronous</option>
                    <option value="quorum">Quorum</option>
                  </select>
                </label>
                <label>
                  Replica lag (ms)
                  <input
                    type="number"
                    min="0"
                    value={behavior?.storage?.replicationLagMs ?? 0}
                    onChange={(event_) =>
                      updateBehavior("storage", {
                        replicationLagMs: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Failover (seconds)
                  <input
                    type="number"
                    min="0"
                    value={behavior?.storage?.failoverSeconds ?? 0}
                    onChange={(event_) =>
                      updateBehavior("storage", {
                        failoverSeconds: Number(event_.target.value),
                      })
                    }
                  />
                </label>
              </div>
            </section>
          ) : null}

          {messagingCapable ? (
            <section className="behavior-bank">
              <header>
                <span>Messaging semantics</span>
                <small>Delivery, poison, retention</small>
              </header>
              <div className="field-grid">
                <label>
                  Partitions
                  <input
                    type="number"
                    min="1"
                    value={behavior?.messaging?.partitions ?? 1}
                    onChange={(event_) =>
                      updateBehavior("messaging", {
                        partitions: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Delivery
                  <select
                    value={behavior?.messaging?.delivery ?? "at-least-once"}
                    onChange={(event_) =>
                      updateBehavior("messaging", {
                        delivery: event_.target.value as
                          "at-most-once" | "at-least-once" | "exactly-once",
                      })
                    }
                  >
                    <option value="at-most-once">At most once</option>
                    <option value="at-least-once">At least once</option>
                    <option value="exactly-once">Exactly once</option>
                  </select>
                </label>
                <label>
                  Retention (hours)
                  <input
                    type="number"
                    min="0"
                    value={behavior?.messaging?.retentionHours ?? 24}
                    onChange={(event_) =>
                      updateBehavior("messaging", {
                        retentionHours: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Poison rate (0–1)
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.001"
                    value={behavior?.messaging?.poisonMessageRate ?? 0}
                    onChange={(event_) =>
                      updateBehavior("messaging", {
                        poisonMessageRate: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Batch size
                  <input
                    type="number"
                    min="1"
                    value={behavior?.messaging?.batchSize ?? 1}
                    onChange={(event_) =>
                      updateBehavior("messaging", {
                        batchSize: Number(event_.target.value),
                      })
                    }
                  />
                </label>
              </div>
            </section>
          ) : null}

          {computeCapable ? (
            <section className="behavior-bank">
              <header>
                <span>Resilience policy</span>
                <small>Timeout and overload behavior</small>
              </header>
              <div className="field-grid">
                <label>
                  Timeout (ms)
                  <input
                    type="number"
                    min="1"
                    value={behavior?.resilience?.timeoutMs ?? 800}
                    onChange={(event_) =>
                      updateBehavior("resilience", {
                        timeoutMs: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Maximum retries
                  <input
                    type="number"
                    min="0"
                    max="12"
                    value={behavior?.resilience?.maxRetries ?? 0}
                    onChange={(event_) =>
                      updateBehavior("resilience", {
                        maxRetries: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Backoff base (ms)
                  <input
                    type="number"
                    min="0"
                    value={behavior?.resilience?.backoffBaseMs ?? 0}
                    onChange={(event_) =>
                      updateBehavior("resilience", {
                        backoffBaseMs: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Load-shed threshold
                  <input
                    type="number"
                    min="0.1"
                    max="10"
                    step="0.01"
                    value={behavior?.resilience?.loadSheddingThreshold ?? 1}
                    onChange={(event_) =>
                      updateBehavior("resilience", {
                        loadSheddingThreshold: Number(event_.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <label className="toggle-field">
                <input
                  type="checkbox"
                  checked={behavior?.resilience?.jitter ?? false}
                  onChange={(event_) =>
                    updateBehavior("resilience", {
                      jitter: event_.target.checked,
                    })
                  }
                />
                <span>Retry jitter</span>
              </label>
              <label className="toggle-field">
                <input
                  type="checkbox"
                  checked={behavior?.resilience?.bulkhead ?? false}
                  onChange={(event_) =>
                    updateBehavior("resilience", {
                      bulkhead: event_.target.checked,
                    })
                  }
                />
                <span>Bulkhead isolation</span>
              </label>
            </section>
          ) : null}

          {node.config.autoscale ? (
            <section className="behavior-bank">
              <header>
                <span>Scaling dynamics</span>
                <small>Delay is part of the model</small>
              </header>
              <div className="field-grid">
                <label>
                  Minimum instances
                  <input
                    type="number"
                    min="1"
                    max={node.config.maxInstances}
                    value={behavior?.scaling?.minInstances ?? 1}
                    onChange={(event_) =>
                      updateBehavior("scaling", {
                        minInstances: Math.min(
                          node.config.maxInstances,
                          Number(event_.target.value),
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Target utilization
                  <input
                    type="number"
                    min="0.1"
                    max="1"
                    step="0.01"
                    value={behavior?.scaling?.targetUtilization ?? 0.7}
                    onChange={(event_) =>
                      updateBehavior("scaling", {
                        targetUtilization: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Cooldown (seconds)
                  <input
                    type="number"
                    min="0"
                    value={behavior?.scaling?.cooldownSeconds ?? 0}
                    onChange={(event_) =>
                      updateBehavior("scaling", {
                        cooldownSeconds: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Startup (seconds)
                  <input
                    type="number"
                    min="0"
                    value={behavior?.scaling?.startupSeconds ?? 0}
                    onChange={(event_) =>
                      updateBehavior("scaling", {
                        startupSeconds: Number(event_.target.value),
                      })
                    }
                  />
                </label>
              </div>
            </section>
          ) : null}

          <section className="behavior-bank">
            <header>
              <span>Placement and operations</span>
              <small>Residency, blast radius, toil</small>
            </header>
            <div className="field-grid">
              <label>
                Region
                <input
                  value={behavior?.topology?.region ?? ""}
                  placeholder="EU"
                  onChange={(event_) =>
                    updateBehavior("topology", { region: event_.target.value })
                  }
                />
              </label>
              <label>
                Zone
                <input
                  value={behavior?.topology?.zone ?? ""}
                  placeholder="multi-az"
                  onChange={(event_) =>
                    updateBehavior("topology", { zone: event_.target.value })
                  }
                />
              </label>
              <label>
                Data residency
                <input
                  value={behavior?.topology?.dataResidency ?? ""}
                  placeholder="EU"
                  onChange={(event_) =>
                    updateBehavior("topology", {
                      dataResidency: event_.target.value,
                    })
                  }
                />
              </label>
              <label>
                Failure domain
                <input
                  value={behavior?.topology?.failureDomain ?? ""}
                  placeholder="service"
                  onChange={(event_) =>
                    updateBehavior("topology", {
                      failureDomain: event_.target.value,
                    })
                  }
                />
              </label>
              <label>
                Complexity weight
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={behavior?.operations?.complexityWeight ?? 1}
                  onChange={(event_) =>
                    updateBehavior("operations", {
                      complexityWeight: Number(event_.target.value),
                    })
                  }
                />
              </label>
            </div>
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={behavior?.operations?.managed ?? false}
                onChange={(event_) =>
                  updateBehavior("operations", {
                    managed: event_.target.checked,
                  })
                }
              />
              <span>Managed service</span>
            </label>
          </section>
        </div>
      ) : null}

      {tab === "why" ? (
        <div className="inspector__body why-panel">
          {event ? (
            <>
              <span
                className={`event-severity event-severity--${event.severity}`}
              >
                <Lightning size={14} weight="fill" /> {event.severity} event
              </span>
              <strong>{event.title}</strong>
              <p>{event.detail}</p>
              <section>
                <span>Direct causes</span>
                <p>
                  {event.parentIds.length
                    ? event.parentIds.join(" → ")
                    : "Root scenario event"}
                </p>
              </section>
              {event.effects?.length ? (
                <section>
                  <span>Measured effects</span>
                  {event.effects.map((effect) => (
                    <div
                      className="effect-row"
                      key={`${effect.metric}-${effect.label}`}
                    >
                      <small>{effect.metric}</small>
                      <strong>{effect.label}</strong>
                    </div>
                  ))}
                </section>
              ) : null}
              {event.recommendations?.length ? (
                <section>
                  <span>Design levers</span>
                  <ul>
                    {event.recommendations.map((recommendation) => (
                      <li key={recommendation}>{recommendation}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          ) : (
            <div className="why-empty">
              <Gear size={25} />
              <strong>Select an event to reconstruct its cause.</strong>
              <p>
                The timeline will connect the initiating event, pressure shift
                and downstream failure.
              </p>
            </div>
          )}
        </div>
      ) : null}
    </aside>
  );
}
