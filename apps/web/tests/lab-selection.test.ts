import { describe, expect, it } from "vitest";
import type { SampledSpan } from "@systemforge/contracts";
import { DEFAULT_ARCHITECTURE } from "@systemforge/sim-core";
import type { TracePlaybackSelection } from "../src/components/TelemetryPanel";
import {
  applySelectionChanges,
  resolveTracePlaybackTopologyFocus,
  topologyEdgeShouldAnimate,
} from "../src/pages/LabPage";

const playbackSelection = (span: SampledSpan): TracePlaybackSelection => ({
  trace: {
    traceId: "trace-focus",
    second: 12,
    requestClass: "Confirm order",
    modeledRps: 1_200,
    entryNodeId: "api",
    terminalNodeId: "worker",
    truncated: false,
    spans: [span],
  },
  span,
  spanIndex: 0,
  spanCount: 1,
  playing: false,
  reducedMotion: false,
});

const sampledSpan = (overrides: Partial<SampledSpan>): SampledSpan => ({
  spanId: "span-focus",
  kind: "entry",
  name: "Focused span",
  attemptedRps: 1_200,
  throughputRps: 1_200,
  retryRps: 0,
  lostRps: 0,
  latencyMs: 5,
  asynchronous: false,
  status: "ok",
  ...overrides,
});

describe("Lab controlled selection", () => {
  it("applies additive and removal changes without collapsing other edges", () => {
    expect(
      applySelectionChanges(
        ["edge-a"],
        [
          { id: "edge-b", selected: true },
          { id: "edge-c", selected: true },
        ],
      ),
    ).toEqual(["edge-a", "edge-b", "edge-c"]);

    expect(
      applySelectionChanges(
        ["edge-a", "edge-b", "edge-c"],
        [{ id: "edge-b", selected: false }],
      ),
    ).toEqual(["edge-a", "edge-c"]);
  });

  it("applies a batched replacement selection coherently", () => {
    expect(
      applySelectionChanges(
        ["edge-a", "edge-b"],
        [
          { id: "edge-a", selected: false },
          { id: "edge-b", selected: false },
          { id: "edge-c", selected: true },
        ],
      ),
    ).toEqual(["edge-c"]);
  });

  it("resolves an exact source-edge-target retry tuple", () => {
    const focus = resolveTracePlaybackTopologyFocus(
      DEFAULT_ARCHITECTURE.nodes,
      DEFAULT_ARCHITECTURE.edges,
      playbackSelection(
        sampledSpan({
          kind: "retry",
          edgeId: "e-api-db",
          sourceNodeId: "api",
          targetNodeId: "db",
          retryAttempt: 2,
          failureCause: "target-offline",
          status: "dropped",
        }),
      ),
    );

    expect(focus.edgeId).toBe("e-api-db");
    expect(focus.nodeRoles.get("api")).toBe("source");
    expect(focus.nodeRoles.get("db")).toBe("target");
    expect(focus.unresolvedEntityIds).toEqual([]);
  });

  it("focuses cache and asynchronous lineage spans on their exact node", () => {
    const cacheFocus = resolveTracePlaybackTopologyFocus(
      DEFAULT_ARCHITECTURE.nodes,
      DEFAULT_ARCHITECTURE.edges,
      playbackSelection(
        sampledSpan({
          kind: "cache",
          nodeId: "cache",
          edgeId: "e-api-cache",
          cacheHitRps: 560,
          cacheMissRps: 140,
        }),
      ),
    );
    expect(cacheFocus.edgeId).toBeNull();
    expect(cacheFocus.inspectorNodeId).toBe("cache");
    expect(cacheFocus.nodeRoles.get("cache")).toBe("node");

    const asyncFocus = resolveTracePlaybackTopologyFocus(
      DEFAULT_ARCHITECTURE.nodes,
      DEFAULT_ARCHITECTURE.edges,
      playbackSelection(
        sampledSpan({
          kind: "async-queue",
          nodeId: "queue",
          edgeId: "e-api-queue",
          messageId: "message-child",
          parentMessageId: "message-root",
          asynchronous: true,
        }),
      ),
    );
    expect(asyncFocus.edgeId).toBeNull();
    expect(asyncFocus.inspectorNodeId).toBe("queue");
    expect(asyncFocus.nodeRoles.get("queue")).toBe("node");
  });

  it("does not guess mismatched or retired topology entities", () => {
    const focus = resolveTracePlaybackTopologyFocus(
      DEFAULT_ARCHITECTURE.nodes,
      DEFAULT_ARCHITECTURE.edges,
      playbackSelection(
        sampledSpan({
          kind: "edge",
          edgeId: "e-api-db",
          sourceNodeId: "api",
          targetNodeId: "retired-db",
        }),
      ),
    );

    expect(focus.edgeId).toBeNull();
    expect(focus.nodeRoles.get("api")).toBe("source");
    expect(focus.nodeRoles.has("retired-db")).toBe(false);
    expect(focus.unresolvedEntityIds).toEqual(
      expect.arrayContaining(["retired-db", "e-api-db"]),
    );
  });

  it("uses static edges whenever path playback owns topology focus", () => {
    expect(topologyEdgeShouldAnimate(true, "investigate", false)).toBe(true);
    expect(topologyEdgeShouldAnimate(true, "investigate", true)).toBe(false);
    expect(topologyEdgeShouldAnimate(true, "build", false)).toBe(false);
  });
});
