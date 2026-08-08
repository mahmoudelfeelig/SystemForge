// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ScenarioDesignerPage } from "../src/pages/ScenarioDesignerPage";

afterEach(cleanup);

describe("scenario workload controls", () => {
  it("lets the interviewer disable retries on client timeout", () => {
    render(
      <MemoryRouter>
        <ScenarioDesignerPage mode="interview" />
      </MemoryRouter>,
    );

    const retryOnTimeout = screen.getByLabelText("Retry on client timeout");
    expect((retryOnTimeout as HTMLInputElement).checked).toBe(true);

    fireEvent.click(retryOnTimeout);

    expect((retryOnTimeout as HTMLInputElement).checked).toBe(false);
  });
});
