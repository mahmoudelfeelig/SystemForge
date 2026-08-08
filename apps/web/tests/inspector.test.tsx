// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_ARCHITECTURE } from "@systemforge/sim-core";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);
import { InspectorPanel } from "../src/components/InspectorPanel";

const node = (id: string) => {
  const match = structuredClone(DEFAULT_ARCHITECTURE.nodes).find(
    (candidate) => candidate.id === id,
  );
  if (!match) throw new Error(`Missing default node ${id}`);
  return match;
};

describe("advanced component behavior inspector", () => {
  it("persists storage capacity changes through the architecture update callback", () => {
    const onUpdateNode = vi.fn();
    render(
      <InspectorPanel
        node={node("db")}
        metrics={null}
        event={null}
        workspaceMode="build"
        onUpdateNode={onUpdateNode}
      />,
    );

    fireEvent.change(screen.getByLabelText("Read IOPS"), {
      target: { value: "65000" },
    });

    expect(onUpdateNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          behavior: expect.objectContaining({
            storage: expect.objectContaining({ readIops: 65_000 }),
          }),
        }),
      }),
    );
  });

  it("keeps scaling bounds valid when the active instance count increases", () => {
    const onUpdateNode = vi.fn();
    const api = node("api");
    render(
      <InspectorPanel
        node={api}
        metrics={null}
        event={null}
        workspaceMode="build"
        onUpdateNode={onUpdateNode}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "config" }));
    fireEvent.change(screen.getByLabelText("Instances"), {
      target: { value: "80" },
    });

    expect(onUpdateNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          instances: 80,
          maxInstances: 80,
        }),
      }),
    );
  });

  it("exposes delivery semantics for messaging primitives", () => {
    const onUpdateNode = vi.fn();
    render(
      <InspectorPanel
        node={node("queue")}
        metrics={null}
        event={null}
        workspaceMode="build"
        onUpdateNode={onUpdateNode}
      />,
    );

    fireEvent.change(screen.getByLabelText("Delivery"), {
      target: { value: "exactly-once" },
    });

    expect(onUpdateNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          behavior: expect.objectContaining({
            messaging: expect.objectContaining({ delivery: "exactly-once" }),
          }),
        }),
      }),
    );
  });

  it("exposes the cache baseline hit rate consumed by the solver", () => {
    const onUpdateNode = vi.fn();
    render(
      <InspectorPanel
        node={node("cache")}
        metrics={null}
        event={null}
        workspaceMode="build"
        onUpdateNode={onUpdateNode}
      />,
    );

    fireEvent.change(screen.getByLabelText("Baseline hit rate (0–1)"), {
      target: { value: "0.42" },
    });

    expect(onUpdateNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ cacheHitRate: 0.42 }),
      }),
    );
  });

  it("persists transport behavior through the edge inspector", () => {
    const onUpdateEdge = vi.fn();
    const edge = structuredClone(DEFAULT_ARCHITECTURE.edges[0])!;
    render(
      <InspectorPanel
        node={null}
        edge={edge}
        metrics={null}
        event={null}
        workspaceMode="build"
        onUpdateNode={vi.fn()}
        onUpdateEdge={onUpdateEdge}
      />,
    );

    fireEvent.change(screen.getByLabelText("Bandwidth (Mbps)"), {
      target: { value: "250" },
    });
    fireEvent.click(screen.getByLabelText("Asynchronous boundary"));

    expect(onUpdateEdge).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        config: expect.objectContaining({ bandwidthMbps: 250 }),
      }),
    );
    expect(onUpdateEdge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ asynchronous: true }),
      }),
    );
  });
});
