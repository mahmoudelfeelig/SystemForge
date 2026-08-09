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
import {
  componentOwnsState,
  componentUsesReadConsistency,
} from "@systemforge/contracts";
import type {
  ArchitectureEdge,
  ArchitectureNode,
  CausalEvent,
  EdgeMetricSnapshot,
  MetricFrame,
  NodeMetricSnapshot,
} from "@systemforge/contracts";
import {
  applyBehavioralProfile,
  behavioralProfileEvidenceForNode,
  compatibleBehavioralProfiles,
  getBehavioralProfile,
} from "@systemforge/sim-core";
import { useEffect, useRef, useState } from "react";

interface InspectorPanelProps {
  node: ArchitectureNode | null;
  edge?: ArchitectureEdge | null;
  edgeMetrics?: EdgeMetricSnapshot | null;
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

const healthScore = (metrics: NodeMetricSnapshot): number => {
  const pressure = Math.max(
    metrics.utilization,
    metrics.cpuUtilization,
    metrics.memoryUtilization,
    metrics.connectionUtilization,
    metrics.iopsUtilization,
    metrics.networkUtilization,
  );
  const resourceScore = Math.max(
    0,
    Math.min(100, Math.round(100 - Math.max(0, pressure - 0.45) * 113)),
  );
  const deliveryScore = Math.max(0, Math.round(100 - metrics.errorRate));
  return metrics.state === "offline"
    ? 0
    : Math.min(resourceScore, deliveryScore);
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
  edgeMetrics = null,
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
          <section
            className="edge-telemetry"
            aria-label="Modeled link telemetry"
          >
            <header>
              <span>Modeled at cursor</span>
              <small>{edgeMetrics ? "one-second aggregate" : "not run"}</small>
            </header>
            {edgeMetrics ? (
              <dl>
                <div>
                  <dt>Attempted</dt>
                  <dd>
                    {Math.round(edgeMetrics.attemptedRps).toLocaleString()} RPS
                  </dd>
                </div>
                <div>
                  <dt>Delivered</dt>
                  <dd>
                    {Math.round(edgeMetrics.throughputRps).toLocaleString()} RPS
                  </dd>
                </div>
                <div>
                  <dt>Retries</dt>
                  <dd>
                    {Math.round(edgeMetrics.retryRps).toLocaleString()} RPS
                  </dd>
                </div>
                <div>
                  <dt>Lost</dt>
                  <dd>
                    {Math.round(edgeMetrics.lostRps).toLocaleString()} RPS
                  </dd>
                </div>
                <div>
                  <dt>Loss</dt>
                  <dd>{edgeMetrics.packetLossPercent.toFixed(3)}%</dd>
                </div>
                <div>
                  <dt>Path latency</dt>
                  <dd>{edgeMetrics.latencyMs.toFixed(2)} ms</dd>
                </div>
              </dl>
            ) : (
              <p>
                Run the model to inspect throughput, retries, loss, and delay.
              </p>
            )}
          </section>
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
                disabled={workspaceMode !== "build"}
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
                disabled={workspaceMode !== "build"}
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
                disabled={workspaceMode !== "build"}
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
                disabled={workspaceMode !== "build"}
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
                disabled={workspaceMode !== "build"}
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
              disabled={workspaceMode !== "build"}
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
        <p>Select a node or linked event to inspect its modeled results.</p>
      </aside>
    );

  const state = metrics?.state ?? "not-run";
  const StateIcon = metrics ? stateIcon(metrics.state) : Pulse;
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
  const profileReference = node.config.behavioralProfile;
  const compatibleProfiles = compatibleBehavioralProfiles(node.kind);
  const referencedProfile = profileReference
    ? getBehavioralProfile(profileReference.id)
    : undefined;
  const resolvedProfile =
    referencedProfile &&
    referencedProfile.version === profileReference?.version &&
    referencedProfile.compatibleKinds.includes(node.kind)
      ? referencedProfile
      : undefined;
  const profileEvidence = resolvedProfile
    ? behavioralProfileEvidenceForNode(node)
    : null;
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
  const resolvedReplicationMode =
    behavior?.storage?.replicationMode ??
    (node.config.replicas > 0 ? "async" : "none");
  const updateReplicas = (replicas: number) =>
    updateConfig({
      replicas,
      behavior: {
        ...behavior,
        storage: {
          ...(behavior?.storage ?? {}),
          replicationMode:
            replicas === 0
              ? "none"
              : resolvedReplicationMode === "none"
                ? "async"
                : resolvedReplicationMode,
        },
      },
    });
  const updateReplicationMode = (
    replicationMode: "none" | "async" | "sync" | "quorum",
  ) =>
    updateConfig({
      replicas:
        replicationMode === "none" ? 0 : Math.max(1, node.config.replicas),
      behavior: {
        ...behavior,
        storage: { ...(behavior?.storage ?? {}), replicationMode },
      },
    });
  const computeCapable = node.kind !== "users" && node.kind !== "region";
  const cacheCapable = node.kind === "cache" || node.kind === "cdn";
  const storageCapable =
    node.kind === "database" || node.kind === "object-store";
  const replicationCapable = componentOwnsState(node.kind);
  const consistencyCapable = componentUsesReadConsistency(node.kind);
  const replicaLagCapable = storageCapable;
  const messagingCapable = node.kind === "queue" || node.kind === "stream";
  const currentHealthScore = metrics ? healthScore(metrics) : null;
  const healthTone =
    currentHealthScore === null
      ? null
      : signalTone(1 - currentHealthScore / 100);
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
        <span
          className={`state-token state-token--${state}`}
          style={
            metrics
              ? undefined
              : { borderColor: "var(--muted)", color: "var(--muted)" }
          }
        >
          <StateIcon
            size={15}
            weight={metrics ? "fill" : "regular"}
            aria-hidden="true"
          />{" "}
          {metrics ? state : "not run"}
        </span>
      </header>
      <nav aria-label="Inspector sections">
        {(["overview", "metrics", "config", "why"] as const).map((item) => (
          <button
            className={tab === item ? "active" : ""}
            type="button"
            key={item}
            aria-pressed={tab === item}
            onClick={() => setTab(item)}
          >
            {item === "why" ? "Events" : item}
          </button>
        ))}
      </nav>

      {tab === "overview" ? (
        <div className="inspector__body">
          <section
            className={`inspector-health${healthTone ? ` inspector-health--${healthTone}` : ""}`}
            aria-label={
              currentHealthScore === null
                ? "Modeled health score unavailable; run not started"
                : `Modeled health score ${currentHealthScore} out of 100`
            }
            style={
              currentHealthScore === null
                ? { borderLeftColor: "var(--muted)" }
                : undefined
            }
          >
            <header>
              <div>
                <span>Modeled health score</span>
                <small>
                  {currentHealthScore === null
                    ? "Run required"
                    : "Current modeled resource envelope"}
                </small>
              </div>
              <strong
                style={
                  currentHealthScore === null
                    ? { color: "var(--muted)" }
                    : undefined
                }
              >
                {currentHealthScore ?? "—"}
                {currentHealthScore === null ? null : <small>/100</small>}
              </strong>
            </header>
            <InspectorSparkline
              values={
                metrics
                  ? metricHistory
                      .slice(-72)
                      .map((sample) => healthScore(sample) / 100)
                  : []
              }
              tone={healthTone ?? "healthy"}
              label={
                currentHealthScore === null
                  ? "No modeled health history"
                  : "Modeled health score"
              }
            />
          </section>
          <section className="inspector-kpis" aria-label="Modeled diagnostics">
            {overviewSignals.map(({ key, label }) => {
              const value = metrics?.[key];
              const tone = value === undefined ? null : signalTone(value);
              return (
                <article
                  className={`inspector-kpi${tone ? ` inspector-kpi--${tone}` : ""}`}
                  key={key}
                  style={
                    value === undefined
                      ? { borderLeft: "2px solid var(--dim)" }
                      : undefined
                  }
                >
                  <header>
                    <span>{label}</span>
                    <strong
                      style={
                        value === undefined
                          ? { color: "var(--muted)" }
                          : undefined
                      }
                    >
                      {value === undefined
                        ? "—"
                        : `${Math.round(value * 100)}%`}
                    </strong>
                  </header>
                  <InspectorSparkline
                    values={
                      metrics
                        ? metricHistory.slice(-72).map((sample) => sample[key])
                        : []
                    }
                    tone={tone ?? "healthy"}
                    label={
                      value === undefined
                        ? `${label}, no modeled history`
                        : label
                    }
                  />
                </article>
              );
            })}
          </section>
          <section className="signal-ledger">
            <div>
              <span>p95 latency</span>
              <strong>
                {metrics ? `${Math.round(metrics.latencyMs)} ms` : "—"}
              </strong>
            </div>
            <div>
              <span>System p99 latency</span>
              <strong>
                {globalFrame
                  ? `${Math.round(globalFrame.p99LatencyMs)} ms`
                  : "—"}
              </strong>
            </div>
            <div>
              <span>Error</span>
              <strong>
                {metrics ? `${metrics.errorRate.toFixed(2)}%` : "—"}
              </strong>
            </div>
            <div>
              <span>Disk / work queue</span>
              <strong>
                {metrics
                  ? Math.round(metrics.queueDepth).toLocaleString()
                  : "—"}
              </strong>
            </div>
            {replicaLagCapable ? (
              <div>
                <span>Replica lag</span>
                <strong>
                  {metrics ? `${Math.round(metrics.replicaLagMs)} ms` : "—"}
                </strong>
              </div>
            ) : null}
          </section>
          {impactedNodes.length ? (
            <section className="impact-list" aria-label="Top impacted services">
              <header>
                <span>Top impacted services</span>
                <small>Modeled cursor</small>
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
            <span>Modeled resource banks</span>
            <small>
              {metrics ? "Current timeline cursor" : "Run required"}
            </small>
          </header>
          {metrics ? (
            diagnostics.map(({ key, label, icon: Icon }) => {
              const value = metrics[key];
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
            })
          ) : (
            <div className="why-empty">
              <Pulse size={25} />
              <strong>No modeled resource utilization</strong>
              <p>
                Run a simulation to populate utilization and pressure at the
                timeline cursor.
              </p>
            </div>
          )}
        </div>
      ) : null}

      {tab === "config" ? (
        <div className="inspector__body inspector__fields">
          <section
            className="edge-telemetry behavioral-profile-control"
            aria-label="Behavioral profile"
          >
            <header>
              <span>Behavioral profile</span>
              <small>versioned primitive defaults</small>
            </header>
            <label>
              Compatible profile
              <select
                aria-label="Compatible behavioral profile"
                value={
                  resolvedProfile
                    ? resolvedProfile.id
                    : profileReference
                      ? "__unresolved__"
                      : ""
                }
                onChange={(event_) => {
                  if (!event_.target.value) {
                    const nextNode = structuredClone(node);
                    delete nextNode.config.behavioralProfile;
                    onUpdateNode(nextNode);
                    return;
                  }
                  if (event_.target.value === "__unresolved__") return;
                  const selected = getBehavioralProfile(event_.target.value);
                  if (!selected) return;
                  onUpdateNode(
                    applyBehavioralProfile(node, selected.id, selected.version),
                  );
                }}
              >
                <option value="">Custom / unprofiled</option>
                {profileReference && !resolvedProfile ? (
                  <option value="__unresolved__" disabled>
                    Unresolved {profileReference.id}@{profileReference.version}
                  </option>
                ) : null}
                {compatibleProfiles.map((profile) => (
                  <option value={profile.id} key={profile.id}>
                    {profile.label} · v{profile.version}
                  </option>
                ))}
              </select>
            </label>
            {resolvedProfile && profileEvidence?.status === "resolved" ? (
              <>
                <dl>
                  <div>
                    <dt>Family</dt>
                    <dd>{resolvedProfile.family}</dd>
                  </div>
                  <div>
                    <dt>Provider</dt>
                    <dd>{resolvedProfile.provider}</dd>
                  </div>
                  <div>
                    <dt>Variant</dt>
                    <dd>{resolvedProfile.variant}</dd>
                  </div>
                  <div>
                    <dt>Local overrides</dt>
                    <dd>
                      {profileEvidence.localOverrides
                        ? `${profileEvidence.overriddenFields.length} controlled field${profileEvidence.overriddenFields.length === 1 ? "" : "s"}`
                        : "None"}
                    </dd>
                  </div>
                </dl>
                <p>{resolvedProfile.summary}</p>
                <details>
                  <summary>Assumptions and provenance</summary>
                  <ul>
                    {resolvedProfile.assumptions.map((assumption) => (
                      <li key={assumption}>{assumption}</li>
                    ))}
                  </ul>
                  {profileEvidence.localOverrides ? (
                    <p>
                      Overridden profile fields:{" "}
                      {profileEvidence.overriddenFields
                        .map((field) => field.replace(/^config\./, ""))
                        .join(", ")}
                    </p>
                  ) : null}
                  <ul>
                    {resolvedProfile.provenance.map((entry) => (
                      <li key={entry.url}>
                        <a href={entry.url} target="_blank" rel="noreferrer">
                          {entry.publisher} · {entry.title}
                        </a>{" "}
                        (retrieved {entry.retrievedOn})
                      </li>
                    ))}
                  </ul>
                </details>
              </>
            ) : profileReference ? (
              <p role="alert">
                This profile reference is unknown, incompatible, or uses an
                unsupported version. Simulation will reject it until a
                compatible registry entry is applied.
              </p>
            ) : (
              <p>
                Profiles write validated compute, storage, cache, messaging,
                resilience, and operations primitives. They are modeling
                assumptions, not benchmarks or provider guarantees.
              </p>
            )}
          </section>
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
            {replicationCapable ? (
              <label>
                Replicas
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={node.config.replicas}
                  onChange={(event_) =>
                    updateReplicas(Number(event_.target.value))
                  }
                />
              </label>
            ) : null}
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
            {consistencyCapable ? (
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
            ) : null}
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
                    value={resolvedReplicationMode}
                    onChange={(event_) =>
                      updateReplicationMode(
                        event_.target.value as
                          "none" | "async" | "sync" | "quorum",
                      )
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
                    value={
                      behavior?.storage?.replicationLagMs ??
                      (resolvedReplicationMode === "none"
                        ? 0
                        : resolvedReplicationMode === "async"
                          ? 90
                          : 8)
                    }
                    onChange={(event_) =>
                      updateBehavior("storage", {
                        replicationLagMs: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Failover override (seconds)
                  <input
                    type="number"
                    min="0"
                    placeholder="Model default"
                    value={behavior?.storage?.failoverSeconds ?? ""}
                    onChange={(event_) =>
                      updateBehavior("storage", {
                        failoverSeconds:
                          event_.target.value === ""
                            ? undefined
                            : Number(event_.target.value),
                      })
                    }
                  />
                </label>
              </div>
            </section>
          ) : null}

          {replicationCapable && !storageCapable ? (
            <section className="behavior-bank">
              <header>
                <span>State replication</span>
                <small>Failure tolerance and modeled recovery</small>
              </header>
              <div className="field-grid">
                <label>
                  Replication
                  <select
                    value={resolvedReplicationMode}
                    onChange={(event_) =>
                      updateReplicationMode(
                        event_.target.value as
                          "none" | "async" | "sync" | "quorum",
                      )
                    }
                  >
                    <option value="none">None</option>
                    <option value="async">Asynchronous</option>
                    <option value="sync">Synchronous</option>
                    <option value="quorum">Quorum</option>
                  </select>
                </label>
                <label>
                  Failover override (seconds)
                  <input
                    type="number"
                    min="0"
                    placeholder="Model default"
                    value={behavior?.storage?.failoverSeconds ?? ""}
                    onChange={(event_) =>
                      updateBehavior("storage", {
                        failoverSeconds:
                          event_.target.value === ""
                            ? undefined
                            : Number(event_.target.value),
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
                <label>
                  Log read IOPS
                  <input
                    type="number"
                    min="1"
                    value={
                      behavior?.storage?.readIops ?? node.config.capacityRps
                    }
                    onChange={(event_) =>
                      updateBehavior("storage", {
                        readIops: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Log write IOPS
                  <input
                    type="number"
                    min="1"
                    value={
                      behavior?.storage?.writeIops ??
                      node.config.capacityRps * 0.6
                    }
                    onChange={(event_) =>
                      updateBehavior("storage", {
                        writeIops: Number(event_.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Log disk Mbps
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
                    max={node.config.instances}
                    value={behavior?.scaling?.minInstances ?? 1}
                    onChange={(event_) =>
                      updateBehavior("scaling", {
                        minInstances: Math.min(
                          node.config.instances,
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
                <span>Linked parent events</span>
                <p>
                  {event.parentIds.length
                    ? event.parentIds.join(" → ")
                    : "No parent event (scheduled root)"}
                </p>
              </section>
              {event.effects?.length ? (
                <section>
                  <span>Modeled effects</span>
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
              <strong>No linked event selected.</strong>
              <p>
                Run a simulation, then select an emitted event to inspect its
                modeled parent links and effects.
              </p>
            </div>
          )}
        </div>
      ) : null}
    </aside>
  );
}
