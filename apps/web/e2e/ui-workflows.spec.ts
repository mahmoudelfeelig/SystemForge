import { expect, test, type Page } from "@playwright/test";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
} from "@systemforge/sim-core";
import {
  applyTrafficProfile,
  parseTrafficProfile,
} from "../src/lib/trafficProfile";

const expectNoGlobalHorizontalOverflow = async (page: Page) => {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.clientWidth + 1,
  );
};

const expectContained = async (page: Page, selector: string) => {
  const dimensions = await page.locator(selector).evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.clientWidth + 1,
  );
};

const offscreenTopologyNodes = (page: Page) =>
  page.locator(".react-flow").evaluate((canvas) => {
    const bounds = canvas.getBoundingClientRect();
    return [...canvas.querySelectorAll<HTMLElement>(".react-flow__node")]
      .map((node) => ({
        id: node.dataset.id,
        box: node.getBoundingClientRect(),
      }))
      .filter(
        ({ box }) =>
          box.left < bounds.left - 1 ||
          box.top < bounds.top - 1 ||
          box.right > bounds.right + 1 ||
          box.bottom > bounds.bottom + 1,
      )
      .map(({ id, box }) => ({
        id,
        top: Math.round(box.top - bounds.top),
        left: Math.round(box.left - bounds.left),
        right: Math.round(box.right - bounds.right),
        bottom: Math.round(box.bottom - bounds.bottom),
      }));
  });

test("landing and Lab keep the primary workflow clear on desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      name: "Build and test distributed systems in your browser.",
    }),
  ).toBeVisible();
  await expectNoGlobalHorizontalOverflow(page);

  await page.getByRole("link", { name: /Run the checkout scenario/ }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await expect(page.getByRole("button", { name: "Build" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".component-palette")).toBeVisible();

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.locator(".component-palette")).toBeHidden();
  await expect(page.getByRole("button", { name: "Inspector" })).toBeVisible();

  await page.getByRole("button", { name: "Inspector" }).click();
  await expect(page.locator(".inspector")).toBeVisible();
  const desktopInspectorToggle = page
    .getByLabel("Runtime view tools")
    .getByRole("button", { name: "Close inspector" });
  await expect(desktopInspectorToggle).toBeVisible();
  await desktopInspectorToggle.click();
  await expect(page.locator(".inspector")).toBeHidden();

  await page.getByRole("button", { name: "Run locally" }).click();
  await expect(page.locator(".telemetry-panel")).toBeVisible();
  await expectNoGlobalHorizontalOverflow(page);
});

test("scenario editors reflow and interview setup leads to sharing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/custom");

  await page
    .getByRole("button", { name: "Expand Request mix section" })
    .click();
  await expect(page.locator("#requests")).toHaveAttribute(
    "data-collapsed",
    "false",
  );
  await expectContained(page, "#requests");
  await expectNoGlobalHorizontalOverflow(page);

  await page.getByRole("button", { name: "Expand Regions section" }).click();
  await expect(page.locator("#regions")).toHaveAttribute(
    "data-collapsed",
    "false",
  );
  await expectContained(page, "#regions");
  await expectNoGlobalHorizontalOverflow(page);

  await page.goto("/interview");
  await page.getByRole("button", { name: /Review and create links/ }).click();
  await expect(page).toHaveURL(/\/interview$/);
  await expect(page.locator("#share")).toHaveAttribute(
    "data-collapsed",
    "false",
  );
  await expect(
    page.getByRole("textbox", { name: "Candidate link", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Interviewer link", exact: true }),
  ).toBeVisible();
  await expectNoGlobalHorizontalOverflow(page);
});

test("mobile decisions and replay use progressive disclosure", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/decisions");

  const compare = page.getByRole("button", { name: "Compare candidates" });
  await expect(compare).toBeVisible();
  await expect(compare).toBeInViewport();
  await expect(page.locator(".solver-advanced")).not.toHaveAttribute(
    "open",
    "",
  );
  const decisionTool = page.locator(".decision-tool-select select");
  await expect(decisionTool).toBeVisible();
  await decisionTool.selectOption("runs");
  await expect(page.getByText("Run library", { exact: true })).toBeVisible();
  await expectNoGlobalHorizontalOverflow(page);

  await page.goto("/replay");
  await expect(page.locator(".replay-checks-idle")).toBeVisible();
  await expect(
    page.getByText("Checks start after file selection"),
  ).toBeVisible();
  await expect(page.locator(".replay-checks dl")).toHaveCount(0);
  await expectNoGlobalHorizontalOverflow(page);
});

test("mobile Lab modes preserve access to diagnostics without permanent clutter", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/lab");

  await page.getByRole("button", { name: "Investigate" }).click();
  await page.getByRole("button", { name: "Inspector" }).click();
  await expect(page.locator(".inspector")).toBeVisible();
  await expect(page.locator(".runtime-inspector-close")).toBeInViewport();
  await page.locator(".runtime-inspector-close").click();
  await expect(page.locator(".inspector")).toBeHidden();
  await expectNoGlobalHorizontalOverflow(page);
});

test("field guide traces disclosed systems and real incident evidence", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/decisions");
  await page.getByRole("tab", { name: "Field guide" }).click();

  await expect(
    page.getByRole("heading", { name: "Production field guide" }),
  ).toBeVisible();
  await expect(page.getByText(/21 disclosed system designs/)).toBeVisible();
  await expect(
    page.getByRole("article", {
      name: "Dynamo shopping-cart state reference",
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: /Incidents/ }).click();
  await page.getByRole("searchbox", { name: /Search evidence/ }).fill("regex");
  const incident = page.getByRole("article", {
    name: "WAF regex CPU exhaustion incident",
  });
  await expect(incident).toBeVisible();
  await expect(
    incident.getByText("SystemForge prevention synthesis"),
  ).toBeVisible();
  await expect(
    incident.getByRole("link", { name: /July 2 outage details/ }),
  ).toHaveAttribute(
    "href",
    "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/",
  );
  await expectNoGlobalHorizontalOverflow(page);

  await page.screenshot({
    path: "test-results/e2e/field-guide-incidents-desktop.png",
  });
});

test("calibration replays demand, validates a telemetry fit, and retains evidence", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const trafficCsv = `second,rps\n${Array.from({ length: 21 }, (_, second) => `${second},${25_000 + second * 1_500}`).join("\n")}`;
  const scenario = applyTrafficProfile(
    structuredClone(DEFAULT_SCENARIO),
    parseTrafficProfile(trafficCsv),
  );
  const observedArchitecture = structuredClone(DEFAULT_ARCHITECTURE);
  const observedApi = observedArchitecture.nodes.find(
    (node) => node.id === "api",
  )!;
  observedApi.config.capacityRps = 6_000;
  observedApi.config.baseLatencyMs = 34;
  const observedResult = simulate(scenario, observedArchitecture, {
    includeTraces: false,
  });
  const telemetryCsv = `second,latencyMs,cpuUtilization\n${observedResult.frames
    .slice(0, 20)
    .map(
      (frame) =>
        `${frame.second},${frame.nodeMetrics.api!.latencyMs},${frame.nodeMetrics.api!.cpuUtilization}`,
    )
    .join("\n")}`;

  await page.goto("/decisions");
  await expect(page.getByText("Baseline dossier")).toBeVisible();
  await expect(page.getByText("Graph execution gate")).toBeVisible();
  await page.screenshot({
    path: "test-results/e2e/comparison-baseline-desktop.png",
  });
  await page.getByRole("tab", { name: "Calibrate" }).click();
  await expect(page.getByText("Authored workload curve only")).toBeVisible();
  await page
    .getByRole("textbox", { name: "Traffic profile data" })
    .fill(trafficCsv);
  await page
    .getByRole("button", { name: /Retain and replay observations/ })
    .click();
  await expect(page.getByText("Observed demand replay active")).toBeVisible();

  await page.getByLabel("Evidence source").fill("production-prometheus");
  await page.getByLabel("Evidence reference").fill("api-canary-2026-09-07");
  await page.getByLabel("Observed at").fill("2026-09-07T12:00:00Z");
  await page
    .getByRole("textbox", { name: "Node telemetry data" })
    .fill(telemetryCsv);
  await page.getByRole("button", { name: "Fit and validate node" }).click();

  const report = page.getByRole("region", {
    name: "Telemetry calibration report",
  });
  await expect(report.getByText("Calibration accepted")).toBeVisible();
  await expect(report.getByText(/4 holdout/)).toBeVisible();
  await report.scrollIntoViewIfNeeded();
  await expectNoGlobalHorizontalOverflow(page);
  await page.screenshot({
    path: "test-results/e2e/calibration-desktop.png",
  });

  await page.goto("/lab");
  await page.locator('.react-flow__node[data-id="api"]').click();
  await expect(page.getByText("production-prometheus")).toBeVisible();
  await expect(page.getByText("api-canary-2026-09-07")).toBeVisible();
});

test("investigation view keeps topology readable and exposes an explicit focus control", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/lab");
  await page.getByRole("button", { name: "Run locally" }).click();
  await expect(
    page.locator(".telemetry-panel:not(.telemetry-panel--empty)"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Investigate" }).click();
  await expect.poll(() => offscreenTopologyNodes(page)).toEqual([]);

  const focus = page.getByRole("button", { name: "Expand topology" });
  await expect(focus).toBeVisible();
  await focus.click();
  await expect(page.locator(".lab-shell")).toHaveClass(
    /lab-shell--topology-focus/,
  );
  await expect(
    page.getByRole("button", { name: "Restore split" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => offscreenTopologyNodes(page)).toEqual([]);
  await expectNoGlobalHorizontalOverflow(page);
  await page.screenshot({
    path: "test-results/e2e/investigation-topology-focus-desktop.png",
  });
});
