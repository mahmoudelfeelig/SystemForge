import {
  ArrowLeft,
  ArrowSquareOut,
  CheckCircle,
  CloudArrowUp,
  Copy,
  MagnifyingGlass,
  Pause,
  Play,
  Plus,
  SlidersHorizontal,
  Warning,
  WarningOctagon,
} from "@phosphor-icons/react";
import type { ArchitectureNode, Requirement } from "@systemforge/contracts";
import {
  addEdge,
  Controls,
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
import { COMPONENT_ICONS } from "../components/componentIcons";
import { InspectorPanel } from "../components/InspectorPanel";
import { ServiceBanner } from "../components/ServiceBanner";
import { TelemetryPanel } from "../components/TelemetryPanel";
import { encodeLocalShare } from "../lib/share";
import { useLabStore, type WorkspaceMode } from "../store/useLabStore";

const nodeTypes = { system: ComponentNode };

const palette: Array<{ kind: ArchitectureNode["kind"]; name: string }> = [
  { kind: "api", name: "API service" },
  { kind: "worker", name: "Worker" },
  { kind: "database", name: "PostgreSQL" },
  { kind: "cache", name: "Redis" },
  { kind: "queue", name: "Kafka" },
  { kind: "load-balancer", name: "Load balancer" },
  { kind: "cdn", name: "CDN" },
];

const newNode = (
  kind: ArchitectureNode["kind"],
  name: string,
  index: number,
): ArchitectureNode => ({
  id: `${kind}-${Date.now()}`,
  kind,
  name,
  position: {
    x: 220 + (index % 4) * 140,
    y: 100 + Math.floor(index / 4) * 120,
  },
  config: {
    instances: 1,
    capacityRps:
      kind === "database" ? 25_000 : kind === "cache" ? 40_000 : 8_000,
    baseLatencyMs: kind === "database" ? 24 : kind === "cache" ? 3 : 12,
    maxConnections: 10_000,
    cacheHitRate: kind === "cache" ? 0.8 : 0,
    replicas:
      kind === "database" || kind === "queue" || kind === "cache" ? 2 : 0,
    monthlyCostEur: 1_000,
    autoscale: kind === "api" || kind === "worker",
    maxInstances: kind === "api" || kind === "worker" ? 8 : 1,
    consistency: kind === "queue" || kind === "cache" ? "eventual" : "strong",
  },
});

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
  const hydrate = useLabStore((state) => state.hydrate);
  const setArchitecture = useLabStore((state) => state.setArchitecture);
  const selectNode = useLabStore((state) => state.setSelectedNodeId);
  const selectEvent = useLabStore((state) => state.setSelectedEventId);
  const setWorkspaceMode = useLabStore((state) => state.setWorkspaceMode);
  const checkService = useLabStore((state) => state.checkService);
  const runLocal = useLabStore((state) => state.runLocal);
  const submitCanonical = useLabStore((state) => state.submitCanonical);
  const updateRequirement = useLabStore((state) => state.updateRequirement);
  const dismissNotice = useLabStore((state) => state.dismissNotice);
  const [paletteFilter, setPaletteFilter] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    hydrate();
    void checkService();
  }, [checkService, hydrate]);

  const frame = result?.frames.at(-1) ?? null;
  const flowNodes = useMemo<SystemFlowNode[]>(
    () =>
      architecture.nodes.map((component) => ({
        id: component.id,
        type: "system",
        position: component.position,
        initialWidth: 145,
        initialHeight: 70,
        selected: component.id === selectedNodeId,
        data: {
          component,
          utilization: frame?.nodeUtilization[component.id] ?? 0,
          detail:
            component.kind === "queue"
              ? `${Math.round(frame?.queueDepth ?? 0)} queued`
              : `${Math.round(component.config.capacityRps / 1_000)}k req/s cap`,
        },
      })),
    [architecture.nodes, frame, selectedNodeId],
  );
  const flowEdges = useMemo<Edge[]>(
    () =>
      architecture.edges.map((edge) => ({
        ...edge,
        animated: workspaceMode === "run",
        className: "system-edge",
      })),
    [architecture.edges, workspaceMode],
  );
  const selectedNode =
    architecture.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEvent =
    result?.events.find((event) => event.id === selectedEventId) ?? null;
  const filteredPalette = palette.filter((item) =>
    item.name.toLowerCase().includes(paletteFilter.toLowerCase()),
  );

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
      const edges = addEdge(connection, flowEdges).map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      }));
      setArchitecture({ ...architecture, edges });
    },
    [architecture, flowEdges, setArchitecture],
  );
  const updateNode = (nextNode: ArchitectureNode) =>
    setArchitecture({
      ...architecture,
      nodes: architecture.nodes.map((node) =>
        node.id === nextNode.id ? nextNode : node,
      ),
    });
  const addComponent = (kind: ArchitectureNode["kind"], name: string) => {
    const component = newNode(kind, name, architecture.nodes.length);
    setArchitecture({
      ...architecture,
      nodes: [...architecture.nodes, component],
    });
    selectNode(component.id);
  };
  const addDerivedRequirement = () => {
    const requirement: Requirement = {
      id: `derived-${Date.now()}`,
      label: "Candidate-derived requirement",
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
    const url = `${window.location.origin}/lab#share=${encodeLocalShare({ scenario, architecture, role })}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const modeIcon = (mode: WorkspaceMode) =>
    mode === "build" ? (
      <Plus size={14} />
    ) : mode === "run" ? (
      <Play size={14} />
    ) : (
      <MagnifyingGlass size={14} />
    );

  return (
    <div className="lab-shell">
      <header className="lab-header">
        <Link to="/" className="lab-brand">
          <ArrowLeft size={16} />
          <span>SF</span>
          <strong>SystemForge</strong>
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
            >
              {modeIcon(mode)} {mode}
            </button>
          ))}
        </nav>
        <div className="simulation-actions">
          <span className={`service-state service-state--${availability}`}>
            {availability}
          </span>
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
            {runState === "running" ? "Running" : "Run local"}
          </button>
          <button
            className="button"
            type="button"
            disabled={availability !== "online"}
            onClick={() => void submitCanonical()}
          >
            <CloudArrowUp size={16} /> Submit
          </button>
          <span className="requirements-score">
            Requirements{" "}
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
      <main className="lab-grid">
        <aside className="component-palette">
          <header>
            <strong>Components</strong>
            <SlidersHorizontal size={15} />
          </header>
          <label className="palette-search">
            <MagnifyingGlass size={14} />
            <input
              value={paletteFilter}
              onChange={(event) => setPaletteFilter(event.target.value)}
              placeholder="Find component"
            />
          </label>
          <div className="palette-list">
            {filteredPalette.map((item) => {
              const Icon = COMPONENT_ICONS[item.kind];
              return (
                <button
                  type="button"
                  key={item.name}
                  onClick={() => addComponent(item.kind, item.name)}
                >
                  <Icon size={15} weight="duotone" />
                  <span>{item.name}</span>
                  <Plus size={13} />
                </button>
              );
            })}
          </div>
          <section className="requirements-list">
            <header>
              <strong>
                {scenario.mode === "interview" && role !== "interviewer"
                  ? "Derived requirements"
                  : "Requirements"}
              </strong>
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
                return (
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
                  </div>
                );
              })}
            {scenario.mode === "interview" && role !== "interviewer" ? (
              <button
                className="add-derived"
                type="button"
                onClick={addDerivedRequirement}
              >
                <Plus size={14} /> Record inferred requirement
              </button>
            ) : null}
          </section>
          <footer>
            <Link to={scenario.mode === "interview" ? "/interview" : "/custom"}>
              <ArrowSquareOut size={14} /> Edit scenario
            </Link>
          </footer>
        </aside>
        <section
          className="architecture-workspace"
          aria-label="Architecture canvas"
        >
          <ReactFlow<SystemFlowNode, Edge>
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => selectNode(node.id)}
            onPaneClick={() => selectNode(null)}
            fitView
            minZoom={0.35}
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
          frame={frame}
          event={selectedEvent}
          onUpdateNode={updateNode}
        />
        <TelemetryPanel
          result={result}
          selectedEventId={selectedEventId}
          onSelectEvent={selectEvent}
        />
      </main>
    </div>
  );
}
