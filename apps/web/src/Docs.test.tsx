import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Docs from "./Docs";

describe("Documentation reader", () => {
  beforeEach(() => window.history.replaceState({}, "", "/docs/"));

  it("FE-06 renders the current product requirements with development status", () => {
    render(<Docs />);
    const article = screen.getByRole("article");
    expect(within(article).getByRole("heading", { level: 1 }).textContent).toBe(
      "zx402: Product Requirements (PRD)",
    );
    expect(article.textContent).toContain(
      "A compliance list blocks flagged deposits from private use.",
    );
    expect(
      within(screen.getByRole("complementary")).getByText(/in development/i),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /back to zx402/i }).getAttribute("href"),
    ).toBe("/");
  });

  it("FE-06 changes between source documents through keyboard topic navigation", async () => {
    const user = userEvent.setup();
    render(<Docs />);
    const specification = screen.getByRole("button", { name: "Specification" });
    specification.focus();
    await user.keyboard("{Enter}");
    expect(specification.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "zx402: Technical Specification",
    );
    expect(screen.getByRole("article").textContent).toContain(
      "8.10 Public frontend",
    );
    await user.click(screen.getByRole("button", { name: "Build plan" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "zx402 M0 Mainnet Canary Implementation Plan",
    );
    expect(screen.getByRole("article").textContent).toContain(
      "Global Constraints",
    );
    await user.click(screen.getByRole("button", { name: "Overview" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "zx402: Product Requirements (PRD)",
    );
  });

  it("FE-06 resolves document links and section anchors to usable destinations", async () => {
    const user = userEvent.setup();
    render(<Docs />);
    const article = screen.getByRole("article");
    expect(
      within(article)
        .getByRole("link", { name: "SPEC.md" })
        .getAttribute("href"),
    ).toBe("/docs/?topic=spec");
    expect(
      within(article)
        .getByRole("link", { name: "HANDOFF.md" })
        .getAttribute("href"),
    ).toBe(
      "https://github.com/Marcussy34/zx402/blob/main/docs/HANDOFF.md",
    );
    expect(
      within(article).getByRole("heading", { name: "1. Summary" }).id,
    ).toBe("1-summary");
    await user.click(within(article).getByRole("link", { name: "SPEC.md" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "zx402: Technical Specification",
    );
    expect(window.location.search).toBe("?topic=spec");
  });

  it("FE-06 opens a directly linked document topic", () => {
    window.history.replaceState({}, "", "/docs/?topic=spec");
    render(<Docs />);
    expect(
      screen
        .getByRole("button", { name: "Specification" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "zx402: Technical Specification",
    );
  });

  it("FE-06 keeps the reader usable when a document link has a malformed fragment", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/docs/?topic=spec#%E0%A4%A");
    render(<Docs />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "zx402: Technical Specification",
    );
    await user.click(screen.getByRole("button", { name: "Overview" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "zx402: Product Requirements (PRD)",
    );
  });
});
