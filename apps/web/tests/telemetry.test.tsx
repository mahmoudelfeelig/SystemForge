// @vitest-environment jsdom

import {
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryPanel } from "../src/components/TelemetryPanel";

afterEach(cleanup);

describe("operational telemetry workspace", () => {
  it("switches real resource histories and exposes a fallback causal path", () => {
    const result = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE);
    const onSelectEvent = vi.fn();
    const onSeek = vi.fn();

    render(
      <TelemetryPanel
        result={result}
        nodes={DEFAULT_ARCHITECTURE.nodes}
        selectedEventId={null}
        currentSecond={result.frames.length - 1}
        onSelectEvent={onSelectEvent}
        onSeek={onSeek}
      />,
    );

    const cpu = screen.getByRole("button", { name: "CPU" });
    const memory = screen.getByRole("button", { name: "Memory" });
    expect(cpu.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(memory);
    expect(memory.getAttribute("aria-pressed")).toBe("true");

    const causalRail = screen.getByLabelText("Causal path analysis");
    expect(within(causalRail).getByText("Root signal")).toBeTruthy();

    const firstCausalEvent = within(causalRail).getAllByRole("button")[0]!;
    fireEvent.click(firstCausalEvent);
    expect(onSelectEvent).toHaveBeenCalledOnce();
    expect(onSeek).toHaveBeenCalledOnce();
  });
});
