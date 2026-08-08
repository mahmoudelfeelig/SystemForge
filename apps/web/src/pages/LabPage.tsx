import {
  ArrowLeft,
  ArrowSquareOut,
  CheckCircle,
  CloudArrowUp,
  Copy,
  Crosshair,
  MagnifyingGlass,
  Pause,
  Play,
  Plus,
  Pulse,
  Scales,
  SlidersHorizontal,
  Trash,
  Warning,
  WarningOctagon,
} from "@phosphor-icons/react";
import {
  METRIC_NAMES,
  type ArchitectureEdge,
  type ArchitectureNode,
  type CausalEvent,
  type NodeMetricSnapshot,
  type Requirement,
} from "@systemforge/contracts";
import {
  addEdge,
  Controls,
  MarkerType,
  ReactFlow,
  type Connection,
  type Edge,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ComponentNode,
  type SystemFlowNode,
} from "../components/ComponentNode";
import { BrandIcon } from "../components/BrandIcon";
import { COMPONENT_ICONS } from "../components/componentIcons";
import { CommandPalette } from "../components/CommandPalette";
import { DecisionWorkbench } from "../components/DecisionWorkbench";
import { InspectorPanel } from "../components/InspectorPanel";
import { ServiceBanner } from "../components/ServiceBanner";
import { TelemetryPanel } from "../components/TelemetryPanel";
import { encodeLocalShare, scenarioForLocalShare } from "../lib/share";
import { useLabStore, type WorkspaceMode } from "../store/useLabStore";

const nodeTypes = { system: ComponentNode };

const nodeDimensions = (
  kind: ArchitectureNode["kind"],
): { width: number; height: number } => {
  if (kind === "users") return { width: 142, height: 112 };
  if (kind === "database") return { width: 220, height: 118 };
  if (kind === "cache") return { width: 190, height: 116 };
  if (kind === "load-balancer") return { width: 176, height: 112 };
  if (kind === "api") return { width: 176, height: 112 };
  if (kind === "queue") return { width: 180, height: 112 };
  if (kind === "worker") return { width: 170, height: 112 };
  return { width: 158, height: 112 };
};

const metricLabel = (metric: Requirement["metric"]) =>
  metric
    .replaceAll(/([A-Z])/g, " $1")
    .replace(/^./, (character) => character.toUpperCase());

export const candidateRequirementsEnabled = (
  scenario: {
    mode: string;
    interview?: { allowCandidateRequirements: boolean };
  },
  role: "participant" | "interviewer",
) =>
  scenario.mode === "interview" &&
  role !== "interviewer" &&
  scenario.interview?.allowCandidateRequirements === true;

interface DerivedRequirementEditorProps {
  requirement: Requirement;
  onChange: (requirement: Requirement) => void;
  onRemove: (id: string) => void;
}

export function DerivedRequirementEditor({
  requirement,
  onChange,
  onRemove,
}: DerivedRequirementEditorProps) {
  const patch = (change: Partial<Requirement>) =>
    onChange({ ...requirement, ...change });

  return (
    <fieldset className="derived-requirement">
      <legend>Candidate constraint</legend>
      <label className="derived-requirement__label">
        Requirement
        <input
          aria-label="Derived requirement"
          value={requirement.label}
          maxLength={160}
          onChange={(event) => patch({ label: event.target.value })}
        />
      </label>
      <label>
        Signal
        <select
          aria-label="Derived requirement metric"
          value={requirement.metric}
          onChange={(event) =>
            patch({ metric: event.target.value as Requirement["metric"] })
          }
        >
          {METRIC_NAMES.map((metric) => (
            <option value={metric} key={metric}>
              {metricLabel(metric)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Rule
        <select
          aria-label="Derived requirement operator"
          value={requirement.operator}
          onChange={(event) =>
            patch({ operator: event.target.value as Requirement["operator"] })
          }
        >
          <option value="lte">at most</option>
          <option value="gte">at least</option>
          <option value="eq">exactly</option>
        </select>
      </label>
      <label>
        Target
        <input
          aria-label="Derived requirement target"
          type="number"
          step="any"
          value={requirement.target}
          onChange={(event) => patch({ target: Number(event.target.value) })}
        />
      </label>
      <label>
        Unit
        <input
          aria-label="Derived requirement unit"
          value={requirement.unit}
          maxLength={24}
          onChange={(event) => patch({ unit: event.target.value })}
        />
      </label>
      <button
        type="button"
        aria-label={`Remove ${requirement.label}`}
        onClick={() => onRemove(requirement.id)}
      >
        <Trash size={13} /> Remove
      </button>
    </fieldset>
  );
}

const paletteGroups: Array<{
  label: string;
  items: Array<{ kind: ArchitectureNode["kind"]; name: string }>;
}> = [
  {
    label: "Client edge",
    items: [
      { kind: "users", name: "Users" },
      { kind: "cdn", name: "CDN" },
    ],
  },
  {
    label: "Compute & routing",
    items: [
      { kind: "load-balancer", name: "Load balancer" },
      { kind: "api", name: "API service" },
      { kind: "worker", name: "Worker pool" },
      { kind: "third-party", name: "Third-party API" },
    ],
  },
  {
    label: "State & messaging",
    items: [
      { kind: "cache", name: "Redis cache" },
      { kind: "database", name: "Durable store" },
      { kind: "queue", name: "Message queue" },
      { kind: "stream", name: "Event stream" },
      { kind: "object-store", name: "Object store" },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { kind: "network", name: "Network link" },
      { kind: "dns", name: "DNS" },
      { kind: "region", name: "Region" },
    ],
  },
];

const paletteMetric = (
  component: ArchitectureNode | undefined,
  metrics: NodeMetricSnapshot | undefined,
  throughputRps: number,
): string => {
  if (!component) return "not placed";
  if (component.kind === "users")
    return `${Math.round(throughputRps).toLocaleString()} RPS`;
  if (component.kind === "cache" || component.kind === "cdn")
    return `${Math.round(component.config.cacheHitRate * 100)}% hit`;
  if (component.kind === "queue" || component.kind === "stream")
    return `${Math.round(metrics?.queueDepth ?? 0).toLocaleString()} queued`;
  if (component.kind === "database")
    return `${Math.round((metrics?.iopsUtilization ?? 0) * 100)}% IOPS`;
  if (component.kind === "network")
    return `${Math.round((metrics?.networkUtilization ?? 0) * 100)}% net`;
  return `${Math.round((metrics?.utilization ?? 0) * 100)}% load`;
};

const newNode = (
  kind: ArchitectureNode["kind"],
  name: string,
  index: number,
): ArchitectureNode => {
  const stateful =
    kind === "database" ||
    kind === "cache" ||
    kind === "queue" ||
    kind === "stream" ||
    kind === "object-store";
  const elastic = kind === "api" || kind === "worker";
  return {
    id: `${kind}-${Date.now()}`,
    kind,
    name,
    position: {
      x: 180 + (index % 4) * 185,
      y: 90 + Math.floor(index / 4) * 130,
    },
    config: {
      instances: 1,
      capacityRps:
        kind === "database"
          ? 25_000
          : kind === "cache"
            ? 40_000
            : kind === "network" || kind === "cdn"
              ? 150_000
              : 8_000,
      baseLatencyMs: kind === "database" ? 24 : kind === "cache" ? 3 : 12,
      maxConnections: 10_000,
      cacheHitRate: kind === "cache" ? 0.8 : 0,
      replicas: stateful ? 2 : 0,
      monthlyCostEur: 1_000,
      autoscale: elastic,
      maxInstances: elastic ? 8 : 1,
      consistency:
        kind === "queue" || kind === "stream" || kind === "cache"
          ? "eventual"
          : "strong",
      behavior: {
        compute: {
          cpuCores: 4,
          memoryGb: 8,
          concurrencyPerInstance: 5_000,
          serviceTimeMs: 8,
        },
        network: {
          bandwidthMbps: 10_000,
          rttMs: kind === "network" ? 25 : 2,
          jitterMs: 1,
          packetLossRate: 0.000_1,
        },
        storage: stateful
          ? {
              readIops: 50_000,
              writeIops: 30_000,
              partitions: 8,
              replicationMode: "async",
              replicationLagMs: 80,
              failoverSeconds: 20,
            }
          : undefined,
        messaging:
          kind === "queue" || kind === "stream"
            ? {
                partitions: 12,
                delivery: "at-least-once",
                retentionHours: 24,
                batchSize: 100,
              }
            : undefined,
        resilience: {
          timeoutMs: 800,
          maxRetries: 2,
          backoffBaseMs: 120,
          jitter: true,
          circuitBreaker: kind === "api" || kind === "third-party",
          loadSheddingThreshold: elastic ? 0.9 : undefined,
        },
        scaling: elastic
          ? {
              minInstances: 1,
              targetUtilization: 0.68,
              cooldownSeconds: 15,
              startupSeconds: 8,
            }
          : undefined,
        topology: { region: "EU", zone: "multi-az" },
        operations: { complexityWeight: stateful ? 5 : 3, managed: false },
      },
    },
  };
};

const causalEntityIds = (
  events: CausalEvent[],
  selectedEventId: string | null,
): Set<string> => {
  const byId = new Map(events.map((event) => [event.id, event]));
  const selected = selectedEventId ? byId.get(selectedEventId) : undefined;
  const ids = new Set<string>();
  const visited = new Set<string>();
  const visit = (event: CausalEvent | undefined) => {
    if (!event || visited.has(event.id)) return;
    visited.add(event.id);
    if (event.entityId) ids.add(event.entityId);
    event.parentIds.forEach((parentId) => visit(byId.get(parentId)));
  };
  visit(selected);
  return ids;
};

export function LabPage() {
  const scenario = useLabStore((state) => state.scenario);
  const architecture = useLabStore((state) => state.architecture);
  const result = useLabStore((state) => state.result);
  const runState = useLabStore((state) => state.runState);
  const selectedNodeId = useLabStore((state) => state.selectedNodeId);
  const selectedEventId = useLabStore((state) => state.selectedEventId);
  const workspaceMode = useLabStore((state) => state.workspaceMode);
  const availability = useLabStore((state) => state.apiAvailability);
  const role = useLabStore((state) => state.role);
  const notice = useLabStore((state) => state.notice);
  const canonicalRunStatus = useLabStore((state) => state.canonicalRunStatus);
  const sharedScenarioId = useLabStore((state) => state.sharedScenarioId);
  const revealState = useLabStore((state) => state.revealState);
  const hydrate = useLabStore((state) => state.hydrate);
  const setArchitecture = useLabStore((state) => state.setArchitecture);
  const selectNode = useLabStore((state) => state.setSelectedNodeId);
  const selectEvent = useLabStore((state) => state.setSelectedEventId);
  const setWorkspaceMode = useLabStore((state) => state.setWorkspaceMode);
  const checkService = useLabStore((state) => state.checkService);
  const runLocal = useLabStore((state) => state.runLocal);
  const submitCanonical = useLabStore((state) => state.submitCanonical);
  const updateRequirement = useLabStore((state) => state.updateRequirement);
  const removeRequirement = useLabStore((state) => state.removeRequirement);
  const refreshSharedScenario = useLabStore(
    (state) => state.refreshSharedScenario,
  );
  const setInterviewReveal = useLabStore((state) => state.setInterviewReveal);
  const dismissNotice = useLabStore((state) => state.dismissNotice);
  const [paletteFilter, setPaletteFilter] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [cursorSecond, setCursorSecond] = useState(0);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

  useEffect(() => {
    hydrate();
    void checkService();
  }, [checkService, hydrate]);

  useEffect(() => {
    if (result) setCursorSecond(result.frames.length - 1);
  }, [result]);

  useEffect(() => {
    const density = localStorage.getItem("systemforge:density");
    document.documentElement.dataset.systemforgeDensity =
      density === "comfortable" ? "comfortable" : "compact";
    const openDecisionWorkbench = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDecisionOpen(true);
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", openDecisionWorkbench);
    return () => window.removeEventListener("keydown", openDecisionWorkbench);
  }, []);

  useEffect(() => {
    if (
      !sharedScenarioId ||
      role === "interviewer" ||
      scenario.mode !== "interview" ||
      scenario.interview?.revealPolicy !== "interviewer-controlled"
    )
      return;
    const interval = window.setInterval(
      () => void refreshSharedScenario(),
      6_000,
    );
    return () => window.clearInterval(interval);
  }, [
    refreshSharedScenario,
    role,
    scenario.interview?.revealPolicy,
    scenario.mode,
    sharedScenarioId,
  ]);

  const frame = result?.frames[cursorSecond] ?? result?.frames.at(-1) ?? null;
  const causalIds = useMemo(
    () => causalEntityIds(result?.events ?? [], selectedEventId),
    [result, selectedEventId],
  );
  const flowNodes = useMemo<SystemFlowNode[]>(
    () =>
      architecture.nodes.map((component) => {
        const dimensions = nodeDimensions(component.kind);
        return {
          id: component.id,
          type: "system",
          position: component.position,
          initialWidth: dimensions.width,
          initialHeight: dimensions.height,
          selected: component.id === selectedNodeId,
          data: {
            component,
            metrics: frame?.nodeMetrics[component.id],
            causalFocus: causalIds.has(component.id),
            throughputRps: frame?.rps,
            history: (result?.frames ?? [])
              .slice(-72)
              .map(
                (historyFrame) =>
                  historyFrame.nodeMetrics[component.id]?.utilization ?? 0,
              ),
            detail:
              component.kind === "queue" || component.kind === "stream"
                ? `${Math.round(frame?.nodeMetrics[component.id]?.queueDepth ?? 0)} queued`
                : `${Math.round(component.config.capacityRps / 1_000)}k req/s cap`,
          },
        };
      }),
    [architecture.nodes, causalIds, frame, result, selectedNodeId],
  );
  const flowEdges = useMemo<Edge[]>(
    () =>
      architecture.edges.map((edge) => {
        const isCausal =
          causalIds.has(edge.source) || causalIds.has(edge.target);
        const states = [
          frame?.nodeMetrics[edge.source]?.state,
          frame?.nodeMetrics[edge.target]?.state,
        ];
        const healthState = !result
          ? "neutral"
          : states.some((state) => state === "critical" || state === "offline")
            ? "critical"
            : states.some((state) => state === "warning")
              ? "warning"
              : "healthy";
        const edgeColor = isCausal
          ? "#f19745"
          : healthState === "critical"
            ? "#ff604f"
            : healthState === "warning"
              ? "#f2bf4b"
              : healthState === "healthy"
                ? "#75d48a"
                : "#71838d";
        return {
          ...edge,
          selected: edge.id === selectedEdgeId,
          animated: Boolean(result) && workspaceMode !== "build",
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 12,
            height: 12,
            color: edgeColor,
          },
          className: `system-edge system-edge--state-${healthState} ${isCausal ? "system-edge--causal" : ""}`,
        };
      }),
    [
      architecture.edges,
      causalIds,
      frame,
      result,
      selectedEdgeId,
      workspaceMode,
    ],
  );
  const selectedNode =
    architecture.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge =
    architecture.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const selectedEvent =
    result?.events.find((event) => event.id === selectedEventId) ?? null;
  const globalHealthState = !result
    ? "armed"
    : Object.values(frame?.nodeMetrics ?? {}).some(
          (metrics) =>
            metrics.state === "critical" || metrics.state === "offline",
        )
      ? "critical"
      : Object.values(frame?.nodeMetrics ?? {}).some(
            (metrics) => metrics.state === "warning",
          )
        ? "warning"
        : "healthy";
  const visibleGroups = paletteGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        item.name.toLowerCase().includes(paletteFilter.toLowerCase()),
      ),
    }))
    .filter((group) => group.items.length > 0);

  const onNodesChange = useCallback(
    (changes: NodeChange<SystemFlowNode>[]) => {
      const positions = new Map(
        changes.flatMap((change) =>
          change.type === "position" && change.position
            ? [[change.id, change.position] as const]
            : [],
        ),
      );
      if (positions.size === 0) return;
      setArchitecture({
        ...architecture,
        nodes: architecture.nodes.map((node) => ({
          ...node,
          position: positions.get(node.id) ?? node.position,
        })),
      });
    },
    [architecture, setArchitecture],
  );
  const onConnect = useCallback(
    (connection: Connection) => {
      if (workspaceMode !== "build" || flowEdges.length >= 2_000) return;
      const edges = addEdge(connection, flowEdges).map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      }));
      setArchitecture({ ...architecture, edges });
    },
    [architecture, flowEdges, setArchitecture, workspaceMode],
  );
  const updateNode = (nextNode: ArchitectureNode) =>
    setArchitecture({
      ...architecture,
      nodes: architecture.nodes.map((node) =>
        node.id === nextNode.id ? nextNode : node,
      ),
    });
  const updateEdge = (nextEdge: ArchitectureEdge) =>
    setArchitecture({
      ...architecture,
      edges: architecture.edges.map((edge) =>
        edge.id === nextEdge.id ? nextEdge : edge,
      ),
    });
  const addComponent = (kind: ArchitectureNode["kind"], name: string) => {
    if (architecture.nodes.length >= 500) return;
    const component = newNode(kind, name, architecture.nodes.length);
    setArchitecture({
      ...architecture,
      nodes: [...architecture.nodes, component],
    });
    setSelectedEdgeId(null);
    selectNode(component.id);
  };
  const addDerivedRequirement = () => {
    const requirement: Requirement = {
      id: `derived-${crypto.randomUUID()}`,
      label: "State the requirement you inferred",
      metric: "p95LatencyMs",
      operator: "lte",
      target: 400,
      unit: "ms",
      visibility: "derived",
      owner: "candidate",
    };
    updateRequirement(requirement);
  };
  const copyLocalShare = async () => {
    const sharedScenario = scenarioForLocalShare(scenario, role);
    const url = `${window.location.origin}/lab#share=${encodeLocalShare({ scenario: sharedScenario, architecture, role })}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  const handleSelectEvent = (id: string) => {
    const event = result?.events.find((candidate) => candidate.id === id);
    selectEvent(id);
    setWorkspaceMode("investigate");
    setSelectedEdgeId(null);
    if (event?.entityId) selectNode(event.entityId);
    if (event) setCursorSecond(event.second);
  };

  const modeIcon = (mode: WorkspaceMode) =>
    mode === "build" ? (
      <Plus size={14} />
    ) : mode === "run" ? (
      <Play size={14} />
    ) : (
      <Crosshair size={14} />
    );

  return (
    <div className="lab-shell">
      <header
        className="lab-header"
        inert={decisionOpen || commandOpen ? true : undefined}
      >
        <Link to="/" className="lab-brand">
          <ArrowLeft className="lab-brand__back" size={14} />
          <BrandIcon className="lab-brand__mark" />
          <div>
            <strong>SystemForge Lab</strong>
            <small>Mission control</small>
          </div>
        </Link>
        <div className="scenario-title">
          <span>
            {scenario.mode}
            {role === "interviewer" ? " · interviewer" : ""}
          </span>
          <strong>{scenario.title}</strong>
        </div>
        <nav className="workspace-modes" aria-label="Workspace mode">
          {(["build", "run", "investigate"] as const).map((mode, index) => (
            <button
              className={workspaceMode === mode ? "active" : ""}
              type="button"
              key={mode}
              onClick={() => setWorkspaceMode(mode)}
              aria-pressed={workspaceMode === mode}
            >
              <small>0{index + 2}</small>
              {modeIcon(mode)} {mode}
            </button>
          ))}
        </nav>
        <div className="simulation-actions">
          <span
            className={`simulation-run-state simulation-run-state--${runState}`}
          >
            {runState === "complete" ? "trace ready" : runState}
          </span>
          <span className="simulation-clock">
            {String(Math.floor(cursorSecond / 60)).padStart(2, "0")}:
            {String(cursorSecond % 60).padStart(2, "0")}
          </span>
          <span className={`service-state service-state--${availability}`}>
            {availability === "offline" ? "release locked" : availability}
          </span>
          <span className={`global-health global-health--${globalHealthState}`}>
            <small>Global</small>
            <strong>{globalHealthState}</strong>
          </span>
          {scenario.mode === "interview" ? (
            <span className={`reveal-state reveal-state--${revealState}`}>
              criteria {revealState}
            </span>
          ) : null}
          <span className="seed">Seed {scenario.seed}</span>
          <button
            className="icon-button"
            type="button"
            onClick={() => void copyLocalShare()}
            aria-label="Copy local share link"
          >
            <Copy size={16} />
            {copied ? <span>Copied</span> : null}
          </button>
          <button
            className="icon-button command-trigger"
            type="button"
            onClick={() => setCommandOpen(true)}
            aria-label="Open command palette"
            aria-keyshortcuts="Control+Shift+P Meta+Shift+P"
          >
            <MagnifyingGlass size={16} />
          </button>
          <button
            className="decision-trigger"
            type="button"
            onClick={() => setDecisionOpen(true)}
            aria-keyshortcuts="Control+K Meta+K"
          >
            <Scales size={15} /> Compare
            <kbd>⌘K</kbd>
          </button>
          <button
            className="button button--run"
            type="button"
            disabled={runState === "running"}
            onClick={() => void runLocal()}
          >
            {runState === "running" ? (
              <Pause size={16} />
            ) : (
              <Play size={16} weight="fill" />
            )}
            {runState === "running" ? "Simulating" : "Run local"}
          </button>
          <button
            className="button button--canonical"
            type="button"
            disabled={
              availability !== "online" ||
              canonicalRunStatus === "queued" ||
              canonicalRunStatus === "running"
            }
            onClick={() => void submitCanonical()}
          >
            <CloudArrowUp size={16} />
            {canonicalRunStatus === "queued" || canonicalRunStatus === "running"
              ? canonicalRunStatus
              : canonicalRunStatus === "completed"
                ? "Verified"
                : "Canonical"}
          </button>
          <span className="requirements-score">
            SCORE{" "}
            <strong>
              {result?.score.passed ?? 0}/
              {result?.score.total ?? scenario.requirements.length}
            </strong>
          </span>
        </div>
      </header>
      <ServiceBanner
        availability={availability}
        notice={notice}
        onDismiss={dismissNotice}
      />
      <DecisionWorkbench
        open={decisionOpen}
        onClose={() => setDecisionOpen(false)}
      />
      <CommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        onOpenDecisionWorkbench={() => setDecisionOpen(true)}
      />
      <main
        className="lab-grid"
        inert={decisionOpen || commandOpen ? true : undefined}
      >
        <aside className="component-palette">
          <header>
            <div>
              <span className="panel-index">01 / COMPONENTS</span>
              <strong>System primitives</strong>
            </div>
            <SlidersHorizontal size={15} />
          </header>
          <label className="palette-search">
            <MagnifyingGlass size={14} />
            <input
              aria-label="Filter system primitives"
              value={paletteFilter}
              onChange={(event) => setPaletteFilter(event.target.value)}
              placeholder="Filter primitives"
            />
          </label>
          <div className="palette-list">
            {visibleGroups.map((group) => (
              <section key={group.label}>
                <header>{group.label}</header>
                {group.items.map((item) => {
                  const Icon = COMPONENT_ICONS[item.kind];
                  const matchingNode = architecture.nodes.find(
                    (node) => node.kind === item.kind,
                  );
                  const matchingMetrics = matchingNode
                    ? frame?.nodeMetrics[matchingNode.id]
                    : undefined;
                  const itemState = matchingMetrics?.state ?? "idle";
                  const disabled =
                    workspaceMode === "build"
                      ? architecture.nodes.length >= 500
                      : !matchingNode;
                  return (
                    <button
                      type="button"
                      key={item.name}
                      className={`palette-item palette-item--${itemState}`}
                      onClick={() => {
                        if (workspaceMode === "build") {
                          addComponent(item.kind, item.name);
                          return;
                        }
                        if (matchingNode) {
                          setSelectedEdgeId(null);
                          selectNode(matchingNode.id);
                        }
                      }}
                      disabled={disabled}
                    >
                      <Icon size={15} weight="duotone" />
                      <span className="palette-item__name">{item.name}</span>
                      <small>
                        {paletteMetric(
                          matchingNode,
                          matchingMetrics,
                          frame?.rps ?? scenario.workload.baseRps,
                        )}
                      </small>
                      {workspaceMode === "build" ? (
                        <Plus size={13} />
                      ) : (
                        <span
                          className={`palette-item__state palette-item__state--${itemState}`}
                          aria-label={itemState}
                        />
                      )}
                    </button>
                  );
                })}
              </section>
            ))}
          </div>
          <section className="requirements-list">
            <header>
              <div>
                <span className="panel-index">02 / CONSTRAINTS</span>
                <strong>
                  {scenario.mode === "interview" && role !== "interviewer"
                    ? "Derived requirements"
                    : "Mission objectives"}
                </strong>
              </div>
              <span>{scenario.requirements.length}</span>
            </header>
            {scenario.requirements
              .filter(
                (requirement) =>
                  role === "interviewer" || requirement.visibility !== "hidden",
              )
              .map((requirement) => {
                const outcome = result?.requirements.find(
                  (candidate) => candidate.requirement.id === requirement.id,
                );
                const Icon = !outcome
                  ? Warning
                  : outcome.passed
                    ? CheckCircle
                    : WarningOctagon;
                const candidateEditable =
                  scenario.mode === "interview" &&
                  role !== "interviewer" &&
                  requirement.visibility === "derived" &&
                  requirement.owner === "candidate";
                return candidateEditable ? (
                  <DerivedRequirementEditor
                    key={requirement.id}
                    requirement={requirement}
                    onChange={updateRequirement}
                    onRemove={removeRequirement}
                  />
                ) : (
                  <div
                    key={requirement.id}
                    className={
                      outcome?.passed
                        ? "passed"
                        : outcome
                          ? "failed"
                          : "pending"
                    }
                  >
                    <Icon size={14} weight={outcome ? "fill" : "regular"} />
                    <span>{requirement.label}</span>
                    {outcome ? (
                      <small>
                        {Math.round(outcome.actual * 100) / 100}{" "}
                        {requirement.unit}
                      </small>
                    ) : null}
                  </div>
                );
              })}
            {candidateRequirementsEnabled(scenario, role) ? (
              <button
                className="add-derived"
                type="button"
                onClick={addDerivedRequirement}
                disabled={scenario.requirements.length >= 40}
              >
                <Plus size={14} /> Record inferred requirement
              </button>
            ) : null}
            {scenario.mode === "interview" && role === "interviewer" ? (
              <div className="reveal-control">
                {scenario.interview?.revealPolicy ===
                "interviewer-controlled" ? (
                  <button
                    type="button"
                    disabled={!sharedScenarioId || availability !== "online"}
                    onClick={() =>
                      void setInterviewReveal(revealState !== "revealed")
                    }
                  >
                    {revealState === "revealed"
                      ? "Conceal candidate criteria"
                      : "Reveal criteria to candidate"}
                  </button>
                ) : (
                  <span>
                    {scenario.interview?.revealPolicy === "after-run"
                      ? "Criteria reveal after the candidate's first run."
                      : "Criteria remain private for the entire session."}
                  </span>
                )}
                {!sharedScenarioId ? (
                  <small>
                    Canonical session required for synchronized reveal.
                  </small>
                ) : null}
              </div>
            ) : null}
          </section>
          <footer>
            {scenario.mode === "interview" && role !== "interviewer" ? (
              <span>Candidate contract · authoring locked</span>
            ) : (
              <Link
                to={scenario.mode === "interview" ? "/interview" : "/custom"}
              >
                <ArrowSquareOut size={14} /> Edit scenario dossier
              </Link>
            )}
          </footer>
        </aside>

        <section
          className="architecture-workspace"
          aria-label="Architecture canvas"
        >
          <header className="canvas-command-strip">
            <div>
              <span className="panel-index">02 / LIVE TOPOLOGY</span>
              <strong>{architecture.name}</strong>
            </div>
            <div className="canvas-signal">
              <Pulse size={15} weight="bold" />
              <span>
                {workspaceMode === "build"
                  ? "Topology editable"
                  : "Signal path active"}
              </span>
            </div>
            <dl>
              <div>
                <dt>RPS</dt>
                <dd>{Math.round(frame?.rps ?? 0).toLocaleString()}</dd>
              </div>
              <div>
                <dt>p95</dt>
                <dd>{Math.round(frame?.p95LatencyMs ?? 0)} ms</dd>
              </div>
              <div>
                <dt>Availability</dt>
                <dd>{(frame?.availability ?? 100).toFixed(3)}%</dd>
              </div>
            </dl>
          </header>
          <ReactFlow<SystemFlowNode, Edge>
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => {
              setSelectedEdgeId(null);
              selectNode(node.id);
            }}
            onEdgeClick={(_, edge) => {
              selectNode(null);
              setSelectedEdgeId(edge.id);
            }}
            onPaneClick={() => {
              selectNode(null);
              setSelectedEdgeId(null);
            }}
            nodesDraggable={workspaceMode === "build"}
            nodesConnectable={workspaceMode === "build"}
            fitView
            fitViewOptions={{ padding: 0.08, maxZoom: 1.15 }}
            minZoom={0.55}
            maxZoom={1.8}
            snapToGrid
            snapGrid={[12, 12]}
            proOptions={{ hideAttribution: false }}
          >
            <Controls showInteractive={false} />
          </ReactFlow>
        </section>

        <InspectorPanel
          node={selectedNode}
          edge={selectedEdge}
          metrics={
            selectedNode ? (frame?.nodeMetrics[selectedNode.id] ?? null) : null
          }
          metricHistory={
            selectedNode
              ? (result?.frames ?? [])
                  .map(
                    (historyFrame) => historyFrame.nodeMetrics[selectedNode.id],
                  )
                  .filter((metrics) => metrics !== undefined)
              : []
          }
          allNodes={architecture.nodes}
          globalFrame={frame}
          event={selectedEvent}
          workspaceMode={workspaceMode}
          onUpdateNode={updateNode}
          onUpdateEdge={updateEdge}
        />
        <TelemetryPanel
          result={result}
          scenario={scenario}
          nodes={architecture.nodes}
          selectedEventId={selectedEventId}
          currentSecond={cursorSecond}
          onSelectEvent={handleSelectEvent}
          onSeek={setCursorSecond}
        />
      </main>
    </div>
  );
}
