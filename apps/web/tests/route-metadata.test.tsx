// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { RouteMetadata } from "../src/components/RouteMetadata";

afterEach(() => {
  cleanup();
  document.head.innerHTML = "";
});

const renderPath = (path: string) => {
  document.head.innerHTML = [
    '<meta name="description" content="">',
    '<meta property="og:title" content="">',
    '<meta property="og:description" content="">',
    '<meta property="og:url" content="">',
    '<meta name="twitter:title" content="">',
    '<meta name="twitter:description" content="">',
    '<link rel="canonical" href="/">',
  ].join("");
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RouteMetadata />
    </MemoryRouter>,
  );
};

describe("route metadata", () => {
  it("keeps known workspaces indexable", async () => {
    renderPath("/lab");
    await waitFor(() =>
      expect(
        document.head
          .querySelector('meta[name="robots"]')
          ?.getAttribute("content"),
      ).toBe("index,follow"),
    );
    expect(document.title).toContain("SystemForge Lab");
  });

  it("describes the completed-run replay workspace", async () => {
    renderPath("/replay");
    await waitFor(() => expect(document.title).toContain("Replay a Run"));
    expect(
      document.head
        .querySelector('meta[name="description"]')
        ?.getAttribute("content"),
    ).toContain("replay bundle");
    expect(
      document.head
        .querySelector('meta[name="robots"]')
        ?.getAttribute("content"),
    ).toBe("index,follow");
  });

  it("marks exact shared links noindex", async () => {
    renderPath("/scenario/abc-123");
    await waitFor(() =>
      expect(
        document.head
          .querySelector('meta[name="robots"]')
          ?.getAttribute("content"),
      ).toBe("noindex,follow"),
    );
    expect(document.title).toBe("Shared Scenario — SystemForge");
  });

  it("does not mislabel nested unknown paths as shared scenarios", async () => {
    renderPath("/scenario/abc-123/extra");
    await waitFor(() => expect(document.title).toContain("Page not found"));
    expect(document.title).not.toContain("Shared");
  });
});
