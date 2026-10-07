import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App, { SETUP_COMMAND } from "./App";

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
    ).toBe("https://docs.zx402.org/guide/privacy/");
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
    ).toBe("https://docs.zx402.org/");
    expect(
      resources.getByRole("link", { name: "Build plan" }).getAttribute("href"),
    ).toBe("https://docs.zx402.org/reference/plan-m0/");
    expect(
      resources.getByRole("link", { name: "GitHub" }).getAttribute("href"),
    ).toBe("https://github.com/Marcussy34/zx402");
    expect(footer.getByText(/in development/i)).toBeTruthy();
    expect(
      footer.getAllByRole("link", { name: "Read docs" })[0].getAttribute("href"),
    ).toBe("https://docs.zx402.org/");
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
    links.forEach((link) => expect(link.getAttribute("href")).toBe("https://docs.zx402.org/"));
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

  describe("FE-19 agent setup guide", () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    afterEach(() => {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    });

    it("FE-19 shows a documentation fetch command and links to the same setup guide", () => {
      render(<App />);
      const setup = within(
        screen.getByRole("region", { name: "Build with zx402." }),
      );
      expect(SETUP_COMMAND).toBe(
        "curl -fsSL https://raw.githubusercontent.com/Marcussy34/zx402/main/setup.md",
      );
      expect(setup.getByText(SETUP_COMMAND).textContent).toBe(SETUP_COMMAND);
      expect(
        setup.getByRole("link", { name: "View setup guide" }).getAttribute("href"),
      ).toBe("https://github.com/Marcussy34/zx402/blob/main/setup.md");
      expect(setup.getByText("Preprod developer preview")).toBeTruthy();
      expect(setup.queryByRole("button", { name: /prompt/i })).toBeNull();
    });

    it("FE-19 copies the guide command and announces success", async () => {
      const user = userEvent.setup();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText }, configurable: true,
      });
      render(<App />);
      const setup = within(screen.getByRole("region", { name: "Build with zx402." }));
      await user.click(setup.getByRole("button", { name: "Copy command" }));
      expect(writeText).toHaveBeenCalledWith(SETUP_COMMAND);
      expect(setup.getByRole("status").textContent).toBe("Copied.");
    });

    it.each(["unavailable", "denied"])("FE-19 keeps the command selectable when clipboard is %s", async (mode) => {
      const user = userEvent.setup();
      Object.defineProperty(navigator, "clipboard", {
        value: mode === "unavailable" ? undefined : {
          writeText: vi.fn().mockRejectedValue(new Error("denied")),
        },
        configurable: true,
      });
      render(<App />);
      const setup = within(screen.getByRole("region", { name: "Build with zx402." }));
      await user.click(setup.getByRole("button", { name: "Copy command" }));
      expect(setup.getByRole("status").textContent).toBe("Select the command and copy it.");
      expect(setup.getByText(SETUP_COMMAND)).toBeTruthy();
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
