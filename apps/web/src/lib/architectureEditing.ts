import type { Architecture } from "@systemforge/contracts";

export function connectArchitecture(
  architecture: Architecture,
  connection: { source: string | null; target: string | null },
  createId: () => string = () => crypto.randomUUID(),
): Architecture {
  if (!connection.source || !connection.target) return architecture;
  return {
    ...architecture,
    edges: [
      ...architecture.edges,
      {
        id: `edge-${connection.source}-${connection.target}-${createId()}`,
        source: connection.source,
        target: connection.target,
      },
    ],
  };
}

export function removeArchitectureNodes(
  architecture: Architecture,
  nodeIds: readonly string[],
): Architecture {
  return removeArchitectureElements(architecture, nodeIds, []);
}

export function removeArchitectureElements(
  architecture: Architecture,
  nodeIds: readonly string[],
  edgeIds: readonly string[],
): Architecture {
  const removed = new Set(nodeIds);
  const removedEdges = new Set(edgeIds);
  return {
    ...architecture,
    nodes: architecture.nodes.filter((node) => !removed.has(node.id)),
    edges: architecture.edges.filter(
      (edge) =>
        !removedEdges.has(edge.id) &&
        !removed.has(edge.source) &&
        !removed.has(edge.target),
    ),
  };
}

export function duplicateArchitectureSelection(
  architecture: Architecture,
  nodeIds: readonly string[],
  createId: () => string = () => crypto.randomUUID(),
): { architecture: Architecture; selectedNodeIds: string[] } {
  const sourceSet = new Set(nodeIds);
  const idMap = new Map<string, string>();
  nodeIds.forEach((id) => idMap.set(id, `${id}-copy-${createId()}`));
  const copies = architecture.nodes
    .filter((node) => sourceSet.has(node.id))
    .map((node) => ({
      ...structuredClone(node),
      id: idMap.get(node.id)!,
      name: `${node.name} copy`,
      position: { x: node.position.x + 36, y: node.position.y + 36 },
    }));
  const copiedEdges = architecture.edges
    .filter((edge) => sourceSet.has(edge.source) && sourceSet.has(edge.target))
    .map((edge) => ({
      ...structuredClone(edge),
      id: `${edge.id}-copy-${createId()}`,
      source: idMap.get(edge.source)!,
      target: idMap.get(edge.target)!,
    }));
  return {
    architecture: {
      ...architecture,
      nodes: [...architecture.nodes, ...copies],
      edges: [...architecture.edges, ...copiedEdges],
    },
    selectedNodeIds: copies.map((node) => node.id),
  };
}

export function autoLayoutArchitecture(
  architecture: Architecture,
): Architecture {
  if (architecture.nodes.length === 0) return architecture;
  const outgoing = new Map<string, string[]>();
  architecture.edges.forEach((edge) => {
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  });
  const depth = new Map<string, number>();
  const queue = architecture.nodes
    .filter((node) => node.kind === "users")
    .map((node) => {
      depth.set(node.id, 0);
      return node.id;
    });
  if (queue.length === 0 && architecture.nodes[0]) {
    depth.set(architecture.nodes[0].id, 0);
    queue.push(architecture.nodes[0].id);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const source = queue[cursor]!;
    const nextDepth = (depth.get(source) ?? 0) + 1;
    for (const target of outgoing.get(source) ?? []) {
      if (depth.has(target)) continue;
      depth.set(target, nextDepth);
      queue.push(target);
    }
  }
  const fallbackDepth = Math.max(0, ...depth.values()) + 1;
  const rowsByDepth = new Map<number, number>();
  return {
    ...architecture,
    nodes: architecture.nodes.map((node) => {
      const column = depth.get(node.id) ?? fallbackDepth;
      const row = rowsByDepth.get(column) ?? 0;
      rowsByDepth.set(column, row + 1);
      return {
        ...node,
        position: { x: 70 + column * 230, y: 72 + row * 152 },
      };
    }),
  };
}

export function blankArchitecture(
  architecture: Architecture,
  id = `architecture-${crypto.randomUUID()}`,
): Architecture {
  return {
    ...architecture,
    id,
    name: "Untitled architecture",
    nodes: [],
    edges: [],
  };
}
