import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App, { SETUP_PROMPT } from "./App";

describe("Landing page", () => {
  it("FE-15 distinguishes local secrets from information shared with the network", () => {
    render(<App />);
    const local = within(
      screen.getByRole("group", { name: "Kept on your device" }),
    );
    expect(local.getByText("Note secrets")).toBeTruthy();
    expect(local.getByText("Private balance")).toBeTruthy();
    const network = within(
      screen.getByRole("group", { name: "Shared with the network" }),
    );
    expect(network.getByText("Proof + intent")).toBeTruthy();
    expect(network.getByText("Shared pool")).toBeTruthy();
    expect(network.getByText("Public payment details")).toBeTruthy();
    expect(network.queryByText("Note secrets")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Privacy model" }).getAttribute("href"),
    ).toBe("https://marcussy34.github.io/zx402/guide/privacy/");
  });
  it("FE-13 groups footer destinations and retains the project status", () => {
    render(<App />);
    const footer = within(screen.getByRole("contentinfo"));
    const explore = within(
      footer.getByRole("navigation", { name: "Footer explore" }),
    );
    expect(
      explore.getByRole("link", { name: "How it works" }).getAttribute("href"),
    ).toBe("#how-it-works");
    expect(
      explore
        .getByRole("link", { name: "The payment path" })
        .getAttribute("href"),
    ).toBe("#payment-path");
    const resources = within(
      footer.getByRole("navigation", { name: "Footer resources" }),
    );
    expect(
      resources.getByRole("link", { name: "Read docs" }).getAttribute("href"),
    ).toBe("https://marcussy34.github.io/zx402/");
    expect(
      resources.getByRole("link", { name: "Build plan" }).getAttribute("href"),
    ).toBe("https://marcussy34.github.io/zx402/reference/plan-m0/");
    expect(
      resources.getByRole("link", { name: "GitHub" }).getAttribute("href"),
    ).toBe("https://github.com/Marcussy34/zx402");
    expect(footer.getByText(/in development/i)).toBeTruthy();
    expect(
      footer.getAllByRole("link", { name: "Read docs" })[0].getAttribute("href"),
    ).toBe("https://marcussy34.github.io/zx402/");
  });
  it("FE-01 states the release status and the limits of payment privacy", () => {
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "Private payments.",
    );
    expect(screen.getAllByText(/in development/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ADA first/i).length).toBeGreaterThan(0);
    const roadmap = within(
      screen.getByRole("region", { name: "Mainnet is next." }),
    );
    expect(roadmap.getByText("Tested on Preprod")).toBeTruthy();
    const local = within(screen.getByRole("group", { name: "Kept on your device" }));
    expect(local.getByText("Note secrets")).toBeTruthy();
    expect(local.getByText("Proof generated locally")).toBeTruthy();
    const network = within(screen.getByRole("group", { name: "Shared with the network" }));
    expect(network.getByText("Proof + intent")).toBeTruthy();
    expect(network.queryByText("Note secrets")).toBeNull();
    const disclosures = screen.getAllByText(
      /amounts, recipients, and timing remain public/i,
    );
    expect(
      disclosures.filter((element) => !element.closest("[hidden]")).length,
    ).toBe(1);
  });

  it("FE-02 makes every Read docs CTA open the documentation site", () => {
    render(<App />);
    const links = screen.getAllByRole("link", { name: /read docs/i });
    expect(links.length).toBeGreaterThanOrEqual(2);
    links.forEach((link) => expect(link.getAttribute("href")).toBe("https://marcussy34.github.io/zx402/"));
  });

  it("FE-03 opens navigation, closes with Escape, and restores focus", async () => {
    const user = userEvent.setup();
    render(<App />);
    const button = screen.getByRole("button", { name: "Open menu" });
    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("navigation", { name: "Menu" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("navigation", { name: "Menu" })).toBeNull();
    expect(document.activeElement).toBe(button);
    await user.click(button);
    await user.click(
      within(screen.getByRole("navigation", { name: "Menu" })).getByRole(
        "link",
        { name: "How it works" },
      ),
    );
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("FE-04 presents one connected payment overview without selecting a step", () => {
    render(<App />);
    const overview = within(screen.getByRole("region", { name: "Payment overview" }));
    expect(screen.getByRole("heading", { name: "One payment. The whole picture." })).toBeTruthy();
    expect(overview.getAllByRole("img")).toHaveLength(1);
    const diagram = within(overview.getByRole("img"));
    ["Your wallet", "Shared pool", "One-time key", "x402 seller", "Your agent", "Relayer"].forEach((name) => {
      expect(diagram.getAllByText(name, { exact: true })).toHaveLength(1);
    });
    expect(overview.queryByRole("list")).toBeNull();
    expect(overview.queryByRole("button")).toBeNull();
  });

  it("FE-05 opens and closes a FAQ answer from the keyboard", async () => {
    const user = userEvent.setup();
    render(<App />);
    const question = screen.getByRole("button", {
      name: "Is zx402 live?",
    });
    question.focus();
    await user.keyboard("{Enter}");
    expect(question.getAttribute("aria-expanded")).toBe("true");
    const answer = document.getElementById(
      question.getAttribute("aria-controls")!,
    );
    expect(answer?.textContent).toContain("team funds");
    expect(answer?.textContent).toContain("Preprod test network");
    expect(answer?.textContent).toContain("Mainnet is not live");
    await user.keyboard(" ");
    expect(question.getAttribute("aria-expanded")).toBe("false");
    expect(answer?.hidden).toBe(true);
  });

  describe("FE-19 setup prompt", () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    afterEach(() => {
      vi.useRealTimers();
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    });

    it("FE-19 shows the one-line agent prompt with the repository, the commands, and the no-deploy rule", () => {
      render(<App />);
      const setup = within(
        screen.getByRole("region", { name: "Hand it to your agent." }),
      );
      const prompt = setup.getByText(/Clone https:\/\/github.com\/Marcussy34\/zx402/);
      expect(prompt.textContent).toBe(SETUP_PROMPT);
      expect(SETUP_PROMPT).not.toContain("\n");
      [
        "https://github.com/Marcussy34/zx402",
        "docs/HANDOFF.md",
        "npm ci",
        "npm run build:circuits",
        "npm run setup:dev",
        "npm test",
        "Do not deploy",
      ].forEach((part) => expect(SETUP_PROMPT).toContain(part));
      expect(
        setup.getByRole("link", { name: "Running it" }).getAttribute("href"),
      ).toBe("https://marcussy34.github.io/zx402/guide/running/");
    });

    it("FE-19 copies the exact prompt, announces it, and clears the notice", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });
      render(<App />);
      const setup = within(
        screen.getByRole("region", { name: "Hand it to your agent." }),
      );
      await user.click(setup.getByRole("button", { name: "Copy prompt" }));
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith(SETUP_PROMPT);
      const status = setup.getByRole("status");
      await vi.waitFor(() => expect(status.textContent).toBe("Copied."));
      await act(() => vi.advanceTimersByTimeAsync(2500));
      expect(status.textContent).toBe("");
    });

    it("FE-19 keeps the prompt selectable when the clipboard is unavailable", async () => {
      const user = userEvent.setup();
      Object.defineProperty(navigator, "clipboard", {
        value: undefined,
        configurable: true,
      });
      render(<App />);
      const setup = within(
        screen.getByRole("region", { name: "Hand it to your agent." }),
      );
      await user.click(setup.getByRole("button", { name: "Copy prompt" }));
      expect(setup.getByRole("status").textContent).toBe(
        "Select the text and copy it.",
      );
      expect(
        setup.getByText(/Clone https:\/\/github.com\/Marcussy34\/zx402/),
      ).toBeTruthy();
    });

    it("FE-19 links the menu to the setup section", async () => {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByRole("button", { name: "Open menu" }));
      expect(
        within(screen.getByRole("navigation", { name: "Menu" }))
          .getByRole("link", { name: "Set up" })
          .getAttribute("href"),
      ).toBe("#agent-setup");
    });
  });
});
