import {
  CheckCircle,
  Gear,
  Pulse,
  Warning,
  WarningOctagon,
} from "@phosphor-icons/react";
import type {
  ArchitectureNode,
  CausalEvent,
  MetricFrame,
} from "@systemforge/contracts";

interface InspectorPanelProps {
  node: ArchitectureNode | null;
  frame: MetricFrame | null;
  event: CausalEvent | null;
  onUpdateNode: (node: ArchitectureNode) => void;
}

export function InspectorPanel({
  node,
  frame,
  event,
  onUpdateNode,
}: InspectorPanelProps) {
  if (!node)
    return (
      <aside className="inspector">
        <p>Select a component to inspect its modeled behavior.</p>
      </aside>
    );
  const utilization = frame?.nodeUtilization[node.id] ?? 0;
  const state =
    utilization >= 1 ? "critical" : utilization >= 0.72 ? "warning" : "healthy";
  const StateIcon =
    state === "critical"
      ? WarningOctagon
      : state === "warning"
        ? Warning
        : CheckCircle;
  const updateNumber = (
    field: "instances" | "capacityRps" | "baseLatencyMs" | "maxConnections",
    value: number,
  ) => {
    onUpdateNode({ ...node, config: { ...node.config, [field]: value } });
  };
  return (
    <aside className="inspector">
      <header>
        <div>
          <span>Inspector</span>
          <strong>{node.name}</strong>
        </div>
        <StateIcon
          className={`health-${state}`}
          size={18}
          weight="fill"
          aria-label={state}
        />
      </header>
      <nav aria-label="Inspector sections">
        <button className="active" type="button">
          Overview
        </button>
        <button type="button">Metrics</button>
        <button type="button">Config</button>
        <button type="button">Logs</button>
      </nav>
      <section className="inspector__health">
        <span>Modeled utilization</span>
        <strong className={`health-${state}`}>
          {Math.round(utilization * 100)}%
        </strong>
        <small>
          <Pulse size={14} /> Current local frame
        </small>
      </section>
      <section className="inspector__fields">
        <label>
          Instances
          <input
            type="number"
            min="1"
            max="10000"
            value={node.config.instances}
            onChange={(event_) =>
              updateNumber("instances", Number(event_.target.value))
            }
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
      </section>
      {event ? (
        <section className="causal-focus">
          <span>
            <Gear size={14} /> Why this happened
          </span>
          <strong>{event.title}</strong>
          <p>{event.detail}</p>
          {event.parentIds.length ? (
            <small>Caused by {event.parentIds.join(", ")}</small>
          ) : (
            <small>Root scenario event</small>
          )}
        </section>
      ) : null}
    </aside>
  );
}
