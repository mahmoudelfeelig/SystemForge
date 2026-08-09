import {
  ArrowLeft,
  ArrowSquareOut,
  CheckCircle,
  CloudArrowUp,
  CircleNotch,
  Copy,
  CopySimple,
  Crosshair,
  MagnifyingGlass,
  Pause,
  Play,
  Plus,
  Pulse,
  Scales,
  SlidersHorizontal,
  SkipForward,
  Stop,
  Trash,
  TreeStructure,
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
  Controls,
  MarkerType,
  ReactFlow,
  ViewportPortal,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  ComponentNode,
  type SystemFlowNode,
} from "../components/ComponentNode";
import { BrandIcon } from "../components/BrandIcon";
import { COMPONENT_ICONS } from "../components/componentIcons";
import { CommandPalette } from "../components/CommandPalette";
import { DecisionWorkbenchBoundary } from "../components/DecisionWorkbenchBoundary";
import { InspectorPanel } from "../components/InspectorPanel";
import { ServiceBanner } from "../components/ServiceBanner";
import {
  TelemetryPanel,
  type TracePlaybackSelection,
} from "../components/TelemetryPanel";
import { candidateLocalShareLink, LocalShareTooLargeError } from "../lib/share";
import {
  autoLayoutArchitecture,
  blankArchitecture,
  connectArchitecture,
  duplicateArchitectureSelection,
  removeArchitectureElements,
} from "../lib/architectureEditing";
import { lintArchitecture } from "../lib/architectureLint";
import {
  activeArchitecturePlacementGroupIds,
  architectureNodeDimensions,
  deriveArchitecturePlacementGroups,
} from "../lib/architecturePlacement";
import { useLabStore, type WorkspaceMode } from "../store/useLabStore";

const nodeTypes = { system: ComponentNode };

const metricLabel = (metric: Requirement["metric"]) =>
  metric
    .replaceAll(/([A-Z])/g, " $1")
    .replace(/^./, (character) => character.toUpperCase());

export const applySelectionChanges = (
  currentIds: readonly string[],
  changes: readonly { id: string; selected: boolean }[],
): string[] => {
  const nextIds = new Set(currentIds);
  for (const change of changes) {
    if (change.selected) nextIds.add(change.id);
    else nextIds.delete(change.id);
  }
  return [...nextIds];
};

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
  onSave: (requirement: Requirement) => void;
  onCancel?: () => void;
  onRemove: (id: string) => void;
  isNew?: boolean;
}

export function DerivedRequirementEditor({
  requirement,
  onSave,
  onCancel,
  onRemove,
  isNew = false,
}: DerivedRequirementEditorProps) {
  const [draft, setDraft] = useState(requirement);
  useEffect(() => setDraft(requirement), [requirement]);
  const patch = (change: Partial<Requirement>) =>
    setDraft((current) => ({ ...current, ...change }));
  const reset = () => {
    setDraft(requirement);
    onCancel?.();
  };

  return (
    <fieldset className="derived-requirement">
      <legend>
        {isNew ? "New candidate constraint" : "Candidate constraint"}
      </legend>
      <label className="derived-requirement__label">
        Requirement
        <input
          aria-label="Derived requirement"
          value={draft.label}
          maxLength={160}
          onChange={(event) => patch({ label: event.target.value })}
        />
      </label>
      <label>
        Signal
        <select
          aria-label="Derived requirement metric"
          value={draft.metric}
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
          value={draft.operator}
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
          value={draft.target}
          onChange={(event) => patch({ target: Number(event.target.value) })}
        />
      </label>
      <label>
        Unit
        <input
          aria-label="Derived requirement unit"
          value={draft.unit}
          maxLength={24}
          onChange={(event) => patch({ unit: event.target.value })}
        />
      </label>
      <div className="derived-requirement__actions">
        <button
          type="button"
          disabled={!draft.label.trim() || !draft.unit.trim()}
          onClick={() =>
            onSave({
              ...draft,
              label: draft.label.trim(),
              unit: draft.unit.trim(),
            })
          }
        >
          Save
        </button>
        <button type="button" onClick={reset}>
          Cancel
        </button>
        {!isNew ? (
          <button
            type="button"
            aria-label={`Remove ${requirement.label}`}
            onClick={() => onRemove(requirement.id)}
          >
            <Trash size={13} /> Remove
          </button>
        ) : null}
      </div>
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
    return `${Math.round(throughputRps).toLocaleString()} configured RPS`;
  if (component.kind === "cache" || component.kind === "cdn")
    return `${Math.round(component.config.cacheHitRate * 100)}% configured hit`;
  if (!metrics) return "not run yet";
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
              ...(kind === "database" || kind === "object-store"
                ? { replicationLagMs: 80 }
                : {}),
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

export type PathPlaybackNodeRole = "node" | "source" | "target";

export interface TracePlaybackTopologyFocus {
  edgeId: string | null;
  inspectorNodeId: string | null;
  nodeRoles: Map<string, PathPlaybackNodeRole>;
  unresolvedEntityIds: string[];
}

const pathRoleRank: Record<PathPlaybackNodeRole, number> = {
  source: 1,
  target: 2,
  node: 3,
};

export const resolveTracePlaybackTopologyFocus = (
  nodes: readonly Pick<ArchitectureNode, "id">[],
  edges: readonly Pick<ArchitectureEdge, "id" | "source" | "target">[],
  selection: TracePlaybackSelection | null,
): TracePlaybackTopologyFocus => {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodeRoles = new Map<string, PathPlaybackNodeRole>();
  const unresolved = new Set<string>();
  const setNodeRole = (
    nodeId: string | undefined,
    role: PathPlaybackNodeRole,
  ) => {
    if (!nodeId) return;
    if (!nodeIds.has(nodeId)) {
      unresolved.add(nodeId);
      return;
    }
    const current = nodeRoles.get(nodeId);
    if (!current || pathRoleRank[role] > pathRoleRank[current])
      nodeRoles.set(nodeId, role);
  };

  if (!selection)
    return {
      edgeId: null,
      inspectorNodeId: null,
      nodeRoles,
      unresolvedEntityIds: [],
    };

  const { span } = selection;
  setNodeRole(span.nodeId, "node");
  setNodeRole(span.sourceNodeId, "source");
  setNodeRole(span.targetNodeId, "target");

  const focusEdge =
    Boolean(span.sourceNodeId || span.targetNodeId) ||
    Boolean(span.edgeId && !span.nodeId);
  let edge =
    focusEdge && span.edgeId
      ? edges.find((candidate) => candidate.id === span.edgeId)
      : undefined;
  if (
    focusEdge &&
    !edge &&
    !span.edgeId &&
    span.sourceNodeId &&
    span.targetNodeId
  ) {
    const tupleMatches = edges.filter(
      (candidate) =>
        candidate.source === span.sourceNodeId &&
        candidate.target === span.targetNodeId,
    );
    if (tupleMatches.length === 1) edge = tupleMatches[0];
    else unresolved.add(`${span.sourceNodeId} → ${span.targetNodeId}`);
  }
  if (focusEdge && span.edgeId && !edge) unresolved.add(span.edgeId);
  if (
    edge &&
    ((span.sourceNodeId && edge.source !== span.sourceNodeId) ||
      (span.targetNodeId && edge.target !== span.targetNodeId))
  ) {
    unresolved.add(span.edgeId ?? `${edge.source} → ${edge.target}`);
    edge = undefined;
  }
  if (edge) {
    setNodeRole(edge.source, "source");
    setNodeRole(edge.target, "target");
  }

  const inspectorNodeId =
    (span.nodeId && nodeIds.has(span.nodeId) ? span.nodeId : null) ??
    (span.targetNodeId && nodeIds.has(span.targetNodeId)
      ? span.targetNodeId
      : null) ??
    (span.sourceNodeId && nodeIds.has(span.sourceNodeId)
      ? span.sourceNodeId
      : null);

  return {
    edgeId: edge?.id ?? null,
    inspectorNodeId,
    nodeRoles,
    unresolvedEntityIds: [...unresolved],
  };
};

export const topologyEdgeShouldAnimate = (
  hasFrames: boolean,
  workspaceMode: WorkspaceMode,
  tracePlaybackActive: boolean,
): boolean => hasFrames && workspaceMode !== "build" && !tracePlaybackActive;

const importedReplayIntentFromLocationState = (
  state: unknown,
): string | null => {
  if (typeof state !== "object" || state === null) return null;
  const intent = (state as Record<string, unknown>)["importedReplayIntent"];
  return typeof intent === "string" ? intent : null;
};

export function LabPage() {
  const location = useLocation();
  const scenario = useLabStore((state) => state.scenario);
  const architecture = useLabStore((state) => state.architecture);
  const result = useLabStore((state) => state.result);
  const runState = useLabStore((state) => state.runState);
  const localRunSession = useLabStore((state) => state.localRunSession);
  const localRunFrames = useLabStore((state) => state.localRunFrames);
  const localRunEvents = useLabStore((state) => state.localRunEvents);
  const localRunActions = useLabStore((state) => state.localRunActions);
  const localRunForkSnapshot = useLabStore(
    (state) => state.localRunForkSnapshot,
  );
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
  const setArchitectureTransient = useLabStore(
    (state) => state.setArchitectureTransient,
  );
  const commitArchitectureTransient = useLabStore(
    (state) => state.commitArchitectureTransient,
  );
  const selectNode = useLabStore((state) => state.setSelectedNodeId);
  const selectEvent = useLabStore((state) => state.setSelectedEventId);
  const setWorkspaceMode = useLabStore((state) => state.setWorkspaceMode);
  const checkService = useLabStore((state) => state.checkService);
  const runLocal = useLabStore((state) => state.runLocal);
  const cancelLocalRun = useLabStore((state) => state.cancelLocalRun);
  const pauseLocalRun = useLabStore((state) => state.pauseLocalRun);
  const resumeLocalRun = useLabStore((state) => state.resumeLocalRun);
  const stepLocalRun = useLabStore((state) => state.stepLocalRun);
  const applyLocalIntervention = useLabStore(
    (state) => state.applyLocalIntervention,
  );
  const injectLocalNodeOutage = useLabStore(
    (state) => state.injectLocalNodeOutage,
  );
  const snapshotLocalRun = useLabStore((state) => state.snapshotLocalRun);
  const forkLocalRunSession = useLabStore((state) => state.forkLocalRunSession);
  const openLocalRunFork = useLabStore((state) => state.openLocalRunFork);
  const finishLocalRun = useLabStore((state) => state.finishLocalRun);
  const setLocalRunSpeed = useLabStore((state) => state.setLocalRunSpeed);
  const submitCanonical = useLabStore((state) => state.submitCanonical);
  const updateRequirement = useLabStore((state) => state.updateRequirement);
  const removeRequirement = useLabStore((state) => state.removeRequirement);
  const refreshSharedScenario = useLabStore(
    (state) => state.refreshSharedScenario,
  );
  const setInterviewReveal = useLabStore((state) => state.setInterviewReveal);
  const dismissNotice = useLabStore((state) => state.dismissNotice);
  const [paletteFilter, setPaletteFilter] = useState("");
  const [edgeSelection, setEdgeSelection] = useState<{
    primaryId: string | null;
    ids: string[];
  }>({ primaryId: null, ids: [] });
  const selectedEdgeId = edgeSelection.primaryId;
  const selectedEdgeIds = edgeSelection.ids;
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [architectureNameDraft, setArchitectureNameDraft] = useState(
    architecture.name,
  );
  const [shareStatus, setShareStatus] = useState<
    "idle" | "copied" | "too-large" | "unavailable"
  >("idle");
  const [cursorSecond, setCursorSecond] = useState(0);
  const [tracePlaybackSelection, setTracePlaybackSelection] =
    useState<TracePlaybackSelection | null>(null);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [compactViewport, setCompactViewport] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 820px)").matches,
  );
  const [draftRequirement, setDraftRequirement] = useState<Requirement | null>(
    null,
  );
  const consumeQueuedImportedReplay = useLabStore(
    (state) => state.consumeQueuedImportedReplay,
  );
  const importedReplayIntent = importedReplayIntentFromLocationState(
    location.state as unknown,
  );
  const openDecisionWorkbench = useCallback(() => {
    setCommandOpen(false);
    setDecisionOpen(true);
  }, []);
  const closeDecisionWorkbench = useCallback(() => setDecisionOpen(false), []);
  const openCommandPalette = useCallback(() => {
    setDecisionOpen(false);
    setCommandOpen(true);
  }, []);
  const closeCommandPalette = useCallback(() => setCommandOpen(false), []);
  const setSelectedEdgeId = useCallback((id: string | null) => {
    setEdgeSelection({ primaryId: id, ids: id ? [id] : [] });
  }, []);
  const decisionShortcut =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
      ? "⌘K"
      : "Ctrl K";

  useEffect(() => {
    let active = true;
    const initialize = async () => {
      await hydrate();
      if (active && importedReplayIntent)
        void consumeQueuedImportedReplay(importedReplayIntent);
    };
    void initialize();
    void checkService();
    return () => {
      active = false;
    };
  }, [
    checkService,
    consumeQueuedImportedReplay,
    hydrate,
    importedReplayIntent,
  ]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const update = () => setCompactViewport(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (result) setCursorSecond(result.frames.length - 1);
    setTracePlaybackSelection(null);
  }, [result]);

  useEffect(() => {
    if (runState === "running" && localRunFrames.length)
      setCursorSecond(localRunFrames.length - 1);
  }, [localRunFrames.length, runState]);

  useEffect(() => {
    setArchitectureNameDraft(architecture.name);
    const knownNodeIds = new Set(architecture.nodes.map((node) => node.id));
    setSelectedNodeIds((current) =>
      current.filter((id) => knownNodeIds.has(id)),
    );
  }, [architecture.name, architecture.nodes]);

  useEffect(() => {
    const knownEdgeIds = new Set(architecture.edges.map((edge) => edge.id));
    setEdgeSelection((current) => {
      const ids = current.ids.filter((id) => knownEdgeIds.has(id));
      const primaryId =
        current.primaryId && knownEdgeIds.has(current.primaryId)
          ? current.primaryId
          : (ids.at(-1) ?? null);
      return ids.length === current.ids.length &&
        primaryId === current.primaryId
        ? current
        : { primaryId, ids };
    });
  }, [architecture.edges]);

  useEffect(() => {
    const density = localStorage.getItem("systemforge:density");
    document.documentElement.dataset.systemforgeDensity =
      density === "comfortable" ? "comfortable" : "compact";
    const handleGlobalShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openDecisionWorkbench();
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        openCommandPalette();
      }
    };
    window.addEventListener("keydown", handleGlobalShortcut);
    return () => window.removeEventListener("keydown", handleGlobalShortcut);
  }, [openCommandPalette, openDecisionWorkbench]);

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

  const displayFrames = result?.frames ?? localRunFrames;
  const displayEvents = result?.events ?? localRunEvents;
  const frame =
    displayFrames[Math.min(cursorSecond, displayFrames.length - 1)] ??
    displayFrames.at(-1) ??
    null;
  const placementGroups = useMemo(
    () => [
      ...deriveArchitecturePlacementGroups(architecture, "region"),
      ...deriveArchitecturePlacementGroups(architecture, "failure-domain"),
    ],
    [architecture],
  );
  const placementIncidents = useMemo(
    () => [
      ...scenario.incidents,
      ...(result?.generatedIncidents.map(({ incident }) => incident) ?? []),
    ],
    [result?.generatedIncidents, scenario.incidents],
  );
  const activePlacementGroupIds = useMemo(
    () =>
      activeArchitecturePlacementGroupIds(
        placementIncidents,
        frame?.second ?? cursorSecond,
        scenario.workload.durationSeconds,
      ),
    [
      cursorSecond,
      frame?.second,
      placementIncidents,
      scenario.workload.durationSeconds,
    ],
  );
  const causalIds = useMemo(
    () => causalEntityIds(displayEvents, selectedEventId),
    [displayEvents, selectedEventId],
  );
  const tracePlaybackFocus = useMemo(
    () =>
      resolveTracePlaybackTopologyFocus(
        architecture.nodes,
        architecture.edges,
        tracePlaybackSelection,
      ),
    [architecture.edges, architecture.nodes, tracePlaybackSelection],
  );

  useEffect(() => {
    if (!tracePlaybackSelection) return;
    selectEvent(null);
    if (tracePlaybackFocus.edgeId) {
      selectNode(null);
      setSelectedNodeIds([]);
      setSelectedEdgeId(tracePlaybackFocus.edgeId);
      return;
    }
    if (tracePlaybackFocus.inspectorNodeId) {
      setSelectedEdgeId(null);
      selectNode(tracePlaybackFocus.inspectorNodeId);
      setSelectedNodeIds([tracePlaybackFocus.inspectorNodeId]);
      return;
    }
    setSelectedEdgeId(null);
    selectNode(null);
    setSelectedNodeIds([]);
  }, [
    selectEvent,
    selectNode,
    setSelectedEdgeId,
    tracePlaybackFocus,
    tracePlaybackSelection,
  ]);
  const flowNodes = useMemo<SystemFlowNode[]>(
    () =>
      architecture.nodes.map((component) => {
        const dimensions = architectureNodeDimensions(component.kind);
        const pathRole = tracePlaybackFocus.nodeRoles.get(component.id);
        return {
          id: component.id,
          type: "system",
          position: component.position,
          initialWidth: dimensions.width,
          initialHeight: dimensions.height,
          selected:
            component.id === selectedNodeId ||
            selectedNodeIds.includes(component.id),
          data: {
            component,
            metrics: frame?.nodeMetrics[component.id],
            causalFocus: causalIds.has(component.id),
            pathPlayback:
              pathRole && tracePlaybackSelection
                ? {
                    role: pathRole,
                    kind: tracePlaybackSelection.span.kind,
                    status: tracePlaybackSelection.span.status,
                    ...(tracePlaybackSelection.span.failureCause
                      ? {
                          failureCause:
                            tracePlaybackSelection.span.failureCause,
                        }
                      : {}),
                  }
                : undefined,
            throughputRps: frame?.rps,
            history: displayFrames
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
    [
      architecture.nodes,
      causalIds,
      frame,
      displayFrames,
      selectedNodeId,
      selectedNodeIds,
      tracePlaybackFocus.nodeRoles,
      tracePlaybackSelection,
    ],
  );
  const flowEdges = useMemo<Edge[]>(
    () =>
      architecture.edges.map((edge) => {
        const isCausal =
          causalIds.has(edge.source) || causalIds.has(edge.target);
        const isTracePath = tracePlaybackFocus.edgeId === edge.id;
        const states = [
          frame?.nodeMetrics[edge.source]?.state,
          frame?.nodeMetrics[edge.target]?.state,
        ];
        const healthState =
          displayFrames.length === 0
            ? "neutral"
            : states.some(
                  (state) => state === "critical" || state === "offline",
                )
              ? "critical"
              : states.some((state) => state === "warning")
                ? "warning"
                : "healthy";
        const edgeColor = isTracePath
          ? tracePlaybackSelection?.span.status === "dropped" ||
            tracePlaybackSelection?.span.failureCause
            ? "#ff604f"
            : tracePlaybackSelection?.span.status === "degraded"
              ? "#f2bf4b"
              : "#58bfff"
          : isCausal
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
          selected: selectedEdgeIds.includes(edge.id),
          animated: topologyEdgeShouldAnimate(
            displayFrames.length > 0,
            workspaceMode,
            tracePlaybackSelection !== null,
          ),
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 12,
            height: 12,
            color: edgeColor,
          },
          className: `system-edge system-edge--state-${healthState} ${isCausal ? "system-edge--causal" : ""} ${isTracePath && tracePlaybackSelection ? `system-edge--path system-edge--path-${tracePlaybackSelection.span.kind} system-edge--path-${tracePlaybackSelection.span.status}` : ""}`,
          ariaLabel:
            isTracePath && tracePlaybackSelection
              ? `Path playback ${tracePlaybackSelection.span.kind.replaceAll("-", " ")} from ${edge.source} to ${edge.target}, ${tracePlaybackSelection.span.status}`
              : undefined,
        };
      }),
    [
      architecture.edges,
      causalIds,
      frame,
      displayFrames.length,
      selectedEdgeIds,
      tracePlaybackFocus.edgeId,
      tracePlaybackSelection,
      workspaceMode,
    ],
  );
  const selectedNode =
    architecture.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge =
    architecture.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const selectedEvent =
    displayEvents.find((event) => event.id === selectedEventId) ?? null;
  const globalHealthState =
    displayFrames.length === 0
      ? "not-run"
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
  const visibleRequirements = scenario.requirements.filter(
    (requirement) =>
      role === "interviewer" || requirement.visibility !== "hidden",
  );
  const graphIssues = useMemo(
    () => lintArchitecture(scenario, architecture),
    [architecture, scenario],
  );
  const graphErrorCount = graphIssues.filter(
    (issue) => issue.severity === "error",
  ).length;
  const localSessionActive =
    runState === "running" &&
    localRunSession !== null &&
    !["cancelled", "complete", "error"].includes(localRunSession.state);
  const localSessionPaused = localRunSession?.state === "paused";
  const nextActionSecond = (localRunFrames.at(-1)?.second ?? 0) + 1;
  let selectedNodeInstances = selectedNode
    ? (frame?.nodeMetrics[selectedNode.id]?.activeInstances ??
      selectedNode.config.instances)
    : 1;
  let selectedCircuitBreakerEnabled =
    selectedNode?.config.behavior?.resilience?.circuitBreaker ?? false;
  for (const action of localRunActions) {
    if (action.type !== "apply-intervention") continue;
    if (action.nodeId !== selectedNode?.id) continue;
    if (action.intervention.kind === "scale")
      selectedNodeInstances = action.intervention.instances;
    if (action.intervention.kind === "circuit-breaker")
      selectedCircuitBreakerEnabled = action.intervention.enabled;
  }
  const scaleTarget = Math.min(
    selectedNode?.config.maxInstances ?? 10_000,
    Math.max(selectedNodeInstances + 1, selectedNodeInstances * 2),
  );
  const futureActionAvailable =
    localSessionPaused &&
    selectedNode !== null &&
    nextActionSecond <= scenario.workload.durationSeconds;
  const scaleActionAvailable =
    futureActionAvailable && scaleTarget > selectedNodeInstances;
  const breakerActionAvailable =
    futureActionAvailable &&
    selectedNode !== null &&
    ["api", "load-balancer", "third-party"].includes(selectedNode.kind);
  const loadSheddingActionAvailable =
    futureActionAvailable &&
    selectedNode !== null &&
    ["api", "load-balancer"].includes(selectedNode.kind);
  const localRunLabel = localSessionPaused
    ? "paused"
    : localRunSession?.state === "starting"
      ? "starting"
      : runState === "complete"
        ? "results ready"
        : runState === "idle"
          ? "not run"
          : runState;

  const onNodesChange = useCallback(
    (changes: NodeChange<SystemFlowNode>[]) => {
      const selectionChanges = changes.flatMap((change) =>
        change.type === "select"
          ? [{ id: change.id, selected: change.selected }]
          : [],
      );
      if (selectionChanges.length) {
        const nextSelection = new Set(selectedNodeIds);
        for (const change of selectionChanges) {
          if (change.selected) nextSelection.add(change.id);
          else nextSelection.delete(change.id);
        }
        const nextIds = [...nextSelection];
        setSelectedNodeIds(nextIds);
        const newlySelected = selectionChanges
          .filter((change) => change.selected)
          .at(-1);
        if (newlySelected) selectNode(newlySelected.id);
        else if (!selectedNodeId || !nextSelection.has(selectedNodeId))
          selectNode(nextIds.at(-1) ?? null);
      }
      const positions = new Map(
        changes.flatMap((change) =>
          change.type === "position" && change.position
            ? [[change.id, change.position] as const]
            : [],
        ),
      );
      if (positions.size === 0) return;
      setArchitectureTransient({
        ...architecture,
        nodes: architecture.nodes.map((node) => ({
          ...node,
          position: positions.get(node.id) ?? node.position,
        })),
      });
    },
    [
      architecture,
      selectNode,
      selectedNodeId,
      selectedNodeIds,
      setArchitectureTransient,
    ],
  );
  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    const selectionChanges = changes.flatMap((change) =>
      change.type === "select"
        ? [{ id: change.id, selected: change.selected }]
        : [],
    );
    if (selectionChanges.length === 0) return;
    setEdgeSelection((current) => {
      const ids = applySelectionChanges(current.ids, selectionChanges);
      const newlySelected = selectionChanges
        .filter((change) => change.selected)
        .at(-1);
      const primaryId = newlySelected
        ? newlySelected.id
        : current.primaryId && ids.includes(current.primaryId)
          ? current.primaryId
          : (ids.at(-1) ?? null);
      return { primaryId, ids };
    });
  }, []);
  const onConnect = useCallback(
    (connection: Connection) => {
      if (workspaceMode !== "build" || flowEdges.length >= 2_000) return;
      setArchitecture(connectArchitecture(architecture, connection));
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
    setSelectedNodeIds([component.id]);
  };
  const removeElements = (nodeIds: string[], edgeIds: string[]) => {
    if (
      workspaceMode !== "build" ||
      (nodeIds.length === 0 && edgeIds.length === 0)
    )
      return;
    setArchitecture(removeArchitectureElements(architecture, nodeIds, edgeIds));
    setSelectedNodeIds([]);
    selectNode(null);
    setSelectedEdgeId(null);
  };
  const duplicateSelection = () => {
    if (workspaceMode !== "build") return;
    const sourceIds = selectedNodeIds.length
      ? selectedNodeIds
      : selectedNodeId
        ? [selectedNodeId]
        : [];
    if (
      sourceIds.length === 0 ||
      architecture.nodes.length + sourceIds.length > 500
    )
      return;
    const duplicated = duplicateArchitectureSelection(architecture, sourceIds);
    setArchitecture(duplicated.architecture);
    setSelectedNodeIds(duplicated.selectedNodeIds);
    selectNode(duplicated.selectedNodeIds[0] ?? null);
  };
  const autoLayout = () => {
    if (workspaceMode !== "build" || architecture.nodes.length === 0) return;
    setArchitecture(autoLayoutArchitecture(architecture));
  };
  const clearArchitecture = () => {
    if (workspaceMode !== "build") return;
    setArchitecture(blankArchitecture(architecture));
    setSelectedNodeIds([]);
    selectNode(null);
    setSelectedEdgeId(null);
  };
  const addDerivedRequirement = () => {
    const requirement: Requirement = {
      id: `derived-${crypto.randomUUID()}`,
      label: "",
      metric: "p95LatencyMs",
      operator: "lte",
      target: 400,
      unit: "ms",
      visibility: "derived",
      owner: "candidate",
    };
    setDraftRequirement(requirement);
  };
  const copyLocalShare = async () => {
    try {
      const url = candidateLocalShareLink(scenario, architecture);
      await navigator.clipboard.writeText(url);
      setShareStatus("copied");
    } catch (error) {
      setShareStatus(
        error instanceof LocalShareTooLargeError ? "too-large" : "unavailable",
      );
    }
    window.setTimeout(() => setShareStatus("idle"), 4_000);
  };
  const handleSelectEvent = (id: string) => {
    const event = displayEvents.find((candidate) => candidate.id === id);
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
          {(["build", "run", "investigate"] as const).map((mode) => (
            <button
              className={workspaceMode === mode ? "active" : ""}
              type="button"
              key={mode}
              onClick={() => setWorkspaceMode(mode)}
              aria-pressed={workspaceMode === mode}
            >
              {modeIcon(mode)} {mode[0]?.toUpperCase()}
              {mode.slice(1)}
            </button>
          ))}
        </nav>
        <div className="simulation-actions">
          <span
            className={`simulation-run-state simulation-run-state--${runState}`}
          >
            {localRunLabel}
          </span>
          <span className="simulation-clock">
            {String(Math.floor(cursorSecond / 60)).padStart(2, "0")}:
            {String(cursorSecond % 60).padStart(2, "0")}
          </span>
          {availability !== "online" ? (
            <span className={`service-state service-state--${availability}`}>
              {availability === "offline"
                ? "Server unavailable"
                : "Server busy"}
            </span>
          ) : null}
          <span className={`global-health global-health--${globalHealthState}`}>
            <small>Health</small>
            <strong>
              {globalHealthState === "not-run" ? "not run" : globalHealthState}
            </strong>
          </span>
          {scenario.mode === "interview" ? (
            <span className={`reveal-state reveal-state--${revealState}`}>
              criteria {revealState}
            </span>
          ) : null}
          <button
            className="icon-button"
            type="button"
            onClick={() => void copyLocalShare()}
            aria-label="Copy candidate-safe local share link"
            title={
              shareStatus === "too-large"
                ? "This architecture is too large for a safe browser-local URL. Reduce it or use a server-backed short link."
                : shareStatus === "unavailable"
                  ? "The browser could not copy this local link."
                  : "Copies a participant link without hidden interview criteria or interviewer notes."
            }
          >
            <Copy size={16} />
            <span aria-live="polite">
              {shareStatus === "copied"
                ? "Copied"
                : shareStatus === "too-large"
                  ? "Link too large"
                  : shareStatus === "unavailable"
                    ? "Copy unavailable"
                    : ""}
            </span>
          </button>
          <button
            className="icon-button command-trigger"
            type="button"
            onClick={openCommandPalette}
            aria-label="Open command palette"
            aria-keyshortcuts="Control+Shift+P Meta+Shift+P"
          >
            <MagnifyingGlass size={16} />
          </button>
          <button
            className="decision-trigger"
            type="button"
            onClick={openDecisionWorkbench}
            aria-keyshortcuts="Control+K Meta+K"
          >
            <Scales size={15} /> Compare
            <kbd>{decisionShortcut}</kbd>
          </button>
          <div className="local-run-controls">
            <button
              className="button button--run"
              type="button"
              disabled={!localSessionActive && graphErrorCount > 0}
              title={
                !localSessionActive && graphErrorCount > 0
                  ? "Resolve blocking graph-lint errors before running."
                  : undefined
              }
              onClick={() => {
                if (localSessionPaused) resumeLocalRun();
                else if (localSessionActive) pauseLocalRun();
                else void runLocal();
              }}
            >
              {localRunSession?.state === "starting" ? (
                <CircleNotch className="run-progress" size={16} />
              ) : localSessionPaused ? (
                <Play size={16} weight="fill" />
              ) : localSessionActive ? (
                <Pause size={16} weight="fill" />
              ) : (
                <Play size={16} weight="fill" />
              )}
              {localRunSession?.state === "starting"
                ? "Starting…"
                : localSessionPaused
                  ? "Resume"
                  : localSessionActive
                    ? "Pause"
                    : "Run locally"}
            </button>
            {localSessionActive ? (
              <div className="local-run-controls__session">
                <button
                  className="icon-button"
                  type="button"
                  disabled={!localSessionPaused}
                  onClick={stepLocalRun}
                  aria-label="Step one local-run batch"
                  title="Step one batch while paused"
                >
                  <SkipForward size={14} weight="fill" />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  onClick={cancelLocalRun}
                  aria-label="Cancel local run"
                  title="Cancel local run"
                >
                  <Stop size={14} weight="fill" />
                </button>
                <label className="local-run-speed">
                  <span>Speed</span>
                  <select
                    aria-label="Local run playback speed"
                    value={localRunSession?.speed ?? 1}
                    onChange={(event) =>
                      setLocalRunSpeed(Number(event.target.value))
                    }
                  >
                    {[0.25, 0.5, 1, 2, 4, 8, 16].map((speed) => (
                      <option value={speed} key={speed}>
                        {speed}×
                      </option>
                    ))}
                  </select>
                </label>
                <label className="local-run-progress">
                  <span>
                    {Math.round((localRunSession?.progress ?? 0) * 100)}%
                  </span>
                  <progress
                    aria-label="Local run progress"
                    max="1"
                    value={localRunSession?.progress ?? 0}
                  />
                </label>
                {localSessionPaused ? (
                  <section
                    className="run-intervention-panel"
                    aria-label="Paused run interventions"
                  >
                    <header>
                      <span>Future-only actions</span>
                      <strong>
                        {selectedNode?.name ?? "Select a node"} · t+
                        {nextActionSecond}s
                      </strong>
                    </header>
                    <p>
                      Recomputes deterministically from second 0. Delivered
                      frames stay locked.
                    </p>
                    <div className="run-intervention-panel__actions">
                      <button
                        type="button"
                        disabled={!scaleActionAvailable}
                        onClick={() =>
                          selectedNode &&
                          applyLocalIntervention(selectedNode.id, {
                            kind: "scale",
                            instances: scaleTarget,
                          })
                        }
                      >
                        Scale to {scaleTarget}
                      </button>
                      <button
                        type="button"
                        disabled={!breakerActionAvailable}
                        onClick={() =>
                          selectedNode &&
                          applyLocalIntervention(selectedNode.id, {
                            kind: "circuit-breaker",
                            enabled: !selectedCircuitBreakerEnabled,
                          })
                        }
                      >
                        {selectedCircuitBreakerEnabled ? "Disable" : "Enable"}{" "}
                        breaker
                      </button>
                      <button
                        type="button"
                        disabled={!loadSheddingActionAvailable}
                        onClick={() =>
                          selectedNode &&
                          applyLocalIntervention(selectedNode.id, {
                            kind: "load-shedding",
                            threshold: 0.8,
                          })
                        }
                      >
                        Shed at 80%
                      </button>
                      <button
                        type="button"
                        disabled={!futureActionAvailable}
                        onClick={() =>
                          selectedNode && injectLocalNodeOutage(selectedNode.id)
                        }
                      >
                        Fail one instance
                      </button>
                    </div>
                    <div className="run-intervention-panel__session-actions">
                      <button type="button" onClick={snapshotLocalRun}>
                        Snapshot replay
                      </button>
                      <button type="button" onClick={forkLocalRunSession}>
                        Capture fork
                      </button>
                      <button
                        type="button"
                        disabled={!localRunForkSnapshot}
                        onClick={() => void openLocalRunFork()}
                      >
                        Open captured fork
                      </button>
                      <button type="button" onClick={finishLocalRun}>
                        Finish playback
                      </button>
                    </div>
                    {localRunActions.length > 0 ? (
                      <ol className="run-intervention-panel__log">
                        {localRunActions.slice(-3).map((action) => (
                          <li key={action.id}>
                            <time>t+{action.atSecond}s</time>
                            <span>
                              {action.type === "inject-incident"
                                ? action.incident.label
                                : `${action.nodeId}: ${action.intervention.kind}`}
                            </span>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </section>
                ) : null}
              </div>
            ) : null}
          </div>
          <button
            className="button button--canonical"
            type="button"
            disabled={
              availability !== "online" ||
              graphErrorCount > 0 ||
              canonicalRunStatus === "queued" ||
              canonicalRunStatus === "running"
            }
            onClick={() => void submitCanonical()}
          >
            <CloudArrowUp size={16} />
            <span className="canonical-run-label">
              {canonicalRunStatus === "queued" ||
              canonicalRunStatus === "running"
                ? canonicalRunStatus
                : canonicalRunStatus === "completed"
                  ? "Server run complete"
                  : "Run on server"}
            </span>
          </button>
          <span className="requirements-score">
            Targets{" "}
            <strong>
              {result?.score.passed ?? "—"}/
              {result?.score.total ?? scenario.requirements.length}
            </strong>
          </span>
        </div>
      </header>
      <div className="mobile-state-strip" aria-label="Current run state">
        <span>{localRunLabel}</span>
        <time>
          {String(Math.floor(cursorSecond / 60)).padStart(2, "0")}:
          {String(cursorSecond % 60).padStart(2, "0")}
        </time>
        <span>
          {result
            ? `${result.score.passed}/${result.score.total} objectives`
            : "objectives —"}
        </span>
        <span>
          {globalHealthState === "not-run"
            ? "model not run"
            : globalHealthState}
        </span>
        <span>seed {scenario.seed}</span>
      </div>
      <ServiceBanner
        availability={availability}
        notice={notice}
        onDismiss={dismissNotice}
      />
      <DecisionWorkbenchBoundary
        open={decisionOpen}
        onClose={closeDecisionWorkbench}
      />
      <CommandPalette
        open={commandOpen}
        onClose={closeCommandPalette}
        onOpenDecisionWorkbench={openDecisionWorkbench}
      />
      <main
        className="lab-grid"
        inert={decisionOpen || commandOpen ? true : undefined}
      >
        <aside className="component-palette">
          <header>
            <div>
              <span className="panel-index">01 / COMPONENTS</span>
              <strong>System components</strong>
            </div>
            <SlidersHorizontal size={15} />
          </header>
          <label className="palette-search">
            <MagnifyingGlass size={14} />
            <input
              aria-label="Filter system components"
              value={paletteFilter}
              onChange={(event) => setPaletteFilter(event.target.value)}
              placeholder="Filter components"
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
            {visibleGroups.length === 0 ? (
              <p className="palette-empty">
                No components match “{paletteFilter}”.
              </p>
            ) : null}
          </div>
          <section className="requirements-list">
            <header>
              <div>
                <span className="panel-index">02 / CONSTRAINTS</span>
                <strong>
                  {scenario.mode === "interview" && role !== "interviewer"
                    ? "Derived requirements"
                    : "Objectives"}
                </strong>
              </div>
              <span>{scenario.requirements.length}</span>
            </header>
            {visibleRequirements.map((requirement) => {
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
                  onSave={updateRequirement}
                  onRemove={removeRequirement}
                />
              ) : (
                <div
                  key={requirement.id}
                  className={
                    outcome?.passed ? "passed" : outcome ? "failed" : "pending"
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
            {visibleRequirements.length === 0 ? (
              <p className="requirements-empty">
                No objectives are visible in this view.
              </p>
            ) : null}
            {draftRequirement ? (
              <DerivedRequirementEditor
                requirement={draftRequirement}
                isNew
                onSave={(requirement) => {
                  updateRequirement(requirement);
                  setDraftRequirement(null);
                }}
                onCancel={() => setDraftRequirement(null)}
                onRemove={() => undefined}
              />
            ) : null}
            {candidateRequirementsEnabled(scenario, role) ? (
              <button
                className="add-derived"
                type="button"
                onClick={addDerivedRequirement}
                disabled={
                  scenario.requirements.length >= 40 ||
                  Boolean(draftRequirement)
                }
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
                    A server-backed interview link is required for synchronized
                    reveal.
                  </small>
                ) : null}
              </div>
            ) : null}
          </section>
          <footer>
            {scenario.mode === "interview" && role !== "interviewer" ? (
              <span>Candidate view · scenario editing unavailable</span>
            ) : (
              <Link
                to={scenario.mode === "interview" ? "/interview" : "/custom"}
              >
                <ArrowSquareOut size={14} /> Edit scenario
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
              <span className="panel-index">02 / SYSTEM TOPOLOGY</span>
              <input
                className="canvas-name"
                aria-label="Architecture name"
                value={architectureNameDraft}
                maxLength={120}
                disabled={workspaceMode !== "build"}
                onChange={(event) =>
                  setArchitectureNameDraft(event.target.value)
                }
                onBlur={() => {
                  const name = architectureNameDraft.trim();
                  if (name && name !== architecture.name)
                    setArchitecture({ ...architecture, name });
                  else setArchitectureNameDraft(architecture.name);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    setArchitectureNameDraft(architecture.name);
                    event.currentTarget.blur();
                  }
                }}
              />
            </div>
            {workspaceMode === "build" ? (
              <div className="canvas-tools" aria-label="Topology editing tools">
                <button
                  type="button"
                  onClick={autoLayout}
                  disabled={!architecture.nodes.length}
                >
                  <TreeStructure size={14} /> Layout
                </button>
                <button
                  type="button"
                  onClick={duplicateSelection}
                  disabled={!selectedNodeId && selectedNodeIds.length === 0}
                >
                  <CopySimple size={14} /> Duplicate
                </button>
                <button
                  type="button"
                  onClick={clearArchitecture}
                  disabled={!architecture.nodes.length}
                  title="Start a blank architecture. Undo remains available in Compare."
                >
                  <Trash size={14} /> Blank
                </button>
              </div>
            ) : null}
            <div className="canvas-signal">
              <Pulse size={15} weight="bold" />
              <span>
                {workspaceMode === "build"
                  ? "Editing topology"
                  : frame
                    ? "Viewing modeled results"
                    : runState === "running"
                      ? "Waiting for first modeled frame"
                      : "No modeled result yet"}
              </span>
            </div>
            <dl>
              <div>
                <dt>RPS</dt>
                <dd>{frame ? Math.round(frame.rps).toLocaleString() : "—"}</dd>
              </div>
              <div>
                <dt>p95</dt>
                <dd>{frame ? `${Math.round(frame.p95LatencyMs)} ms` : "—"}</dd>
              </div>
              <div>
                <dt>Availability</dt>
                <dd>{frame ? `${frame.availability.toFixed(3)}%` : "—"}</dd>
              </div>
            </dl>
          </header>
          <ReactFlow<SystemFlowNode, Edge>
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={commitArchitectureTransient}
            onSelectionDragStop={commitArchitectureTransient}
            onNodeClick={(event) => {
              if (tracePlaybackSelection) return;
              if (!event.shiftKey) setSelectedEdgeId(null);
            }}
            onEdgeClick={(event, edge) => {
              if (tracePlaybackSelection) return;
              if (event.shiftKey) return;
              selectNode(null);
              setSelectedNodeIds([]);
              setSelectedEdgeId(edge.id);
            }}
            onPaneClick={() => {
              if (tracePlaybackSelection) return;
              selectNode(null);
              setSelectedNodeIds([]);
              setSelectedEdgeId(null);
            }}
            onDelete={({ nodes, edges }) =>
              removeElements(
                nodes.map((node) => node.id),
                edges.map((edge) => edge.id),
              )
            }
            nodesDraggable={workspaceMode === "build"}
            nodesConnectable={workspaceMode === "build"}
            elementsSelectable={!tracePlaybackSelection}
            deleteKeyCode={
              workspaceMode === "build" ? ["Backspace", "Delete"] : null
            }
            multiSelectionKeyCode="Shift"
            fitView
            fitViewOptions={{
              padding: compactViewport ? 0.04 : 0.08,
              maxZoom: compactViewport ? 0.85 : 1.15,
            }}
            minZoom={compactViewport ? 0.25 : 0.55}
            maxZoom={1.8}
            snapToGrid
            snapGrid={[12, 12]}
            proOptions={{ hideAttribution: false }}
          >
            <ViewportPortal>
              {placementGroups.map((group) => (
                <div
                  aria-hidden="true"
                  className={`placement-group placement-group--${group.scope} ${
                    activePlacementGroupIds.has(group.id)
                      ? "placement-group--active"
                      : ""
                  }`}
                  key={group.id}
                  style={{
                    left: group.bounds.x,
                    top: group.bounds.y,
                    width: group.bounds.width,
                    height: group.bounds.height,
                  }}
                >
                  <span>
                    {group.scope === "region" ? "Region" : "Failure domain"}
                    {" · "}
                    {group.label}
                  </span>
                </div>
              ))}
            </ViewportPortal>
            <Controls showInteractive={false} />
          </ReactFlow>
          <details className="architecture-outline">
            <summary>
              Architecture outline ·{" "}
              {graphIssues.length
                ? `${graphErrorCount} errors, ${graphIssues.length - graphErrorCount} warnings`
                : "graph ready"}
            </summary>
            <div>
              <section className="architecture-lint" aria-label="Graph lint">
                <header>
                  <strong>Graph lint</strong>
                  <span>
                    {graphIssues.length
                      ? `${graphIssues.length} issues`
                      : "No issues"}
                  </span>
                </header>
                {graphIssues.length ? (
                  <ul>
                    {graphIssues.slice(0, 8).map((issue) => {
                      const nodeTarget = architecture.nodes.some(
                        (node) => node.id === issue.entityId,
                      );
                      const edgeTarget = architecture.edges.some(
                        (edge) => edge.id === issue.entityId,
                      );
                      const content = (
                        <>
                          <span>{issue.severity}</span>
                          <strong>{issue.title}</strong>
                          <small>{issue.detail}</small>
                        </>
                      );
                      return (
                        <li
                          className={`architecture-lint__${issue.severity}`}
                          key={issue.id}
                        >
                          {nodeTarget || edgeTarget ? (
                            <button
                              className="architecture-lint__item"
                              type="button"
                              onClick={() => {
                                if (nodeTarget && issue.entityId) {
                                  setSelectedEdgeId(null);
                                  setSelectedNodeIds([issue.entityId]);
                                  selectNode(issue.entityId);
                                } else if (edgeTarget && issue.entityId) {
                                  setSelectedNodeIds([]);
                                  selectNode(null);
                                  setSelectedEdgeId(issue.entityId);
                                }
                              }}
                            >
                              {content}
                            </button>
                          ) : (
                            <div className="architecture-lint__item">
                              {content}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p>
                    Entry paths, link shares, and incident scopes are valid.
                  </p>
                )}
              </section>
              {placementGroups.length ? (
                <section
                  className="architecture-placement-outline"
                  aria-label="Architecture placement groups"
                >
                  {(["region", "failure-domain"] as const).map((scope) => {
                    const groups = placementGroups.filter(
                      (group) => group.scope === scope,
                    );
                    if (!groups.length) return null;
                    return (
                      <div key={scope}>
                        <strong>
                          {scope === "region" ? "Regions" : "Failure domains"}
                        </strong>
                        {groups.map((group) => (
                          <section
                            className={
                              activePlacementGroupIds.has(group.id)
                                ? "architecture-placement-outline__active"
                                : undefined
                            }
                            key={group.id}
                          >
                            <header>
                              <span>{group.label}</span>
                              <small>
                                {group.nodeIds.length} component
                                {group.nodeIds.length === 1 ? "" : "s"}
                                {activePlacementGroupIds.has(group.id)
                                  ? " · incident active"
                                  : ""}
                              </small>
                            </header>
                            <ul>
                              {group.nodeIds.map((nodeId) => {
                                const node = architecture.nodes.find(
                                  (candidate) => candidate.id === nodeId,
                                );
                                if (!node) return null;
                                return (
                                  <li key={node.id}>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSelectedEdgeId(null);
                                        setSelectedNodeIds([node.id]);
                                        selectNode(node.id);
                                      }}
                                    >
                                      <span>{node.kind}</span>
                                      {node.name}
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          </section>
                        ))}
                      </div>
                    );
                  })}
                </section>
              ) : null}
              <strong>All components · {architecture.nodes.length}</strong>
              {architecture.nodes.length ? (
                <ul>
                  {architecture.nodes.map((node) => (
                    <li key={node.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedEdgeId(null);
                          setSelectedNodeIds([node.id]);
                          selectNode(node.id);
                        }}
                      >
                        <span>{node.kind}</span>
                        {node.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No components yet. Add one from the component rail.</p>
              )}
            </div>
          </details>
        </section>

        <InspectorPanel
          node={selectedNode}
          edge={selectedEdge}
          edgeMetrics={
            selectedEdge ? (frame?.edgeMetrics[selectedEdge.id] ?? null) : null
          }
          metrics={
            selectedNode ? (frame?.nodeMetrics[selectedNode.id] ?? null) : null
          }
          metricHistory={
            selectedNode
              ? displayFrames
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
          liveFrames={localRunFrames}
          liveEvents={localRunEvents}
          running={localSessionActive}
          progress={localRunSession?.progress ?? 0}
          scenario={scenario}
          nodes={architecture.nodes}
          edges={architecture.edges}
          selectedEventId={selectedEventId}
          currentSecond={cursorSecond}
          onSelectEvent={handleSelectEvent}
          onSeek={setCursorSecond}
          onTracePlaybackChange={setTracePlaybackSelection}
        />
      </main>
    </div>
  );
}
