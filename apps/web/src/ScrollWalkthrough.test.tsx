import { render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ScrollWalkthrough from "./ScrollWalkthrough";

const overview = () => within(screen.getByRole("region", { name: "Payment overview" }));
const nodeNames = ["Your wallet", "Shared pool", "One-time key", "x402 seller", "Your agent", "Relayer"];
const nodeNotes = ["Holds your agent's funds", "Shared by many agents", "A fresh address, used once", "A normal paid API. Nothing changes.", "Private note stays local", "Never sees your secrets"];
const routeLabels = ["Deposit", "Withdraw", "Pays out", "unlinkable", "Pays the seller", "Fee quote", "Proof", "Submits the proof", "Agent asks, seller quotes a price", "Seller is paid and delivers", "Proves on your device"];
// Labels of the first drawing, before the diagram followed the architecture diagram.
const retiredLabels = ["Planned flow", "ADA deposit", "Price + fee", "Proof + intent", "Submit proof", "x402 payment"];

function completeDiagram() {
  const flow = overview();
  expect(flow.getAllByRole("img")).toHaveLength(1);
  const diagram = flow.getByRole("img");
  [...nodeNames, ...nodeNotes, ...routeLabels].forEach((text) => {
    expect(within(diagram).getAllByText(text, { exact: true })).toHaveLength(1);
  });
  retiredLabels.forEach((text) => expect(flow.queryByText(text)).toBeNull());
  expect(flow.queryByRole("list")).toBeNull();
  expect(flow.queryByRole("button")).toBeNull();
  return diagram;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("FE-14 presents one connected payment diagram that follows the real flow", () => {
  render(<ScrollWalkthrough />);
  const flow = overview();
  expect(screen.getByRole("heading", { name: "One payment. The whole picture.", level: 2 })).toBeTruthy();
  expect(flow.getByText("Live on Preprod")).toBeTruthy();
  expect(flow.getByText("Note secrets stay local")).toBeTruthy();
  ["On chain", "Web request", "No link to your wallet"].forEach((key) => expect(flow.getByText(key)).toBeTruthy());
  const diagram = completeDiagram();
  const description = diagram.getAttribute("aria-label") ?? "";
  // The description walks the flow in order: deposit, price quote, fee quote, proof, submission, payout, payment, delivery.
  [
    /wallet.*deposits.*shared pool/i,
    /withdraw/i,
    /asks.*seller.*price/i,
    /fee quote.*relayer/i,
    /(?:note|secrets).*local/i,
    /only the proof.*relayer/i,
    /relayer.*submits.*proof.*pool/i,
    /pool.*pays out.*one-time key/i,
    /no link to your wallet/i,
    /key.*pays.*seller/i,
    /seller.*delivers/i,
  ].forEach((pattern) => expect(description).toMatch(pattern));
  ["Deposit", "Prove locally", "Pay"].forEach((name) => {
    expect(flow.queryByRole("heading", { name })).toBeNull();
  });
});

it("FE-14 draws on-chain routes solid, web requests dashed, and the seller talk two-way", () => {
  const { container } = render(<ScrollWalkthrough />);
  for (const layout of ["desktop", "mobile"]) {
    const routes = container.querySelector(`.overview-routes-${layout}`);
    expect(routes).not.toBeNull();
    // Five on-chain routes: deposit, withdraw, payout, pay the seller, submit the proof. Two web routes: proof, seller talk.
    expect(routes!.querySelectorAll(".overview-route-chain")).toHaveLength(5);
    expect(routes!.querySelectorAll(".overview-route-web")).toHaveLength(2);
    expect(routes!.querySelectorAll(".overview-tone-lavender")).toHaveLength(4);
    // Nine packets: one per step of the loop, three of them on the seller route.
    expect(routes!.querySelectorAll(".overview-packet")).toHaveLength(9);
    const seller = routes!.querySelector(".overview-tone-mint .overview-wire")!;
    expect(seller.getAttribute("marker-start")).toBeTruthy();
    expect(seller.getAttribute("marker-end")).toBeTruthy();
    expect(routes!.querySelectorAll(".overview-wire[marker-start]")).toHaveLength(1);
  }
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
  "FE-14 keeps every route and label readable with %s",
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
