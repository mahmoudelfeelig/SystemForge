import {
  modeledIncidentDurationSeconds,
  type Architecture,
  type ArchitectureNode,
  type Incident,
} from "@systemforge/contracts";

export type ArchitecturePlacementScope = "region" | "failure-domain";

export interface ArchitecturePlacementGroup {
  id: string;
  scope: ArchitecturePlacementScope;
  label: string;
  nodeIds: string[];
  bounds: { x: number; y: number; width: number; height: number };
}

export const architectureNodeDimensions = (
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

const placementLabel = (
  node: ArchitectureNode,
  scope: ArchitecturePlacementScope,
): string | null => {
  const raw =
    scope === "region"
      ? node.config.behavior?.topology?.region
      : node.config.behavior?.topology?.failureDomain;
  const label = raw?.trim();
  return label ? label : null;
};

export const deriveArchitecturePlacementGroups = (
  architecture: Architecture,
  scope: ArchitecturePlacementScope,
): ArchitecturePlacementGroup[] => {
  const nodesByLabel = new Map<string, ArchitectureNode[]>();
  for (const node of architecture.nodes) {
    const label = placementLabel(node, scope);
    if (!label) continue;
    nodesByLabel.set(label, [...(nodesByLabel.get(label) ?? []), node]);
  }

  const padding =
    scope === "region"
      ? { left: 30, right: 30, top: 36, bottom: 24 }
      : { left: 16, right: 16, top: 26, bottom: 16 };

  return [...nodesByLabel.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, nodes]) => {
      const left = Math.min(...nodes.map((node) => node.position.x));
      const top = Math.min(...nodes.map((node) => node.position.y));
      const right = Math.max(
        ...nodes.map(
          (node) =>
            node.position.x + architectureNodeDimensions(node.kind).width,
        ),
      );
      const bottom = Math.max(
        ...nodes.map(
          (node) =>
            node.position.y + architectureNodeDimensions(node.kind).height,
        ),
      );
      return {
        id: `${scope}:${label}`,
        scope,
        label,
        nodeIds: nodes.map((node) => node.id),
        bounds: {
          x: left - padding.left,
          y: top - padding.top,
          width: right - left + padding.left + padding.right,
          height: bottom - top + padding.top + padding.bottom,
        },
      };
    });
};

export const activeArchitecturePlacementGroupIds = (
  incidents: readonly Incident[],
  second: number,
  scenarioDurationSeconds: number,
): Set<string> => {
  const active = new Set<string>();
  for (const incident of incidents) {
    const duration = modeledIncidentDurationSeconds(
      incident,
      scenarioDurationSeconds,
    );
    if (second < incident.atSecond || second >= incident.atSecond + duration)
      continue;
    const region = incident.region?.trim();
    const failureDomain = incident.failureDomain?.trim();
    if (region) active.add(`region:${region}`);
    if (failureDomain) active.add(`failure-domain:${failureDomain}`);
  }
  return active;
};
