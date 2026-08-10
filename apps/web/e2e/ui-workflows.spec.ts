import { expect, test, type Page } from "@playwright/test";

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
