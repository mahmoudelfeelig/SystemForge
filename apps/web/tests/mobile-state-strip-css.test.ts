/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);

describe("mobile operational state typography", () => {
  it("keeps the strip and every operational value at least 12px", () => {
    const stripRule = styles.match(
      /\.mobile-state-strip\s*{(?=[^}]*position:\s*sticky)[^}]*}/s,
    )?.[0];

    expect(stripRule).toContain("font-size: 12px;");
    expect(stripRule).toContain(
      "grid-template-columns: repeat(5, minmax(0, auto));",
    );
    expect(stripRule).toContain("overflow-x: auto;");
    expect(stripRule).toContain("white-space: nowrap;");
    expect(styles).toMatch(
      /\.mobile-state-strip\s*>\s*\*\s*{[^}]*font-size:\s*12px\s*!important;[^}]*}/s,
    );
  });

  it("keeps React Flow controls at least 40px wide on mobile", () => {
    expect(styles).toMatch(
      /\.architecture-workspace\s+\.react-flow__controls-button\s*{[^}]*min-width:\s*40px;[^}]*}/s,
    );
  });

  it("keeps graph-node operational labels at least 12px on mobile", () => {
    expect(styles).toMatch(
      /\.lab-shell\s+\.system-node header small,\s*\.lab-shell\s+\.system-node__readout small,\s*\.lab-shell\s+\.system-node footer,\s*\.lab-shell\s+\.system-node footer small\s*{[^}]*font-size:\s*12px;[^}]*}/s,
    );
  });
});
