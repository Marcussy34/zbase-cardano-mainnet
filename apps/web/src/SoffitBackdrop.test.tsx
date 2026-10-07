import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SoffitBackdrop from "./SoffitBackdrop";

function rendererHarness() {
  const gl = {
    VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, COMPILE_STATUS: 35713,
    LINK_STATUS: 35714, TRIANGLES: 4,
    createShader: vi.fn(() => ({})), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})), attachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true), useProgram: vi.fn(), deleteProgram: vi.fn(),
    createVertexArray: vi.fn(() => ({})), bindVertexArray: vi.fn(), deleteVertexArray: vi.fn(),
    getUniformLocation: vi.fn((_program, name: string) => name),
    uniform1f: vi.fn(), uniform2f: vi.fn(), uniform3f: vi.fn(), viewport: vi.fn(), drawArrays: vi.fn(),
  };
  vi.stubGlobal("WebGL2RenderingContext", class {});
  const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(gl as unknown as WebGL2RenderingContext);
  let rect = { width: 900, height: 360, left: 80, top: 100 };
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(() => rect as DOMRect);
  vi.stubGlobal("devicePixelRatio", 3);

  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const raf = vi.fn((callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  const cancel = vi.fn((id: number) => { frames.delete(id); });
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const advance = (now: number) => {
    const callbacks = [...frames.values()];
    frames.clear();
    act(() => callbacks.forEach((callback) => callback(now)));
  };

  let intersection: IntersectionObserverCallback = () => {};
  const intersectionDisconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersection = callback; }
    observe = vi.fn();
    disconnect = intersectionDisconnect;
  });
  let resized: ResizeObserverCallback = () => {};
  const resizeDisconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resized = callback; }
    observe = vi.fn();
    disconnect = resizeDisconnect;
  });
  let motionChanged: MutationCallback = () => {};
  const motionDisconnect = vi.fn();
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: MutationCallback) { motionChanged = callback; }
    observe = vi.fn();
    disconnect = motionDisconnect;
  });
  let reducedChanged: () => void = () => {};
  const media = {
    matches: false,
    addEventListener: vi.fn((_event, callback: () => void) => { reducedChanged = callback; }),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const show = (visible: boolean) => act(() => intersection([
    { isIntersecting: visible } as IntersectionObserverEntry,
  ], {} as IntersectionObserver));
  const changeMotion = (site: Element, motion: string) => act(() => {
    site.setAttribute("data-motion", motion);
    motionChanged([], {} as MutationObserver);
  });
  return {
    gl, context, frames, raf, cancel, advance, show, changeMotion,
    intersectionDisconnect, resizeDisconnect, motionDisconnect, media,
    resize: () => act(() => { rect = { ...rect, width: 600, height: 420 }; resized([], {} as ResizeObserver); }),
    reduce: () => act(() => { media.matches = true; reducedChanged(); }),
    hide: (value: boolean) => act(() => { hidden = value; document.dispatchEvent(new Event("visibilitychange")); }),
  };
}

const mountBackdrop = (motion = "active") => render(
  <div className="site" data-motion={motion}>
    <div className="overview-panel"><SoffitBackdrop /></div>
  </div>,
);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("FE-17 keeps the static backdrop when WebGL2 is unavailable", () => {
  vi.stubGlobal("WebGL2RenderingContext", undefined);
  const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
  const { container } = mountBackdrop();
  const canvas = container.querySelector("canvas")!;
  expect(context).not.toHaveBeenCalled();
  expect(canvas.getAttribute("aria-hidden")).toBe("true");
  expect(canvas.dataset.ready).toBe("false");
});

it("FE-17 draws the approved palette in one triangle at panel size with DPR capped at one", () => {
  const runtime = rendererHarness();
  const { container, unmount } = mountBackdrop();
  const canvas = container.querySelector("canvas")!;
  expect([canvas.width, canvas.height]).toEqual([900, 360]);
  expect(runtime.gl.uniform3f).toHaveBeenCalledWith("uBg", 200 / 255, 208 / 255, 240 / 255);
  expect(runtime.gl.uniform3f).toHaveBeenCalledWith("uColorA", 191 / 255, 232 / 255, 216 / 255);
  expect(runtime.gl.uniform1f).toHaveBeenCalledWith("uSpread", -2.7);
  expect(runtime.gl.uniform1f).toHaveBeenCalledWith("uScale", 1);
  expect(runtime.gl.drawArrays).toHaveBeenCalledExactlyOnceWith(4, 0, 3);
  expect(canvas.dataset.ready).toBe("true");
  expect(runtime.frames.size).toBe(0);
  runtime.show(true);
  runtime.advance(100);
  runtime.resize();
  runtime.advance(116);
  expect([canvas.width, canvas.height]).toEqual([600, 420]);
  expect(runtime.gl.viewport).toHaveBeenLastCalledWith(0, 0, 600, 420);
  unmount();
});

it("FE-17 stops offscreen, hidden and paused frames and resumes without catching up wall time", () => {
  const runtime = rendererHarness();
  const { container, unmount } = mountBackdrop();
  const site = container.querySelector(".site")!;
  runtime.show(true);
  runtime.advance(100);
  runtime.advance(116);
  const clock = () => runtime.gl.uniform1f.mock.calls.filter(([name]) => name === "iTime").at(-1)?.[1];
  const beforePause = clock();
  runtime.changeMotion(site, "paused");
  expect(runtime.frames.size).toBe(0);
  expect(runtime.gl.deleteProgram).not.toHaveBeenCalled();
  runtime.changeMotion(site, "active");
  runtime.advance(50000);
  expect(clock()).toBe(beforePause);
  runtime.hide(true);
  expect(runtime.frames.size).toBe(0);
  runtime.hide(false);
  expect(runtime.frames.size).toBe(1);
  runtime.show(false);
  expect(runtime.frames.size).toBe(0);
  runtime.show(true);
  runtime.reduce();
  expect(runtime.frames.size).toBe(0);
  unmount();
});

it("FE-17 follows pointer coordinates within the panel and ignores them while paused", () => {
  const runtime = rendererHarness();
  const { container, unmount } = mountBackdrop();
  const panel = container.querySelector(".overview-panel")!;
  const site = container.querySelector(".site")!;
  runtime.show(true);
  act(() => panel.dispatchEvent(new MouseEvent("pointermove", { clientX: 890, clientY: 190 })));
  runtime.advance(100);
  runtime.advance(116);
  const pointer = runtime.gl.uniform2f.mock.calls.filter(([name]) => name === "iMouse").at(-1)!;
  expect(pointer[1]).toBeCloseTo(0.105 * 0.96 * 0.043 * 0.96);
  expect(pointer[2]).toBeCloseTo(0.25 * 0.105 * 0.96 * 0.043 * 0.96);
  runtime.changeMotion(site, "paused");
  const drawCount = runtime.gl.drawArrays.mock.calls.length;
  act(() => panel.dispatchEvent(new MouseEvent("pointermove", { clientX: 100, clientY: 800 })));
  expect(runtime.gl.drawArrays).toHaveBeenCalledTimes(drawCount);
  expect(runtime.frames.size).toBe(0);
  unmount();
});

it("FE-17 applies an offscreen resize when a paused backdrop becomes visible", () => {
  const runtime = rendererHarness();
  const { container, unmount } = mountBackdrop("paused");
  const canvas = container.querySelector("canvas")!;
  runtime.resize();
  expect([canvas.width, canvas.height]).toEqual([900, 360]);
  runtime.show(true);
  expect([canvas.width, canvas.height]).toEqual([600, 420]);
  expect(runtime.frames.size).toBe(0);
  unmount();
});

it("FE-17 exposes the fallback on context loss and releases resources and listeners on unmount", () => {
  const runtime = rendererHarness();
  const removeDocumentListener = vi.spyOn(document, "removeEventListener");
  const removeElementListener = vi.spyOn(HTMLElement.prototype, "removeEventListener");
  const { container, unmount } = mountBackdrop();
  const canvas = container.querySelector("canvas")!;
  runtime.show(true);
  act(() => canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true })));
  expect(runtime.frames.size).toBe(0);
  expect(canvas.dataset.ready).toBe("false");
  unmount();
  expect(runtime.gl.deleteShader).toHaveBeenCalledTimes(2);
  expect(runtime.gl.deleteProgram).toHaveBeenCalledOnce();
  expect(runtime.gl.deleteVertexArray).toHaveBeenCalledOnce();
  expect(runtime.gl.useProgram).toHaveBeenLastCalledWith(null);
  expect(runtime.intersectionDisconnect).toHaveBeenCalledOnce();
  expect(runtime.resizeDisconnect).toHaveBeenCalledOnce();
  expect(runtime.motionDisconnect).toHaveBeenCalledOnce();
  expect(runtime.media.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  expect(removeDocumentListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  expect(removeElementListener.mock.calls.some(([name]) => name === "pointermove")).toBe(true);
});

it("FE-17 cleans up failed shader compilation and leaves the CSS backdrop visible", () => {
  const runtime = rendererHarness();
  runtime.gl.getShaderParameter.mockReturnValue(false);
  const { container, unmount } = mountBackdrop();
  expect(container.querySelector("canvas")?.dataset.ready).toBe("false");
  expect(runtime.gl.drawArrays).not.toHaveBeenCalled();
  expect(runtime.frames.size).toBe(0);
  expect(runtime.gl.deleteShader).toHaveBeenCalledOnce();
  unmount();
});
