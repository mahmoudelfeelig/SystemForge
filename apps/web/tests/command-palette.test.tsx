// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO } from "@systemforge/sim-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../src/components/CommandPalette";
import { useLabStore } from "../src/store/useLabStore";

afterEach(() => {
  cleanup();
  localStorage.clear();
  useLabStore.setState({
    scenario: structuredClone(DEFAULT_SCENARIO),
    architecture: structuredClone(DEFAULT_ARCHITECTURE),
    runState: "idle",
    architectureUndo: [],
  });
});

describe("command palette keyboard behavior", () => {
  it("moves through commands with arrow keys and activates with Enter", () => {
    const onClose = vi.fn();
    const onOpenDecisionWorkbench = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        onOpenDecisionWorkbench={onOpenDecisionWorkbench}
      />,
    );

    const input = screen.getByRole("combobox", {
      name: /systemforge commands/i,
    });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpenDecisionWorkbench).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps listbox options out of the Tab order while the combobox owns focus", () => {
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        onOpenDecisionWorkbench={vi.fn()}
      />,
    );

    const input = screen.getByRole("combobox", {
      name: /systemforge commands/i,
    });
    expect(document.activeElement).toBe(input);
    for (const option of screen.getAllByRole("option")) {
      expect(option.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("filters commands and closes with Escape", () => {
    const onClose = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        onOpenDecisionWorkbench={vi.fn()}
      />,
    );

    fireEvent.change(
      screen.getByRole("combobox", { name: /systemforge commands/i }),
      { target: { value: "no such command" } },
    );
    expect(screen.getByText(/No command matches/)).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
