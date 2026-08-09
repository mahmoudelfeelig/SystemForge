// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { LandingPage } from "../src/pages/LandingPage";

afterEach(cleanup);

describe("landing copy", () => {
  it("keeps implementation details out of the customer-facing shell", () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/Local engine ready/i)).toBeNull();
    expect(screen.queryByText(/ENGINE 0\.7\.0/i)).toBeNull();
    expect(screen.queryByText(/LOCAL-FIRST/i)).toBeNull();
    expect(screen.queryByText(/INPUTS \+ SEED/i)).toBeNull();
    expect(screen.getByLabelText("Email Mahmoud Elfeel")).toBeTruthy();
    expect(screen.getByLabelText("Mahmoud Elfeel on LinkedIn")).toBeTruthy();
    expect(screen.getByLabelText("SystemForge on GitHub")).toBeTruthy();
  });
});
