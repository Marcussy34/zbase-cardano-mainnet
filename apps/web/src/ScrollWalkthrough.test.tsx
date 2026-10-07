import { render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ScrollWalkthrough from "./ScrollWalkthrough";

const overview = () => within(screen.getByRole("region", { name: "Payment overview" }));
const nodeNames = ["Your wallet", "Shared pool", "One-time key", "x402 seller", "Your agent", "Relayer"];

function completeDiagram() {
  const flow = overview();
  expect(flow.getAllByRole("img")).toHaveLength(1);
  const diagram = flow.getByRole("img");
  nodeNames.forEach((name) => {
    expect(within(diagram).getAllByText(name, { exact: true })).toHaveLength(1);
  });
  expect(flow.queryByRole("list")).toBeNull();
  expect(flow.queryByRole("button")).toBeNull();
  return diagram;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("FE-14 presents one connected payment diagram with the funding and local proof branches", () => {
  render(<ScrollWalkthrough />);
  const flow = overview();
  expect(screen.getByRole("heading", { name: "One payment. The whole picture.", level: 2 })).toBeTruthy();
  expect(flow.getByText("Planned flow")).toBeTruthy();
  expect(flow.getByText("Note secrets stay local")).toBeTruthy();
  const diagram = completeDiagram();
  const description = diagram.getAttribute("aria-label");
  expect(description).toMatch(/wallet.*deposits ADA.*shared pool/i);
  expect(description).toMatch(/pool funds.*one-time key/i);
  expect(description).toMatch(/key.*(?:pays|payment).*seller/i);
  expect(description).toMatch(/(?:note|secrets).*local/i);
  expect(description).toMatch(/(?:proof and intent|proof \+ intent).*relayer/i);
  expect(description).toMatch(/relayer.*(?:submits|sends).*proof.*pool/i);
  ["Deposit", "Prove locally", "Pay"].forEach((name) => {
    expect(flow.queryByRole("heading", { name })).toBeNull();
  });
});

it("FE-14 never installs scroll animation or resize listeners", () => {
  const listen = vi.spyOn(window, "addEventListener");
  const frame = vi.fn();
  vi.stubGlobal("requestAnimationFrame", frame);
  render(<ScrollWalkthrough />);
  expect(listen.mock.calls.some(([event]) => ["scroll", "resize"].includes(event))).toBe(false);
  expect(frame).not.toHaveBeenCalled();
  expect(document.querySelector("#how-it-works")?.hasAttribute("data-pinned")).toBe(false);
  expect(screen.queryByText(/scroll to play/i)).toBeNull();
});

it.each(["reduced motion", "missing motion APIs"])(
  "FE-14 keeps both connected branches readable with %s",
  (mode) => {
    vi.stubGlobal("matchMedia", mode === "reduced motion" ? vi.fn(() => ({ matches: true })) : undefined);
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.stubGlobal("requestAnimationFrame", undefined);
    render(<ScrollWalkthrough />);
    completeDiagram();
    expect(overview().getByText("Note secrets stay local")).toBeTruthy();
  },
);

it("FE-14 runs decorative flow only while the whole diagram is in view and disconnects on unmount", () => {
  let onIntersection: IntersectionObserverCallback;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { onIntersection = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  const { unmount } = render(<ScrollWalkthrough />);
  const diagram = completeDiagram();
  expect(observe).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledWith(diagram);
  const update = (intersectionRatio: number, isIntersecting = true) => onIntersection([
    {
      target: diagram,
      isIntersecting,
      intersectionRatio,
      boundingClientRect: diagram.getBoundingClientRect(),
      intersectionRect: diagram.getBoundingClientRect(),
      rootBounds: null,
      time: 0,
    },
  ], {} as IntersectionObserver);
  update(0.24);
  expect(diagram.getAttribute("data-in-view")).toBe("false");
  update(0.25);
  expect(diagram.getAttribute("data-in-view")).toBe("true");
  update(0, false);
  expect(diagram.getAttribute("data-in-view")).toBe("false");
  completeDiagram();
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
