import { render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ScrollWalkthrough from "./ScrollWalkthrough";

const overview = () => within(screen.getByRole("region", { name: "Payment overview" }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("FE-14 shows the entire planned payment flow on first render", () => {
  render(<ScrollWalkthrough />);
  const flow = overview();
  expect(flow.getByText("Planned flow")).toBeTruthy();
  expect(flow.getAllByRole("listitem")).toHaveLength(3);
  ["Deposit", "Prove locally", "Pay"].forEach((name) => {
    expect(flow.getByRole("heading", { name, level: 3 })).toBeTruthy();
  });
  expect(flow.getByText(/Deposit ADA into the shared pool/)).toBeTruthy();
  expect(flow.getByText(/private note stays on your device/)).toBeTruthy();
  expect(flow.getByText(/Send only proof and intent to the relayer/)).toBeTruthy();
  expect(flow.getByText(/pool funds a one-time key, which pays the x402 seller/)).toBeTruthy();
  expect(flow.getByText("Note secrets stay local")).toBeTruthy();
  expect(flow.getAllByRole("img")).toHaveLength(3);
  expect(flow.queryByRole("button")).toBeNull();
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
  "FE-14 remains complete with %s",
  (mode) => {
    vi.stubGlobal("matchMedia", mode === "reduced motion" ? vi.fn(() => ({ matches: true })) : undefined);
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.stubGlobal("requestAnimationFrame", undefined);
    render(<ScrollWalkthrough />);
    const flow = overview();
    expect(flow.getAllByRole("listitem")).toHaveLength(3);
    expect(flow.getByRole("heading", { name: "Pay" })).toBeTruthy();
    expect(flow.getByText(/pool funds a one-time key/)).toBeTruthy();
  },
);


it("FE-14 runs decorative loops only while each card is in view and disconnects on unmount", () => {
  let onIntersection: IntersectionObserverCallback;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { onIntersection = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  const { unmount } = render(<ScrollWalkthrough />);
  const cards = overview().getAllByRole("listitem");
  expect(observe).toHaveBeenCalledTimes(3);
  cards.forEach((card) => expect(observe).toHaveBeenCalledWith(card));
  const update = (target: Element, visible: boolean) => onIntersection([
    { target, isIntersecting: visible, intersectionRatio: visible ? 0.5 : 0 } as IntersectionObserverEntry,
  ], {} as IntersectionObserver);
  update(cards[0], true);
  expect(cards[0].getAttribute("data-in-view")).toBe("true");
  expect(cards[1].getAttribute("data-in-view")).not.toBe("true");
  update(cards[0], false);
  update(cards[2], true);
  expect(cards[0].getAttribute("data-in-view")).toBe("false");
  expect(cards[2].getAttribute("data-in-view")).toBe("true");
  expect(overview().getAllByRole("heading")).toHaveLength(3);
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
