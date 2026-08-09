// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDecisionWorkbenchBoundary,
  type DecisionWorkbenchBoundaryProps,
} from "../src/components/DecisionWorkbenchBoundary";

afterEach(cleanup);

describe("DecisionWorkbenchBoundary", () => {
  it("does not request the workbench until first open and preserves it afterward", async () => {
    const load = vi.fn(() => {
      const StubWorkbench = ({
        open,
        onClose,
      }: DecisionWorkbenchBoundaryProps) => {
        const [marker] = useState(() => crypto.randomUUID());
        return (
          <div
            data-testid="loaded-workbench"
            data-marker={marker}
            hidden={!open}
          >
            <button type="button" onClick={onClose}>
              Close workbench
            </button>
          </div>
        );
      };
      return Promise.resolve({ DecisionWorkbench: StubWorkbench });
    });
    const Boundary = createDecisionWorkbenchBoundary(load);
    const onClose = vi.fn();
    const view = render(<Boundary open={false} onClose={onClose} />);

    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByTestId("loaded-workbench")).toBeNull();

    view.rerender(<Boundary open onClose={onClose} />);
    expect(screen.getByRole("status").textContent).toContain(
      "Loading decision tools",
    );
    const loaded = await screen.findByTestId("loaded-workbench");
    expect(load).toHaveBeenCalledOnce();
    const marker = loaded.dataset.marker;

    fireEvent.click(screen.getByRole("button", { name: "Close workbench" }));
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(<Boundary open={false} onClose={onClose} />);

    await waitFor(() =>
      expect(
        screen.getByTestId<HTMLDivElement>("loaded-workbench").hidden,
      ).toBe(true),
    );
    expect(screen.getByTestId("loaded-workbench").dataset.marker).toBe(marker);

    view.rerender(<Boundary open onClose={onClose} />);
    expect(
      (await screen.findByTestId<HTMLDivElement>("loaded-workbench")).hidden,
    ).toBe(false);
    expect(screen.getByTestId("loaded-workbench").dataset.marker).toBe(marker);
    expect(load).toHaveBeenCalledOnce();
  });

  it("recovers from a rejected lazy import when the operator retries", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const StubWorkbench = () => <div data-testid="recovered-workbench" />;
    const load = vi
      .fn<() => Promise<{ DecisionWorkbench: typeof StubWorkbench }>>()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockResolvedValueOnce({ DecisionWorkbench: StubWorkbench });
    const Boundary = createDecisionWorkbenchBoundary(load);

    try {
      render(<Boundary open onClose={vi.fn()} />);

      expect((await screen.findByRole("alertdialog")).textContent).toContain(
        "Decision tools unavailable",
      );
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(document.activeElement).toBe(retry);

      fireEvent.click(retry);

      expect(await screen.findByTestId("recovered-workbench")).toBeTruthy();
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("closes a failed lazy import and restores focus to its opener", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const load = vi.fn(() => Promise.reject(new Error("chunk unavailable")));
    const Boundary = createDecisionWorkbenchBoundary(load);

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open comparison
          </button>
          <Boundary open={open} onClose={() => setOpen(false)} />
        </>
      );
    }

    try {
      render(<Harness />);
      const opener = screen.getByRole("button", { name: "Open comparison" });
      opener.focus();
      fireEvent.click(opener);
      await screen.findByRole("alertdialog");

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      await waitFor(() => expect(document.activeElement).toBe(opener));
      expect(screen.queryByRole("alertdialog")).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
