// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReferenceLibrary } from "../src/components/ReferenceLibrary";
import { INCIDENT_CATALOG } from "../src/lib/incidentCatalog";
import { SYSTEM_DESIGN_CATALOG } from "../src/lib/systemDesignCatalog";

afterEach(cleanup);

describe("production evidence library", () => {
  it("ships bounded, unique, primary-source catalogs", () => {
    expect(SYSTEM_DESIGN_CATALOG.length).toBeGreaterThanOrEqual(20);
    expect(SYSTEM_DESIGN_CATALOG.length).toBeLessThanOrEqual(25);
    expect(INCIDENT_CATALOG.length).toBeGreaterThanOrEqual(50);
    expect(INCIDENT_CATALOG.length).toBeLessThanOrEqual(100);

    const ids = [
      ...SYSTEM_DESIGN_CATALOG.map((item) => item.id),
      ...INCIDENT_CATALOG.map((item) => item.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const reference of [...SYSTEM_DESIGN_CATALOG, ...INCIDENT_CATALOG]) {
      expect(reference.sources.length).toBeGreaterThan(0);
      for (const item of reference.sources) {
        expect(new URL(item.url).protocol).toBe("https:");
        expect(item.publisher.trim()).not.toBe("");
      }
    }
  });

  it("shows system topology with explicit evidence boundaries", () => {
    render(<ReferenceLibrary />);

    expect(screen.getByText(/21 disclosed system designs/)).toBeTruthy();
    const systemDetails = screen.getByRole("article", {
      name: "Dynamo shopping-cart state reference",
    });
    expect(
      within(systemDetails).getByText("Dynamo shopping-cart state"),
    ).toBeTruthy();
    expect(
      within(systemDetails).getByText(
        /not an invented complete production diagram/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Dynamo paper/ }).getAttribute("href"),
    ).toBe(
      "https://www.amazon.science/publications/dynamo-amazons-highly-available-key-value-store",
    );
  });

  it("filters incidents and separates facts from prevention synthesis", () => {
    render(<ReferenceLibrary />);
    fireEvent.click(screen.getByRole("button", { name: /Incidents/ }));
    const search = screen.getByRole("searchbox", { name: /Search evidence/ });
    fireEvent.change(search, { target: { value: "regex" } });

    expect(
      screen.getByRole("navigation", { name: "Incident postmortems" }),
    ).toBeTruthy();
    const incidentDetails = screen.getByRole("article", {
      name: "WAF regex CPU exhaustion incident",
    });
    expect(
      within(incidentDetails).getByText("WAF regex CPU exhaustion"),
    ).toBeTruthy();
    expect(
      within(incidentDetails).getByText(/Source-backed incident chain/),
    ).toBeTruthy();
    expect(
      within(incidentDetails).getByText("SystemForge prevention synthesis"),
    ).toBeTruthy();
    expect(
      within(incidentDetails).getByText(
        /engineering deductions from the cited incident/,
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /July 2 outage details/ })
        .getAttribute("href"),
    ).toBe(
      "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/",
    );
  });
});
