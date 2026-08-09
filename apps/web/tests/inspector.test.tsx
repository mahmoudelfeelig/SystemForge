// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { architectureNodeSchema } from "@systemforge/contracts";
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
  it("applies only compatible versioned profiles and discloses their evidence", () => {
    const onUpdateNode = vi.fn();
    const view = render(
      <InspectorPanel
        node={node("db")}
        metrics={null}
        event={null}
        workspaceMode="build"
        onUpdateNode={onUpdateNode}
      />,
    );
    const profileSelect = screen.getByLabelText(
      "Compatible behavioral profile",
    );

    expect(
      within(profileSelect).getByRole("option", {
        name: "AWS RDS PostgreSQL · db.r7g.large · v1",
      }),
    ).toBeTruthy();
    expect(
      within(profileSelect).queryByRole("option", {
        name: /ElastiCache/,
      }),
    ).toBeNull();

    fireEvent.change(profileSelect, {
      target: { value: "aws.rds-postgresql.db-r7g-large" },
    });
    const applied = onUpdateNode.mock.lastCall?.[0];
    expect(applied).toMatchObject({
      config: {
        capacityRps: 8_000,
        behavioralProfile: {
          id: "aws.rds-postgresql.db-r7g-large",
          version: 1,
        },
        behavior: {
          compute: { cpuCores: 2, memoryGb: 16 },
          storage: { readIops: 12_000, replicationMode: "sync" },
        },
      },
    });

    view.rerender(
      <InspectorPanel
        node={applied}
        metrics={null}
        event={null}
        workspaceMode="build"
        onUpdateNode={onUpdateNode}
      />,
    );
    expect(
      within(screen.getByLabelText("Behavioral profile")).getByText("None"),
    ).toBeTruthy();
    expect(screen.getByText(/managed PostgreSQL shape/i)).toBeTruthy();
    fireEvent.click(screen.getByText("Assumptions and provenance"));
    expect(
      screen
        .getByRole("link", {
          name: /Supported DB engines for DB instance classes/,
        })
        .getAttribute("href"),
    ).toBe(
      "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.Support.html",
    );

    fireEvent.change(screen.getByLabelText("Read IOPS"), {
      target: { value: "24000" },
    });
    const overridden = onUpdateNode.mock.lastCall?.[0];
    view.rerender(
      <InspectorPanel
        node={overridden}
        metrics={null}
        event={null}
        workspaceMode="build"
        onUpdateNode={onUpdateNode}
      />,
    );
    expect(screen.getByText("1 controlled field")).toBeTruthy();
    expect(screen.getByText(/behavior\.storage\.readIops/)).toBeTruthy();
  });

  it("warns when an imported profile reference cannot be resolved", () => {
    const database = node("db");
    database.config.behavioralProfile = {
      id: "postgresql.community-balanced",
      version: 999,
    };
    render(
      <InspectorPanel
        node={database}
        metrics={null}
        event={null}
        workspaceMode="build"
        onUpdateNode={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert").textContent).toMatch(
      /unsupported version.*simulation will reject/is,
    );
  });

  it("presents absent metrics as a not-run state", () => {
    render(
      <InspectorPanel
        node={node("api")}
        metrics={null}
        event={null}
        workspaceMode="run"
        onUpdateNode={vi.fn()}
      />,
    );

    expect(screen.getByText("not run")).toBeTruthy();
    const health = screen.getByLabelText(
      "Modeled health score unavailable; run not started",
    );
    expect(within(health).getByText("—")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "metrics" }));
    expect(screen.getByText("No modeled resource utilization")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Events" }));
    expect(screen.getByText("No linked event selected.")).toBeTruthy();
  });

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

  it("keeps the autoscaling minimum within the active instance count", () => {
    const onUpdateNode = vi.fn();
    render(
      <InspectorPanel
        node={node("api")}
        metrics={null}
        event={null}
        workspaceMode="build"
        onUpdateNode={onUpdateNode}
      />,
    );

    fireEvent.change(screen.getByLabelText("Minimum instances"), {
      target: { value: "999" },
    });

    const updated = onUpdateNode.mock.lastCall?.[0];
    expect(updated).toMatchObject({
      config: {
        behavior: { scaling: { minInstances: 24 } },
      },
    });
    expect(architectureNodeSchema.safeParse(updated).success).toBe(true);
  });

  it("shows state controls only where their semantics apply", () => {
    const view = render(
      <InspectorPanel
        node={node("api")}
        metrics={null}
        event={null}
        workspaceMode="build"
        onUpdateNode={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("Replicas")).toBeNull();
    expect(screen.queryByLabelText("Consistency")).toBeNull();

    view.rerender(
      <InspectorPanel
        node={node("db")}
        metrics={null}
        event={null}
        workspaceMode="build"
        onUpdateNode={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Replicas")).toBeTruthy();
    expect(screen.getByLabelText("Consistency")).toBeTruthy();

    view.rerender(
      <InspectorPanel
        node={node("queue")}
        metrics={null}
        event={null}
        workspaceMode="build"
        onUpdateNode={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Replicas")).toBeTruthy();
    expect(screen.queryByLabelText("Consistency")).toBeNull();
    expect(screen.getByLabelText("Delivery")).toBeTruthy();
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

  it("keeps replica count and replication mode contract-valid as one control", () => {
    const onUpdateNode = vi.fn();
    const view = render(
      <InspectorPanel
        node={node("db")}
        metrics={null}
        event={null}
        workspaceMode="build"
        onUpdateNode={onUpdateNode}
      />,
    );

    fireEvent.change(screen.getByLabelText("Replicas"), {
      target: { value: "0" },
    });
    const withoutReplicas = onUpdateNode.mock.lastCall?.[0];
    expect(withoutReplicas).toMatchObject({
      config: {
        replicas: 0,
        behavior: { storage: { replicationMode: "none" } },
      },
    });
    expect(architectureNodeSchema.safeParse(withoutReplicas).success).toBe(
      true,
    );

    view.rerender(
      <InspectorPanel
        node={withoutReplicas}
        metrics={null}
        event={null}
        workspaceMode="build"
        onUpdateNode={onUpdateNode}
      />,
    );
    fireEvent.change(screen.getByLabelText("Replication"), {
      target: { value: "async" },
    });
    const restoredReplication = onUpdateNode.mock.lastCall?.[0];
    expect(restoredReplication).toMatchObject({
      config: {
        replicas: 1,
        behavior: { storage: { replicationMode: "async" } },
      },
    });
    expect(architectureNodeSchema.safeParse(restoredReplication).success).toBe(
      true,
    );
  });

  it("exposes executable durable-log capacity for messaging primitives", () => {
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

    fireEvent.change(screen.getByLabelText("Log read IOPS"), {
      target: { value: "42000" },
    });

    const updated = onUpdateNode.mock.lastCall?.[0];
    expect(updated).toMatchObject({
      config: {
        behavior: { storage: { readIops: 42_000 } },
      },
    });
    expect(architectureNodeSchema.safeParse(updated).success).toBe(true);
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

  it("shows one-second modeled link telemetry at the cursor", () => {
    render(
      <InspectorPanel
        node={null}
        edge={structuredClone(DEFAULT_ARCHITECTURE.edges[0])}
        edgeMetrics={{
          attemptedRps: 1200,
          throughputRps: 1100,
          retryRps: 75,
          lostRps: 100,
          packetLossPercent: 8.333,
          latencyMs: 12.5,
          asynchronous: false,
        }}
        metrics={null}
        event={null}
        workspaceMode="investigate"
        onUpdateNode={vi.fn()}
      />,
    );

    const telemetry = screen.getByLabelText("Modeled link telemetry");
    expect(within(telemetry).getByText("1,200 RPS")).toBeTruthy();
    expect(within(telemetry).getByText("75 RPS")).toBeTruthy();
    expect(within(telemetry).getByText("12.50 ms")).toBeTruthy();
    const bandwidthInput = screen.getByLabelText("Bandwidth (Mbps)");
    if (!(bandwidthInput instanceof HTMLInputElement))
      throw new Error("Bandwidth control was not rendered as an input.");
    expect(bandwidthInput.disabled).toBe(true);
  });
});
