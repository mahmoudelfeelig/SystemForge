import {
  analyzeTopologyExecutionBounds,
  incidentCanAffectComponent,
  incidentUsesGlobalWorkload,
  MAX_TOPOLOGY_FANOUT_AMPLIFICATION,
  type Architecture,
  type Scenario,
} from "@systemforge/contracts";

export interface GraphLintIssue {
  id: string;
  severity: "error" | "warning";
  title: string;
  detail: string;
  entityId?: string;
}

const topologyValue = (
  architecture: Architecture,
  key: "region" | "zone" | "failureDomain",
) =>
  new Set(
    architecture.nodes.flatMap((node) => {
      const value = node.config.behavior?.topology?.[key]?.trim();
      return value ? [value] : [];
    }),
  );

export function lintArchitecture(
  scenario: Scenario,
  architecture: Architecture,
): GraphLintIssue[] {
  const issues: GraphLintIssue[] = [];
  const nodeIds = new Set(architecture.nodes.map((node) => node.id));
  const outgoing = new Map<string, Architecture["edges"]>();

  if (architecture.nodes.length === 0)
    issues.push({
      id: "empty-architecture",
      severity: "error",
      title: "Architecture is blank",
      detail: "Add an entry component and at least one reachable dependency.",
    });

  for (const edge of architecture.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target))
      issues.push({
        id: `unknown-endpoint:${edge.id}`,
        severity: "error",
        title: "Link has an unknown endpoint",
        detail: `${edge.source} → ${edge.target} cannot execute until both components exist.`,
        entityId: edge.id,
      });
    const sourceEdges = outgoing.get(edge.source) ?? [];
    sourceEdges.push(edge);
    outgoing.set(edge.source, sourceEdges);
  }

  for (const [sourceId, edges] of outgoing) {
    const explicit = edges.filter(
      (edge) => edge.config?.trafficShare !== undefined,
    );
    if (explicit.length > 0 && explicit.length !== edges.length)
      issues.push({
        id: `mixed-shares:${sourceId}`,
        severity: "error",
        title: "Routing shares are incomplete",
        detail:
          "Set every outgoing link share or leave every share unset for synchronous fan-out.",
        entityId: sourceId,
      });
    if (explicit.length === edges.length) {
      const total = explicit.reduce(
        (sum, edge) => sum + (edge.config?.trafficShare ?? 0),
        0,
      );
      if (total > 1.000_001)
        issues.push({
          id: `share-overflow:${sourceId}`,
          severity: "error",
          title: "Outgoing traffic shares exceed 100%",
          detail: `The configured shares total ${(total * 100).toFixed(1)}%.`,
          entityId: sourceId,
        });
      else if (total < 0.999_999)
        issues.push({
          id: `share-gap:${sourceId}`,
          severity: "error",
          title: "Some outgoing traffic is unassigned",
          detail: `${((1 - total) * 100).toFixed(1)}% of traffic has no configured route. Explicit shares must total 100%.`,
          entityId: sourceId,
        });
    }
  }

  const explicitEntries = architecture.nodes.filter(
    (node) => node.kind === "users" || node.kind === "region",
  );
  const incoming = new Set(
    architecture.edges
      .filter((edge) => (edge.config?.trafficShare ?? 1) > 0)
      .map((edge) => edge.target),
  );
  const entries = explicitEntries.length
    ? explicitEntries
    : architecture.nodes.filter((node) => !incoming.has(node.id));
  if (architecture.nodes.length > 0 && entries.length === 0)
    issues.push({
      id: "no-entry",
      severity: "error",
      title: "No request entry is reachable",
      detail: "Add a Users or Region component, or expose an acyclic root.",
    });

  const reachable = new Set<string>();
  const pending = entries.map((node) => node.id);
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index];
    if (!id || reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of outgoing.get(id) ?? [])
      if ((edge.config?.trafficShare ?? 1) > 0 && nodeIds.has(edge.target))
        pending.push(edge.target);
  }
  for (const node of architecture.nodes) {
    if (!reachable.has(node.id))
      issues.push({
        id: `unreachable:${node.id}`,
        severity: "warning",
        title: `${node.name} is unreachable`,
        detail: "No positive-share path reaches this component from an entry.",
        entityId: node.id,
      });
  }

  const topologyBounds = analyzeTopologyExecutionBounds(architecture);
  if (topologyBounds.reachableCycleNodeIds.length > 0)
    issues.push({
      id: "reachable-cycle",
      severity: "error",
      title: "Reachable feedback cycle cannot execute",
      detail: `Remove the positive-share cycle through ${topologyBounds.reachableCycleNodeIds.join(", ")}.`,
    });
  if (
    !Number.isFinite(topologyBounds.fanoutAmplification) ||
    topologyBounds.fanoutAmplification > MAX_TOPOLOGY_FANOUT_AMPLIFICATION
  )
    issues.push({
      id: "fanout-amplification",
      severity: "error",
      title: "Synchronous fan-out is too large",
      detail: `Partition this route or set explicit traffic shares so modeled amplification stays at or below ${MAX_TOPOLOGY_FANOUT_AMPLIFICATION.toLocaleString("en-US")}.`,
    });

  const regions = topologyValue(architecture, "region");
  const zones = topologyValue(architecture, "zone");
  const failureDomains = topologyValue(architecture, "failureDomain");
  for (const incident of scenario.incidents) {
    const hasPhysicalScope = Boolean(
      incident.targetId ||
      incident.region ||
      incident.zone ||
      incident.failureDomain,
    );
    if (incident.targetId && !nodeIds.has(incident.targetId))
      issues.push({
        id: `incident-target:${incident.id}`,
        severity: "error",
        title: `${incident.label} has an unknown target`,
        detail: `No component has the id ${incident.targetId}.`,
        entityId: incident.id,
      });
    if (incident.region && !regions.has(incident.region))
      issues.push({
        id: `incident-region:${incident.id}`,
        severity: "error",
        title: `${incident.label} names an unknown region`,
        detail: `No workload or component declares ${incident.region}.`,
        entityId: incident.id,
      });
    if (incident.zone && !zones.has(incident.zone))
      issues.push({
        id: `incident-zone:${incident.id}`,
        severity: "error",
        title: `${incident.label} names an unknown zone`,
        detail: `No component declares ${incident.zone}.`,
        entityId: incident.id,
      });
    if (incident.failureDomain && !failureDomains.has(incident.failureDomain))
      issues.push({
        id: `incident-domain:${incident.id}`,
        severity: "error",
        title: `${incident.label} names an unknown failure domain`,
        detail: `No component declares ${incident.failureDomain}.`,
        entityId: incident.id,
      });
    if (incidentUsesGlobalWorkload(incident.kind)) {
      if (hasPhysicalScope)
        issues.push({
          id: `incident-scope:${incident.id}`,
          severity: "error",
          title: `${incident.label} cannot target a component scope`,
          detail:
            "This incident changes the global workload and must not name a component, region, zone, or failure domain.",
          entityId: incident.id,
        });
      continue;
    }
    const knownScope =
      (!incident.targetId || nodeIds.has(incident.targetId)) &&
      (!incident.region || regions.has(incident.region)) &&
      (!incident.zone || zones.has(incident.zone)) &&
      (!incident.failureDomain || failureDomains.has(incident.failureDomain));
    const eligible = knownScope
      ? architecture.nodes.filter((node) => {
          if (!reachable.has(node.id)) return false;
          if (incident.targetId && incident.targetId !== node.id) return false;
          if (
            incident.region &&
            incident.region !== node.config.behavior?.topology?.region
          )
            return false;
          if (
            incident.zone &&
            incident.zone !== node.config.behavior?.topology?.zone
          )
            return false;
          if (
            incident.failureDomain &&
            incident.failureDomain !==
              node.config.behavior?.topology?.failureDomain
          )
            return false;
          return (
            incidentCanAffectComponent(incident.kind, node.kind) &&
            (incident.kind !== "bad-autoscaling" || node.config.autoscale)
          );
        })
      : [];
    if (knownScope && eligible.length === 0)
      issues.push({
        id: `incident-inapplicable:${incident.id}`,
        severity: "error",
        title: `${incident.label} has no applicable target`,
        detail:
          "Choose a reachable component whose modeled capability matches this incident kind.",
        entityId: incident.id,
      });
  }

  return issues;
}
