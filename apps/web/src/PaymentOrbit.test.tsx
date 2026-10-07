import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PaymentOrbit from "./PaymentOrbit";

let scroll = 0;
let reduced = false;
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
let listeners: Set<() => void>;
let sceneHeight = 600;
let sectionHeight = 1200;
const names = [
  "Wallet",
  "Shared pool",
  "Local proof",
  "Relayer",
  "One-time key",
  "x402 seller",
];

function flush() {
  act(() => {
    const queued = [...frames.values()];
    frames.clear();
    queued.forEach((callback) => callback(0));
  });
}
function advance(position: number) {
  scroll = position;
  fireEvent.scroll(window);
  flush();
}
function selected(name: string) {
  expect(
    screen.getByRole("button", { name }).getAttribute("aria-pressed"),
  ).toBe("true");
}

beforeEach(() => {
  scroll = 0;
  reduced = false;
  sceneHeight = 600;
  sectionHeight = 1200;
  frames = new Map();
  listeners = new Set();
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("IntersectionObserver", class {});
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      get matches() {
        return query.includes("prefers-reduced") ? reduced : true;
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    })),
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const height = this.classList.contains("payment-path-sticky")
        ? sceneHeight
        : sectionHeight;
      return {
        top: 80 - scroll,
        bottom: 80 + height - scroll,
        height,
        width: 1200,
        x: 0,
        y: 80 - scroll,
        left: 0,
        right: 1200,
        toJSON() {},
      };
    },
  );
});

it("FE-12 pins a fitting laptop scene and finishes at the actual sticky release point", () => {
  vi.stubGlobal("innerHeight", 720);
  sceneHeight = 590;
  sectionHeight = 1790;
  render(<PaymentOrbit />);
  flush();
  const scene = screen.getByRole("region", {
    name: "From wallet to work.",
  });
  expect(scene.dataset.orbitPinned).toBe("true");
  selected("Wallet");
  advance(540);
  selected("Relayer");
  expect(scene.style.getPropertyValue("--path-progress")).toBe("0.45");
  advance(1100);
  selected("x402 seller");
  expect(Number(scene.style.getPropertyValue("--path-progress"))).toBeLessThan(
    1,
  );
  advance(1200);
  expect(scene.style.getPropertyValue("--path-progress")).toBe("1");
  advance(408);
  selected("Local proof");
});

it("FE-12 releases pinning when the full scene no longer fits the resized viewport", () => {
  render(<PaymentOrbit />);
  flush();
  const scene = screen.getByRole("region", {
    name: "From wallet to work.",
  });
  expect(scene.dataset.orbitPinned).toBe("true");
  vi.stubGlobal("innerHeight", 620);
  fireEvent.resize(window);
  flush();
  expect(scene.dataset.orbitPinned).toBe("false");
  expect(scene.dataset.orbitMode).toBe("static");
  advance(384);
  selected("Wallet");
  names.forEach((name) =>
    expect(screen.getByRole("button", { name }).dataset.revealed).toBe("true"),
  );
});

it("FE-12 remeasures late content size changes and disconnects its scene observer", () => {
  let resizeScene = () => {};
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizeScene = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const view = render(<PaymentOrbit />);
  flush();
  const scene = screen.getByRole("region", {
    name: "From wallet to work.",
  });
  expect(observe).toHaveBeenCalledWith(
    scene.querySelector(".payment-path-sticky"),
  );
  expect(scene.dataset.orbitPinned).toBe("true");
  sceneHeight = 850;
  resizeScene();
  flush();
  expect(scene.dataset.orbitPinned).toBe("false");
  resizeScene();
  view.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("FE-12 exposes six keyboard controls and keeps manual selection until a scroll stage changes", async () => {
  const user = userEvent.setup();
  render(<PaymentOrbit />);
  flush();
  names.forEach((name) =>
    expect(screen.getByRole("button", { name })).toBeTruthy(),
  );
  selected("Wallet");
  screen.getByRole("button", { name: "Local proof" }).focus();
  await user.keyboard("{Enter}");
  selected("Local proof");
  expect(screen.getByText(/note secrets stay on your machine/)).toBeTruthy();
  fireEvent.resize(window);
  fireEvent.scroll(window);
  flush();
  selected("Local proof");
  advance(384);
  selected("x402 seller");
  expect(screen.getByText(/standard x402 payment/)).toBeTruthy();
  advance(204);
  selected("Local proof");
});

it("FE-12 freezes automatic changes while paused and resumes at the current position", async () => {
  const user = userEvent.setup();
  const view = render(<PaymentOrbit />);
  flush();
  advance(204);
  selected("Local proof");
  view.rerender(<PaymentOrbit paused />);
  names.forEach((name) =>
    expect(screen.getByRole("button", { name }).dataset.revealed).toBe("true"),
  );
  advance(384);
  selected("Local proof");
  await user.click(screen.getByRole("button", { name: "Relayer" }));
  selected("Relayer");
  view.rerender(<PaymentOrbit />);
  flush();
  selected("x402 seller");
});

it("FE-12 releases a paused scene when resized too short and resumes from the current scroll position", async () => {
  const user = userEvent.setup();
  const view = render(<PaymentOrbit />);
  flush();
  const scene = screen.getByRole("region", { name: "From wallet to work." });
  advance(204);
  selected("Local proof");
  expect(scene.dataset.orbitPinned).toBe("true");
  view.rerender(<PaymentOrbit paused />);
  vi.stubGlobal("innerHeight", 620);
  fireEvent.resize(window);
  flush();
  expect(scene.dataset.orbitPinned).toBe("false");
  expect(scene.dataset.orbitMode).toBe("paused");
  names.forEach((name) =>
    expect(screen.getByRole("button", { name }).dataset.revealed).toBe("true"),
  );
  advance(384);
  selected("Local proof");
  expect(scene.style.getPropertyValue("--path-progress")).toBe("0.34");
  await user.click(screen.getByRole("button", { name: "Relayer" }));
  selected("Relayer");
  expect(screen.getByText(/gets proof and intent/)).toBeTruthy();
  vi.stubGlobal("innerHeight", 900);
  fireEvent.resize(window);
  flush();
  expect(scene.dataset.orbitPinned).toBe("true");
  expect(scene.dataset.orbitMode).toBe("paused");
  selected("Relayer");
  view.rerender(<PaymentOrbit />);
  flush();
  expect(scene.dataset.orbitMode).toBe("active");
  expect(scene.style.getPropertyValue("--path-progress")).toBe("0.64");
  selected("x402 seller");
});

it("FE-12 responds to live reduced motion and keeps manual controls available", async () => {
  const user = userEvent.setup();
  render(<PaymentOrbit />);
  flush();
  act(() => {
    reduced = true;
    listeners.forEach((fn) => fn());
  });
  advance(384);
  selected("Wallet");
  expect(frames.size).toBe(0);
  names.forEach((name) =>
    expect(screen.getByRole("button", { name }).dataset.revealed).toBe("true"),
  );
  await user.click(screen.getByRole("button", { name: "One-time key" }));
  selected("One-time key");
  act(() => {
    reduced = false;
    listeners.forEach((fn) => fn());
  });
  flush();
  selected("x402 seller");
});

it("FE-12 remains readable without browser motion APIs and cleans up pending work", async () => {
  const user = userEvent.setup();
  const remove = vi.spyOn(window, "removeEventListener");
  const view = render(<PaymentOrbit />);
  expect(frames.size).toBe(1);
  view.unmount();
  expect(frames.size).toBe(0);
  expect(listeners.size).toBe(0);
  expect(remove.mock.calls.some(([name]) => name === "scroll")).toBe(true);
  vi.stubGlobal("matchMedia", undefined);
  vi.stubGlobal("requestAnimationFrame", undefined);
  render(<PaymentOrbit />);
  selected("Wallet");
  await user.click(screen.getByRole("button", { name: "Shared pool" }));
  selected("Shared pool");
  expect(screen.getByText(/Design preview/)).toBeTruthy();
});

it.each(["addEventListener", "removeEventListener"])(
  "FE-12 stays static when matchMedia lacks %s for live motion preferences",
  async (missing) => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: missing === "addEventListener" ? undefined : vi.fn(),
        removeEventListener:
          missing === "removeEventListener" ? undefined : vi.fn(),
      })),
    );
    render(<PaymentOrbit />);
    expect(frames.size).toBe(0);
    expect(
      screen.getByRole("region", { name: "From wallet to work." })
        .dataset.orbitMode,
    ).toBe("static");
    screen.getByRole("button", { name: "One-time key" }).focus();
    await user.keyboard(" ");
    selected("One-time key");
  },
);

it("FE-12 stays static without the observer API used by the shared motion controls", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("IntersectionObserver", undefined);
  render(<PaymentOrbit />);
  expect(frames.size).toBe(0);
  expect(
    screen.getByRole("region", { name: "From wallet to work." })
      .dataset.orbitMode,
  ).toBe("static");
  screen.getByRole("button", { name: "Relayer" }).focus();
  await user.keyboard("{Enter}");
  selected("Relayer");
  advance(384);
  selected("Relayer");
});

it("FE-12 keeps keyboard selection through focus scroll drift until another stage is reached", async () => {
  const user = userEvent.setup();
  render(<PaymentOrbit />);
  flush();
  scroll = 10;
  fireEvent.scroll(window);
  screen.getByRole("button", { name: "Local proof" }).focus();
  await user.keyboard("{Enter}");
  flush();
  selected("Local proof");
  advance(30);
  selected("Local proof");
  advance(140);
  selected("Shared pool");
});

it("FE-12 starts with an empty ring and reveals each payment step in sequence", () => {
  render(<PaymentOrbit />);
  flush();
  const scene = screen.getByRole("region", { name: "From wallet to work." });
  expect(scene.dataset.orbitPhase).toBe("intro");
  selected("Wallet");
  names.forEach((name) => {
    const button = screen.getByRole("button", { name });
    expect(button.dataset.revealed).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe("payment-path-detail");
    expect(button.tabIndex).toBe(0);
  });
  names.forEach((name, index) => {
    advance((0.12 + index * 0.1) * 600);
    expect(scene.dataset.orbitPhase).toBe("steps");
    selected(name);
    names.forEach((other, otherIndex) => {
      const button = screen.getByRole("button", { name: other });
      expect(button.dataset.revealed).toBe(String(otherIndex <= index));
      expect(button.getAttribute("aria-pressed")).toBe(
        String(otherIndex === index),
      );
    });
  });
  expect(screen.getByText(/standard x402 payment/)).toBeTruthy();
});

it("FE-12 flips the center and all six portraits together after every payment step and reverses on scroll back", () => {
  render(<PaymentOrbit />);
  flush();
  const scene = screen.getByRole("region", { name: "From wallet to work." });
  const center = scene.querySelector<HTMLElement>(".path-orbit-center")!;
  const expectFaces = (portraits: boolean) => {
    expect(center.dataset.face).toBe(portraits ? "logo" : "agent");
    names.forEach((name) => {
      const button = screen.getByRole("button", { name });
      expect(button.dataset.revealed).toBe("true");
      expect(button.dataset.portrait).toBe(String(portraits));
    });
  };

  advance(0.72 * 600);
  expect(scene.dataset.orbitPhase).toBe("steps");
  selected("x402 seller");
  expectFaces(false);
  expect(scene.style.getPropertyValue("--transform-progress")).toBe("0");

  advance(0.77 * 600);
  expect(scene.dataset.orbitPhase).toBe("transform");
  expectFaces(false);
  expect(Number(scene.style.getPropertyValue("--transform-progress"))).toBeCloseTo(0.25);
  advance(0.81 * 600);
  expect(scene.dataset.orbitPhase).toBe("transform");
  expectFaces(true);
  expect(Number(scene.style.getPropertyValue("--transform-progress"))).toBeCloseTo(0.5);
  advance(0.89 * 600);
  expect(scene.dataset.orbitPhase).toBe("complete");
  expectFaces(true);
  expect(scene.style.getPropertyValue("--transform-progress")).toBe("1");
  advance(600);
  expect(scene.dataset.orbitPhase).toBe("complete");
  expectFaces(true);

  advance(0.81 * 600);
  expect(scene.dataset.orbitPhase).toBe("transform");
  expectFaces(true);
  advance(0.8 * 600);
  expectFaces(false);
  expect(Number(scene.style.getPropertyValue("--transform-progress"))).toBeCloseTo(0.4375);
  advance(0.65 * 600);
  expect(scene.dataset.orbitPhase).toBe("steps");
  expectFaces(false);
  expect(scene.style.getPropertyValue("--transform-progress")).toBe("0");
  advance(0.32 * 600);
  selected("Local proof");
  expect(screen.getByRole("button", { name: "Relayer" }).dataset.revealed).toBe(
    "false",
  );
  advance(0);
  expect(scene.dataset.orbitPhase).toBe("intro");
  names.forEach((name) =>
    expect(screen.getByRole("button", { name }).dataset.revealed).toBe("false"),
  );
});

it("FE-12 turns the outer orbit continuously with the finale and unwinds on reverse scroll", () => {
  render(<PaymentOrbit />);
  flush();
  const scene = screen.getByRole("region", { name: "From wallet to work." });
  const turn = () => Number(scene.style.getPropertyValue("--path-turn"));
  advance(0.72 * 600);
  expect(turn()).toBe(0);
  advance(0.77 * 600);
  expect(turn()).toBeCloseTo((0.04 / 0.27) * 90);
  advance(0.81 * 600);
  const midpointTurn = turn();
  expect(midpointTurn).toBeCloseTo((0.08 / 0.27) * 90);
  advance(0.95 * 600);
  expect(turn()).toBeGreaterThan(midpointTurn);
  advance(600);
  expect(turn()).toBe(90);
  advance(0.81 * 600);
  expect(turn()).toBeCloseTo(midpointTurn);
  advance(0.65 * 600);
  expect(turn()).toBe(0);
});

it("FE-12 freezes the shared finale while paused and restores readable steps for reduced motion", () => {
  const view = render(<PaymentOrbit />);
  flush();
  const scene = screen.getByRole("region", { name: "From wallet to work." });
  advance(0.85 * 600);
  const progress = scene.style.getPropertyValue("--transform-progress");
  const turn = scene.style.getPropertyValue("--path-turn");
  expect(Number(progress)).toBeCloseTo(0.75);
  view.rerender(<PaymentOrbit paused />);
  advance(600);
  expect(scene.dataset.orbitMode).toBe("paused");
  expect(scene.style.getPropertyValue("--transform-progress")).toBe(progress);
  expect(scene.style.getPropertyValue("--path-turn")).toBe(turn);
  expect(scene.querySelector<HTMLElement>(".path-orbit-center")!.dataset.face).toBe("agent");
  names.forEach((name) => {
    const button = screen.getByRole("button", { name });
    expect(button.dataset.revealed).toBe("true");
    expect(button.dataset.portrait).toBe("false");
  });
  view.rerender(<PaymentOrbit />);
  flush();
  expect(scene.dataset.orbitPhase).toBe("complete");
  expect(scene.style.getPropertyValue("--transform-progress")).toBe("1");
  expect(scene.style.getPropertyValue("--path-turn")).toBe("90");
  act(() => {
    reduced = true;
    listeners.forEach((fn) => fn());
  });
  advance(0.8 * 600);
  expect(scene.dataset.orbitMode).toBe("reduced");
  expect(scene.dataset.orbitPhase).toBe("steps");
  expect(scene.querySelector<HTMLElement>(".path-orbit-center")!.dataset.face).toBe("agent");
  names.forEach((name) => {
    const button = screen.getByRole("button", { name });
    expect(button.dataset.revealed).toBe("true");
    expect(button.dataset.portrait).toBe("false");
  });
  expect(frames.size).toBe(0);
  view.unmount();
  expect(listeners.size).toBe(0);
  expect(frames.size).toBe(0);
});

it("FE-12 reveals a focused step during the portrait finale until the next timeline boundary", async () => {
  const user = userEvent.setup();
  render(<PaymentOrbit />);
  flush();
  const scene = screen.getByRole("region", { name: "From wallet to work." });
  advance(0.95 * 600);
  expect(scene.dataset.orbitPhase).toBe("complete");
  act(() => screen.getByRole("button", { name: "Shared pool" }).focus());
  selected("Shared pool");
  expect(scene.dataset.orbitManual).toBe("true");
  expect(scene.dataset.orbitPhase).toBe("steps");
  expect(
    scene.querySelector<HTMLElement>(".path-orbit-center")!.dataset.face,
  ).toBe("agent");
  names.forEach((name) => {
    const button = screen.getByRole("button", { name });
    expect(button.dataset.revealed).toBe("true");
    expect(button.dataset.portrait).toBe("false");
  });
  await user.keyboard("{Enter}");
  advance(0.952 * 600);
  selected("Shared pool");
  advance(600);
  expect(scene.dataset.orbitManual).toBe("true");
  expect(scene.dataset.orbitPhase).toBe("steps");
  selected("Shared pool");
  advance(0.85 * 600);
  expect(scene.dataset.orbitManual).toBe("false");
  expect(scene.dataset.orbitPhase).toBe("transform");
  selected("x402 seller");
});

it("FE-12 uses manual mode on compact screens without advancing hidden stages", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("innerWidth", 899);
  render(<PaymentOrbit />);
  flush();
  const scene = screen.getByRole("region", { name: "From wallet to work." });
  expect(scene.dataset.orbitMode).toBe("static");
  expect(scene.dataset.orbitPinned).toBe("false");
  names.forEach((name) =>
    expect(screen.getByRole("button", { name }).dataset.revealed).toBe("true"),
  );
  await user.click(screen.getByRole("button", { name: "Relayer" }));
  advance(600);
  selected("Relayer");
  expect(screen.getByText(/gets proof and intent/)).toBeTruthy();
});

it.each([
  { height: 616, pinned: "true", mode: "active" },
  { height: 617, pinned: "false", mode: "static" },
])(
  "FE-12 reserves 80 pixels above and 24 below a $height pixel scene",
  ({ height, pinned, mode }) => {
    vi.stubGlobal("innerHeight", 720);
    sceneHeight = height;
    render(<PaymentOrbit />);
    flush();
    const scene = screen.getByRole("region", { name: "From wallet to work." });
    expect(scene.dataset.orbitPinned).toBe(pinned);
    expect(scene.dataset.orbitMode).toBe(mode);
  },
);
