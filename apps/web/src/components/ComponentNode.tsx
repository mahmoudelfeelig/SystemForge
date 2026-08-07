import { CheckCircle, Warning, WarningOctagon } from "@phosphor-icons/react";
import type { ArchitectureNode } from "@systemforge/contracts";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { COMPONENT_ICONS } from "./componentIcons";

export interface SystemNodeData extends Record<string, unknown> {
  component: ArchitectureNode;
  utilization: number;
  detail: string;
}

export type SystemFlowNode = Node<SystemNodeData, "system">;

export function ComponentNode({ data, selected }: NodeProps<SystemFlowNode>) {
  const { component, utilization } = data;
  const Icon = COMPONENT_ICONS[component.kind];
  const state =
    utilization >= 1 ? "critical" : utilization >= 0.72 ? "warning" : "healthy";
  const StateIcon =
    state === "critical"
      ? WarningOctagon
      : state === "warning"
        ? Warning
        : CheckCircle;

  return (
    <article
      className={`system-node system-node--${state} ${selected ? "system-node--selected" : ""}`}
      aria-label={`${component.name}, ${Math.round(utilization * 100)} percent utilized`}
    >
      <Handle type="target" position={Position.Left} />
      <header>
        <span className="system-node__kind">
          <Icon size={14} weight="duotone" aria-hidden="true" />
        </span>
        <strong>{component.name}</strong>
        <StateIcon
          className="system-node__state"
          size={14}
          weight="fill"
          aria-label={state}
        />
      </header>
      <div className="system-node__metrics">
        <span>
          {component.config.instances}{" "}
          {component.config.instances === 1 ? "instance" : "instances"}
        </span>
        <strong>{Math.round(utilization * 100)}%</strong>
      </div>
      <small>{data.detail}</small>
      <Handle type="source" position={Position.Right} />
    </article>
  );
}
