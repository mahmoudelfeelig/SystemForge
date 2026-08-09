// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
} from "@systemforge/sim-core";
import type { SampledTrace, SimulationResult } from "@systemforge/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TelemetryPanel,
  traceSpanSignals,
  unresolvedTraceEntityIds,
} from "../src/components/TelemetryPanel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const sampledTraceResult = (): SimulationResult => {
  const result = structuredClone(
    simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE),
  );
  const primaryTrace: SampledTrace = {
    traceId: "trace-ui-primary",
    second: 12,
    requestClass: "Confirm order",
    modeledRps: 1_200,
    entryNodeId: "api",
    terminalNodeId: "worker",
    truncated: true,
    spans: [
      {
        spanId: "span-entry",
        kind: "entry",
        name: "Enter api",
        nodeId: "api",
        attemptedRps: 1_200,
        throughputRps: 1_200,
        retryRps: 0,
        lostRps: 0,
        latencyMs: 0,
        queryClass: "mixed",
        messageId: "message-request-root",
        asynchronous: false,
        status: "ok",
      },
      {
        spanId: "span-db-edge",
        parentSpanId: "span-entry",
        kind: "edge",
        name: "api to db",
        edgeId: "e-api-db",
        sourceNodeId: "api",
        targetNodeId: "db",
        attemptedRps: 1_200,
        throughputRps: 900,
        retryRps: 200,
        lostRps: 100,
        latencyMs: 43.25,
        queryClass: "read",
        messageId: "message-request-root",
        connectionPoolWaitMs: 7.5,
        failureCause: "capacity-pressure",
        asynchronous: false,
        status: "degraded",
      },
      {
        spanId: "span-db-retry",
        parentSpanId: "span-db-edge",
        kind: "retry",
        name: "Retry e-api-db attempt 2",
        edgeId: "e-api-db",
        sourceNodeId: "api",
        targetNodeId: "db",
        attemptedRps: 80,
        throughputRps: 20,
        retryRps: 80,
        lostRps: 60,
        latencyMs: 43.25,
        retryAttempt: 2,
        queryClass: "write",
        messageId: "message-request-root",
        failureCause: "target-offline",
        asynchronous: false,
        status: "dropped",
      },
      {
        spanId: "span-cache",
        parentSpanId: "span-entry",
        kind: "cache",
        name: "Cache decision at cache",
        nodeId: "cache",
        edgeId: "e-api-cache",
        attemptedRps: 700,
        throughputRps: 560,
        retryRps: 0,
        lostRps: 0,
        latencyMs: 0,
        cacheHitRps: 560,
        cacheMissRps: 140,
        messageId: "message-request-root",
        asynchronous: false,
        status: "ok",
      },
      {
        spanId: "span-queue-edge",
        parentSpanId: "span-entry",
        kind: "edge",
        name: "api to queue",
        edgeId: "e-api-queue",
        sourceNodeId: "api",
        targetNodeId: "queue",
        attemptedRps: 300,
        throughputRps: 295,
        retryRps: 0,
        lostRps: 5,
        latencyMs: 12,
        messageId: "message-request-root",
        asynchronous: true,
        status: "degraded",
      },
      {
        spanId: "span-enqueue",
        parentSpanId: "span-queue-edge",
        kind: "async-queue",
        name: "Enqueue at queue",
        nodeId: "queue",
        edgeId: "e-api-queue",
        attemptedRps: 295,
        throughputRps: 295,
        retryRps: 0,
        lostRps: 0,
        latencyMs: 0,
        messageId: "message-queue-1",
        parentMessageId: "message-request-root",
        asynchronous: true,
        status: "ok",
      },
      {
        spanId: "span-terminal",
        parentSpanId: "span-enqueue",
        kind: "terminal",
        name: "Terminate at worker",
        nodeId: "worker",
        attemptedRps: 295,
        throughputRps: 290,
        retryRps: 0,
        lostRps: 5,
        latencyMs: 18,
        messageId: "message-queue-1",
        parentMessageId: "message-request-root",
        asynchronous: false,
        status: "degraded",
      },
    ],
  };
  const secondaryTrace: SampledTrace = {
    traceId: "trace-ui-secondary",
    second: 24,
    requestClass: "Browse catalogue",
    modeledRps: 600,
    entryNodeId: "api",
    terminalNodeId: "cache",
    truncated: false,
    spans: [
      {
        spanId: "span-secondary-entry",
        kind: "entry",
        name: "Enter api",
        nodeId: "api",
        attemptedRps: 600,
        throughputRps: 600,
        retryRps: 0,
        lostRps: 0,
        latencyMs: 0,
        queryClass: "read",
        messageId: "message-secondary-root",
        asynchronous: false,
        status: "ok",
      },
    ],
  };
  result.traces = [secondaryTrace, primaryTrace];
  return result;
};

describe("operational telemetry workspace", () => {
  it("labels the pre-run plan without implying measured results", () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.incidents = [];
    scenario.requirements = [];

    render(
      <TelemetryPanel
        result={null}
        scenario={scenario}
        nodes={DEFAULT_ARCHITECTURE.nodes}
        selectedEventId={null}
        currentSecond={0}
        onSelectEvent={vi.fn()}
        onSeek={vi.fn()}
      />,
    );

    expect(screen.getByText("No modeled run yet")).toBeTruthy();
    expect(
      screen.getByText("No incidents are scheduled for this scenario."),
    ).toBeTruthy();
    expect(
      screen.getByText("No visible objectives are defined for this role."),
    ).toBeTruthy();
    expect(screen.queryByText(/measured/i)).toBeNull();
    expect(
      screen.getByText(/Request traces are sampled, not exhaustive/),
    ).toBeTruthy();
  });

  it("renders delivered frames before the local run completes", () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const frames = result.frames.slice(0, 8);
    const events = result.events.filter(
      (event) => event.second <= (frames.at(-1)?.second ?? 0),
    );

    render(
      <TelemetryPanel
        result={null}
        liveFrames={frames}
        liveEvents={events}
        running
        progress={0.25}
        scenario={DEFAULT_SCENARIO}
        nodes={DEFAULT_ARCHITECTURE.nodes}
        selectedEventId={null}
        currentSecond={frames.length - 1}
        onSelectEvent={vi.fn()}
        onSeek={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Modeled simulation results")).toBeTruthy();
    expect(screen.getAllByText(/25% delivered/).length).toBeGreaterThan(0);
    expect(screen.queryByText("No modeled run yet")).toBeNull();
  });

  it("shows explicit empty results when a run emits no events or utilization", () => {
    const result = structuredClone(
      simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE),
    );
    result.events = [];
    result.frames.forEach((frame) => {
      frame.nodeMetrics = {};
    });

    render(
      <TelemetryPanel
        result={result}
        scenario={DEFAULT_SCENARIO}
        nodes={DEFAULT_ARCHITECTURE.nodes}
        edges={DEFAULT_ARCHITECTURE.edges}
        selectedEventId={null}
        currentSecond={result.frames.length - 1}
        onSelectEvent={vi.fn()}
        onSeek={vi.fn()}
      />,
    );

    expect(screen.getByText("0 linked events")).toBeTruthy();
    expect(
      screen.getAllByText("No modeled events were emitted for this run."),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(
      screen.getByText("No modeled utilization was recorded for CPU."),
    ).toBeTruthy();
  });

  it("switches modeled resource histories and exposes a linked event path", () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const onSelectEvent = vi.fn();
    const onSeek = vi.fn();

    render(
      <TelemetryPanel
        result={result}
        scenario={DEFAULT_SCENARIO}
        nodes={DEFAULT_ARCHITECTURE.nodes}
        edges={DEFAULT_ARCHITECTURE.edges}
        selectedEventId={null}
        currentSecond={result.frames.length - 1}
        onSelectEvent={onSelectEvent}
        onSeek={onSeek}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    const cpu = screen.getByRole("button", { name: "CPU" });
    const memory = screen.getByRole("button", { name: "Memory" });
    const throughput = screen.getByRole("button", {
      name: "Throughput (RPS)",
    });
    expect(cpu.getAttribute("aria-pressed")).toBe("true");
    expect(throughput.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(memory);
    fireEvent.click(throughput);
    expect(memory.getAttribute("aria-pressed")).toBe("true");
    expect(throughput.getAttribute("aria-pressed")).toBe("false");

    fireEvent.change(screen.getByLabelText("Telemetry zoom window"), {
      target: { value: "30" },
    });
    expect(
      screen.getByLabelText<HTMLSelectElement>("Telemetry zoom window").value,
    ).toBe("30");
    expect(
      screen.getByLabelText("Current and peak telemetry values"),
    ).toBeTruthy();

    const causalRail = screen.getByLabelText("Linked event path");
    expect(within(causalRail).getByText("First linked event")).toBeTruthy();

    const firstCausalEvent = within(causalRail).getAllByRole("button")[0]!;
    fireEvent.click(firstCausalEvent);
    expect(onSelectEvent).toHaveBeenCalledOnce();
    expect(onSeek).toHaveBeenCalledOnce();
  });

  it("surfaces exact sampled span order, lineage, and modeled decisions", () => {
    const result = sampledTraceResult();
    const onSeek = vi.fn();
    render(
      <TelemetryPanel
        result={result}
        scenario={DEFAULT_SCENARIO}
        nodes={DEFAULT_ARCHITECTURE.nodes}
        edges={DEFAULT_ARCHITECTURE.edges}
        selectedEventId={null}
        currentSecond={result.frames.length - 1}
        onSelectEvent={vi.fn()}
        onSeek={onSeek}
      />,
    );

    const selector = screen.getByLabelText("Request trace");
    expect((selector as HTMLSelectElement).value).toBe("trace-ui-primary");
    expect(screen.getByText("trace-ui-primary")).toBeTruthy();
    expect(screen.getByText(/Truncated by the bounded span cap/)).toBeTruthy();
    expect(screen.getByText(/not an exhaustive request log/)).toBeTruthy();

    const spanOrder = screen.getByRole("listbox", {
      name: "Modeled span sequence",
    });
    const spans = within(spanOrder).getAllByRole("option");
    expect(spans).toHaveLength(7);
    expect(spans[0]?.textContent).toContain("01Entry · Enter api");
    expect(spans[1]?.textContent).toContain(
      "API Gateway · api → PostgreSQL Primary · db",
    );
    expect(spans[1]?.textContent).toContain("e-api-db");

    fireEvent.click(spans[1]!);
    expect(
      within(spans[1]!).getByText("Failure · capacity pressure"),
    ).toBeTruthy();
    expect(within(spans[1]!).getByText("Degraded delivery")).toBeTruthy();
    let detail = screen.getByLabelText("Selected span details");
    expect(within(detail).getByText("span-db-edge")).toBeTruthy();
    expect(within(detail).getByText("span-entry")).toBeTruthy();
    expect(within(detail).getByText("e-api-db")).toBeTruthy();
    expect(within(detail).getByText("read")).toBeTruthy();
    expect(within(detail).getByText("7.5 ms modeled")).toBeTruthy();
    expect(within(detail).getByText("capacity pressure")).toBeTruthy();

    fireEvent.click(spans[2]!);
    expect(within(spans[2]!).getByText("Retry attempt 2")).toBeTruthy();
    expect(
      within(spans[2]!).getByText("Failure · target offline"),
    ).toBeTruthy();
    expect(within(spans[2]!).getByText("Dropped delivery")).toBeTruthy();
    detail = screen.getByLabelText("Selected span details");
    expect(
      within(detail).getByText("Retry attempt").parentElement?.textContent,
    ).toBe("Retry attempt2");
    expect(within(detail).getByText("target offline")).toBeTruthy();

    fireEvent.click(spans[3]!);
    expect(
      within(spans[3]!).getByText("Cache 560 hit / 140 miss RPS"),
    ).toBeTruthy();
    detail = screen.getByLabelText("Selected span details");
    expect(
      within(detail).getByText("Cache decision").parentElement?.textContent,
    ).toContain("Hit 560 RPS · miss 140 RPS");

    fireEvent.click(spans[5]!);
    expect(
      within(spans[5]!).getByText(
        "Async lineage · message-queue-1 from message-request-root",
      ),
    ).toBeTruthy();
    detail = screen.getByLabelText("Selected span details");
    expect(within(detail).getByText("Asynchronous")).toBeTruthy();
    expect(within(detail).getByText("message-queue-1")).toBeTruthy();
    expect(within(detail).getByText("message-request-root")).toBeTruthy();

    fireEvent.change(selector, { target: { value: "trace-ui-secondary" } });
    expect(onSeek).toHaveBeenCalledWith(24);
    expect(screen.getByText("trace-ui-secondary")).toBeTruthy();
    expect(screen.queryByText(/Truncated by the bounded span cap/)).toBeNull();
  });

  it("supports roving keyboard selection through sampled spans", () => {
    const result = sampledTraceResult();
    render(
      <TelemetryPanel
        result={result}
        scenario={DEFAULT_SCENARIO}
        nodes={DEFAULT_ARCHITECTURE.nodes}
        edges={DEFAULT_ARCHITECTURE.edges}
        selectedEventId={null}
        currentSecond={12}
        onSelectEvent={vi.fn()}
        onSeek={vi.fn()}
      />,
    );
    const spanOrder = screen.getByRole("listbox", {
      name: "Modeled span sequence",
    });
    const spans = within(spanOrder).getAllByRole("option");

    spans[0]!.focus();
    fireEvent.keyDown(spans[0]!, { key: "ArrowDown" });
    expect(spans[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(spans[1]);

    fireEvent.keyDown(spans[1]!, { key: "End" });
    expect(spans.at(-1)?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(spans.at(-1));
  });

  it("drives discrete path playback with buttons, scrubber, and keyboard", () => {
    vi.useFakeTimers();
    const result = sampledTraceResult();
    const onSeek = vi.fn();
    const onTracePlaybackChange = vi.fn();
    render(
      <TelemetryPanel
        result={result}
        scenario={DEFAULT_SCENARIO}
        nodes={DEFAULT_ARCHITECTURE.nodes}
        edges={DEFAULT_ARCHITECTURE.edges}
        selectedEventId={null}
        currentSecond={result.frames.length - 1}
        onSelectEvent={vi.fn()}
        onSeek={onSeek}
        onTracePlaybackChange={onTracePlaybackChange}
      />,
    );

    const controls = screen.getByLabelText("Path playback controls");
    controls.focus();
    fireEvent.keyDown(controls, { key: "ArrowRight" });
    expect(screen.getByText("Step 2 of 7")).toBeTruthy();
    expect(onSeek).toHaveBeenCalledWith(12);
    expect(onTracePlaybackChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        spanIndex: 1,
        spanCount: 7,
        playing: false,
      }),
    );

    fireEvent.change(screen.getByLabelText("Path step"), {
      target: { value: "4" },
    });
    expect(screen.getByText("Step 4 of 7")).toBeTruthy();
    expect(onTracePlaybackChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ spanIndex: 3 }),
    );

    fireEvent.keyDown(controls, { key: "Home" });
    expect(screen.getByText("Step 1 of 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Play path" }));
    expect(screen.getByRole("button", { name: "Pause path" })).toBeTruthy();
    expect(onTracePlaybackChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ spanIndex: 0, playing: true }),
    );

    act(() => {
      vi.advanceTimersByTime(850);
    });
    expect(screen.getByText("Step 2 of 7")).toBeTruthy();
    expect(onTracePlaybackChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ spanIndex: 1, playing: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause path" }));
    expect(onTracePlaybackChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ spanIndex: 1, playing: false }),
    );
  });

  it("keeps reduced-motion playback functional with static-step evidence", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const result = sampledTraceResult();
    const onTracePlaybackChange = vi.fn();
    render(
      <TelemetryPanel
        result={result}
        scenario={DEFAULT_SCENARIO}
        nodes={DEFAULT_ARCHITECTURE.nodes}
        edges={DEFAULT_ARCHITECTURE.edges}
        selectedEventId={null}
        currentSecond={12}
        onSelectEvent={vi.fn()}
        onSeek={vi.fn()}
        onTracePlaybackChange={onTracePlaybackChange}
      />,
    );

    expect(
      screen.getByText(/Reduced motion is on.*discrete, static topology/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Play path" }));
    expect(onTracePlaybackChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ reducedMotion: true, playing: true }),
    );
  });

  it("keeps unresolved sampled entities available as textual evidence", () => {
    const result = sampledTraceResult();
    result.traces = [
      {
        ...result.traces![0]!,
        truncated: true,
        spans: [
          {
            ...result.traces![0]!.spans[0]!,
            nodeId: "retired-api-node",
          },
        ],
      },
    ];
    render(
      <TelemetryPanel
        result={result}
        scenario={DEFAULT_SCENARIO}
        nodes={DEFAULT_ARCHITECTURE.nodes}
        edges={DEFAULT_ARCHITECTURE.edges}
        selectedEventId={null}
        currentSecond={12}
        onSelectEvent={vi.fn()}
        onSeek={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Play path" }));
    expect(
      screen.getByText(/Topology focus unavailable for retired-api-node/),
    ).toBeTruthy();
    expect(screen.getByText(/textual trace remains available/i)).toBeTruthy();
    expect(screen.getByText(/Truncated by the bounded span cap/)).toBeTruthy();
  });

  it("classifies sampled cache, retry, async, and failure evidence", () => {
    const spans = sampledTraceResult().traces!.find(
      (trace) => trace.traceId === "trace-ui-primary",
    )!.spans;
    expect(traceSpanSignals(spans[2]!)).toEqual(
      expect.arrayContaining([
        { kind: "retry", label: "Retry attempt 2" },
        { kind: "failure", label: "Failure · target offline" },
        { kind: "failure", label: "Dropped delivery" },
      ]),
    );
    expect(traceSpanSignals(spans[3]!)).toContainEqual({
      kind: "cache",
      label: "Cache 560 hit / 140 miss RPS",
    });
    expect(traceSpanSignals(spans[5]!)).toContainEqual({
      kind: "async",
      label: "Async lineage · message-queue-1 from message-request-root",
    });
    expect(
      unresolvedTraceEntityIds(
        { ...spans[1]!, edgeId: "retired-edge" },
        DEFAULT_ARCHITECTURE.nodes,
        DEFAULT_ARCHITECTURE.edges,
      ),
    ).toContain("retired-edge");
  });

  it("distinguishes pending and completed runs with no sampled traces", () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    delete result.traces;
    const { rerender } = render(
      <TelemetryPanel
        result={null}
        liveFrames={result.frames.slice(0, 8)}
        liveEvents={[]}
        running
        progress={0.25}
        scenario={DEFAULT_SCENARIO}
        nodes={DEFAULT_ARCHITECTURE.nodes}
        selectedEventId={null}
        currentSecond={7}
        onSelectEvent={vi.fn()}
        onSeek={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Traces" }));
    expect(screen.getByText("Trace sample pending")).toBeTruthy();
    expect(screen.getByText(/25% of modeled frames delivered/)).toBeTruthy();

    rerender(
      <TelemetryPanel
        result={result}
        scenario={DEFAULT_SCENARIO}
        nodes={DEFAULT_ARCHITECTURE.nodes}
        selectedEventId={null}
        currentSecond={result.frames.length - 1}
        onSelectEvent={vi.fn()}
        onSeek={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Traces" }));
    expect(screen.getByText("Trace samples unavailable")).toBeTruthy();
    expect(
      screen.getByText(/does not include request trace evidence/),
    ).toBeTruthy();

    rerender(
      <TelemetryPanel
        result={{ ...result, traces: [] }}
        scenario={DEFAULT_SCENARIO}
        nodes={DEFAULT_ARCHITECTURE.nodes}
        selectedEventId={null}
        currentSecond={result.frames.length - 1}
        onSelectEvent={vi.fn()}
        onSeek={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Traces" }));
    expect(screen.getByText("No request traces sampled")).toBeTruthy();
    expect(
      screen.getByText(/completed with zero representative request traces/),
    ).toBeTruthy();
  });

  it("reports an emitted trace with no sampled spans", () => {
    const result = sampledTraceResult();
    result.traces = [
      {
        ...result.traces![0]!,
        spans: [],
      },
    ];

    render(
      <TelemetryPanel
        result={result}
        scenario={DEFAULT_SCENARIO}
        nodes={DEFAULT_ARCHITECTURE.nodes}
        selectedEventId={null}
        currentSecond={12}
        onSelectEvent={vi.fn()}
        onSeek={vi.fn()}
      />,
    );

    expect(screen.getByText("No spans in this sample")).toBeTruthy();
    expect(
      screen.getByText(/emitted without a sampled span sequence/),
    ).toBeTruthy();
  });
});
