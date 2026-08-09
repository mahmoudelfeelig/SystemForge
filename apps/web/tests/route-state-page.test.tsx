// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import {
  NotFoundPage,
  RouteErrorBoundary,
} from "../src/components/RouteStatePage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("route state console", () => {
  it("offers every workspace from the not-found state", () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "No workspace at this address" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Open Lab/i }).length).toBe(2);
    expect(screen.getByRole("link", { name: /Scenario editor/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Interview setup/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Replay console/i })).toBeTruthy();
  });

  it("recovers from a route render failure without clearing the local draft", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let shouldThrow = true;
    const BrokenRoute = () => {
      if (shouldThrow) throw new Error("route failed");
      return <p>Recovered workspace</p>;
    };

    render(
      <MemoryRouter>
        <RouteErrorBoundary>
          <BrokenRoute />
        </RouteErrorBoundary>
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "This workspace could not open" }),
    ).toBeTruthy();
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(screen.getByText("Recovered workspace")).toBeTruthy();
  });
});
