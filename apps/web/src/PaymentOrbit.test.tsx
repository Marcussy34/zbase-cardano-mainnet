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
  advance(600);
  selected("Relayer");
  expect(scene.style.getPropertyValue("--path-progress")).toBe("0.5");
  advance(1100);
  selected("x402 seller");
  expect(Number(scene.style.getPropertyValue("--path-progress"))).toBeLessThan(
    1,
  );
  advance(1200);
  expect(scene.style.getPropertyValue("--path-progress")).toBe("1");
  advance(400);
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
  names.forEach((name) =>
    expect(screen.getByRole("button", { name })).toBeTruthy(),
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

it("FE-12 exposes six keyboard controls and keeps manual selection until scroll progress changes", async () => {
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
  advance(620);
  selected("x402 seller");
  expect(screen.getByText(/standard x402 payment/)).toBeTruthy();
  advance(250);
  selected("Local proof");
});

it("FE-12 freezes automatic changes while paused and resumes at the current position", async () => {
  const user = userEvent.setup();
  const view = render(<PaymentOrbit />);
  flush();
  advance(250);
  selected("Local proof");
  view.rerender(<PaymentOrbit paused />);
  advance(620);
  selected("Local proof");
  await user.click(screen.getByRole("button", { name: "Relayer" }));
  selected("Relayer");
  view.rerender(<PaymentOrbit />);
  flush();
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
  advance(620);
  selected("Wallet");
  expect(frames.size).toBe(0);
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
  advance(620);
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
  advance(120);
  selected("Shared pool");
});
