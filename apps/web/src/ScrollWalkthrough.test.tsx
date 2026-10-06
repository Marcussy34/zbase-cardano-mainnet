import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ScrollWalkthrough from "./ScrollWalkthrough";

let scroll = 0;
let reduced = false;
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
let preferences: Set<() => void>;
let sceneHeight = 620;
const names = [/01.*Deposit/i, /02.*Prove locally/i, /03.*Pay/i];
const section = () => document.querySelector<HTMLElement>("#how-it-works")!;
const progress = () =>
  Number(section().style.getPropertyValue("--scene-progress"));
function flush() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}
function advance(position: number) {
  scroll = position;
  fireEvent.scroll(window);
  flush();
}
function selected(index: number) {
  expect(
    screen
      .getByRole("button", { name: names[index] })
      .getAttribute("aria-pressed"),
  ).toBe("true");
}
beforeEach(() => {
  scroll = 0;
  reduced = false;
  sceneHeight = 620;
  frames = new Map();
  preferences = new Set();
  vi.stubGlobal("innerHeight", 900);
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
      addEventListener: (_: string, fn: () => void) => preferences.add(fn),
      removeEventListener: (_: string, fn: () => void) =>
        preferences.delete(fn),
    })),
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return {
        top: 24 - scroll,
        bottom: 2444 - scroll,
        height: this.classList.contains("scw-sticky") ? sceneHeight : 2420,
        width: 1200,
        x: 0,
        y: 24 - scroll,
        left: 0,
        right: 1200,
        toJSON() {},
      };
    },
  );
});

it("FE-14 tells the planned exchange through separate agent and network terminals", async () => {
  const user = userEvent.setup();
  render(<ScrollWalkthrough />);
  expect(screen.getByRole("region", { name: "Your agent" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "The network" })).toBeTruthy();
  expect(screen.getByText(/Illustrative session/).textContent).toContain(
    "In development",
  );
  await user.click(screen.getByRole("button", { name: names[1] }));
  expect(screen.getByText("Proof + intent")).toBeTruthy();
  expect(screen.getByText("Note secrets stay here.")).toBeTruthy();
  expect(screen.getByText("Never received")).toBeTruthy();
});

it("FE-14 pins a fitting laptop scene for the complete sequence and falls back when it cannot fit", () => {
  vi.stubGlobal("innerHeight", 720);
  render(<ScrollWalkthrough />);
  flush();
  expect(section().dataset.pinned).toBe("true");
  advance(1799);
  selected(2);
  expect(progress()).toBeGreaterThan(0.99);
  advance(1800);
  expect(progress()).toBe(1);
  sceneHeight = 750;
  fireEvent.resize(window);
  flush();
  expect(section().dataset.pinned).toBe("false");
  expect(progress()).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: names[0] }));
  advance(900);
  selected(0);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("FE-14 scrubs the transfer, proof and payment scenes forward and backward", () => {
  render(<ScrollWalkthrough />);
  flush();
  selected(0);
  expect(progress()).toBe(0);
  advance(300);
  expect(progress()).toBeCloseTo(0.5);
  expect(screen.getByText("A private note")).toBeTruthy();
  advance(900);
  selected(1);
  expect(progress()).toBeCloseTo(0.5);
  expect(screen.getByText("Your machine")).toBeTruthy();
  advance(1500);
  selected(2);
  expect(progress()).toBeCloseTo(0.5);
  expect(screen.getByText("One-time key")).toBeTruthy();
  advance(1800);
  expect(progress()).toBe(1);
  advance(150);
  selected(0);
  expect(progress()).toBeCloseTo(0.25);
  expect(
    screen
      .getByRole("region", { name: "Payment walkthrough" })
      .hasAttribute("aria-live"),
  ).toBe(false);
});
it("FE-14 preserves keyboard selection through focus drift until another scroll stage", async () => {
  const user = userEvent.setup();
  render(<ScrollWalkthrough />);
  flush();
  scroll = 10;
  fireEvent.scroll(window);
  screen.getByRole("button", { name: names[2] }).focus();
  await user.keyboard("{Enter}");
  flush();
  selected(2);
  expect(progress()).toBe(1);
  advance(50);
  selected(2);
  expect(progress()).toBe(1);
  fireEvent.resize(window);
  flush();
  selected(2);
  advance(700);
  selected(1);
  expect(progress()).toBeCloseTo(1 / 6);
});
it("FE-14 pauses the scroll story, completes its illustration, and resumes at the current position", async () => {
  const user = userEvent.setup();
  const view = render(<ScrollWalkthrough />);
  flush();
  advance(900);
  view.rerender(<ScrollWalkthrough paused />);
  expect(section().dataset.walkthroughMode).toBe("paused");
  expect(progress()).toBe(1);
  advance(1800);
  selected(1);
  await user.click(screen.getByRole("button", { name: names[0] }));
  selected(0);
  expect(progress()).toBe(1);
  view.rerender(<ScrollWalkthrough />);
  flush();
  selected(2);
});
it("FE-14 responds to live motion preferences with readable manual scenes", async () => {
  const user = userEvent.setup();
  render(<ScrollWalkthrough />);
  flush();
  act(() => {
    reduced = true;
    preferences.forEach((listener) => listener());
  });
  expect(section().dataset.walkthroughMode).toBe("reduced");
  expect(progress()).toBe(1);
  advance(1700);
  selected(0);
  expect(frames.size).toBe(0);
  await user.click(screen.getByRole("button", { name: names[2] }));
  selected(2);
  act(() => {
    reduced = false;
    preferences.forEach((listener) => listener());
  });
  flush();
  expect(section().dataset.walkthroughMode).toBe("active");
  expect(progress()).toBeCloseTo(5 / 6);
});
it.each([
  "matchMedia",
  "IntersectionObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])("FE-14 provides manual scenes without %s", async (api) => {
  const user = userEvent.setup();
  vi.stubGlobal(api, undefined);
  render(<ScrollWalkthrough />);
  expect(section().dataset.walkthroughMode).toBe("static");
  expect(progress()).toBe(1);
  expect(frames.size).toBe(0);
  await user.click(screen.getByRole("button", { name: names[1] }));
  selected(1);
  expect(screen.getByText("Note secrets stay here.")).toBeTruthy();
});
it("FE-14 coalesces scroll frames and clears listeners and scheduled work on unmount", () => {
  const remove = vi.spyOn(window, "removeEventListener");
  const view = render(<ScrollWalkthrough />);
  fireEvent.scroll(window);
  fireEvent.scroll(window);
  expect(frames.size).toBe(1);
  view.unmount();
  expect(frames.size).toBe(0);
  expect(preferences.size).toBe(0);
  expect(remove.mock.calls.some(([event]) => event === "scroll")).toBe(true);
  expect(remove.mock.calls.some(([event]) => event === "resize")).toBe(true);
});
