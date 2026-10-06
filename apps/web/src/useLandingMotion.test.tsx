import { StrictMode, useRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLandingMotion } from "./useLandingMotion";

function Scene({ paused = false }: { paused?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useLandingMotion(root, paused);
  return (
    <div ref={root} data-testid="root">
      <div data-motion-scene>
        <section data-motion-hero />
        <h2 data-motion-words>Readable words</h2>
      </div>
      <article data-reveal>
        <button>Read more</button>
      </article>
      <div data-testid="parallax-surface">
        <div data-parallax />
      </div>
    </div>
  );
}

let scroll = 0;
let reduced = false;
let frames: Map<number, FrameRequestCallback>;
let frameId = 0;
let preferenceListeners: Set<() => void>;
let observerCallback: IntersectionObserverCallback;
const disconnect = vi.fn();
const observe = vi.fn();
const unobserve = vi.fn();

function flush() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}

beforeEach(() => {
  scroll = 0;
  reduced = false;
  frames = new Map();
  preferenceListeners = new Set();
  vi.clearAllMocks();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return reduced;
      },
      addEventListener: (_: string, fn: () => void) =>
        preferenceListeners.add(fn),
      removeEventListener: (_: string, fn: () => void) =>
        preferenceListeners.delete(fn),
    })),
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      let top = -scroll;
      let height = 800;
      if (this.hasAttribute("data-motion-words")) top = 700 - scroll;
      if (this.hasAttribute("data-reveal")) top = 1600 - scroll;
      if (
        this.dataset.testid === "parallax-surface" ||
        this.hasAttribute("data-parallax")
      ) {
        top = 600 - scroll;
        height = 400;
        if (this.hasAttribute("data-parallax"))
          top += parseFloat(this.style.getPropertyValue("--parallax-y")) || 0;
      }
      return {
        x: 0,
        y: top,
        top,
        bottom: top + height,
        left: 0,
        right: 1200,
        width: 1200,
        height,
        toJSON() {},
      };
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Scroll choreography", () => {
  it("FE-08 advances and reverses with scrolling, freezes on pause, and resumes at the current position", () => {
    const { rerender } = render(<Scene />);
    const root = screen.getByTestId("root");
    const story = root.querySelector<HTMLElement>("[data-motion-scene]")!;
    const words = root.querySelector<HTMLElement>("[data-motion-words]")!;
    const illustration = root.querySelector<HTMLElement>("[data-parallax]")!;
    flush();
    expect(root.dataset.motion).toBe("active");
    expect(story.style.getPropertyValue("--scroll-progress")).toBe("0");
    const initialReading = Number(
      words.style.getPropertyValue("--read-progress"),
    );
    const initialParallax = Number(
      illustration.style.getPropertyValue("--parallax-progress"),
    );
    scroll = 360;
    fireEvent.scroll(window);
    fireEvent.scroll(window);
    expect(frames.size).toBe(1);
    flush();
    const advanced = Number(story.style.getPropertyValue("--scroll-progress"));
    const advancedReading = Number(
      words.style.getPropertyValue("--read-progress"),
    );
    const advancedParallax = Number(
      illustration.style.getPropertyValue("--parallax-progress"),
    );
    expect(advanced).toBeGreaterThan(0);
    expect(advancedReading).toBeGreaterThan(initialReading);
    expect(advancedParallax).toBeGreaterThan(initialParallax);
    const frozenIllustration = illustration.style.cssText;
    rerender(<Scene paused />);
    expect(root.dataset.motion).toBe("paused");
    scroll = 650;
    fireEvent.scroll(window);
    flush();
    expect(Number(story.style.getPropertyValue("--scroll-progress"))).toBe(
      advanced,
    );
    expect(Number(words.style.getPropertyValue("--read-progress"))).toBe(
      advancedReading,
    );
    expect(illustration.style.cssText).toBe(frozenIllustration);
    expect(
      root.querySelector<HTMLElement>("[data-reveal]")!.dataset.revealed,
    ).toBe("true");
    rerender(<Scene />);
    flush();
    expect(
      Number(story.style.getPropertyValue("--scroll-progress")),
    ).toBeGreaterThan(advanced);
    expect(
      Number(words.style.getPropertyValue("--read-progress")),
    ).toBeGreaterThan(advancedReading);
    expect(
      Number(illustration.style.getPropertyValue("--parallax-progress")),
    ).toBeGreaterThan(advancedParallax);
    scroll = 0;
    fireEvent.scroll(window);
    flush();
    expect(story.style.getPropertyValue("--scroll-progress")).toBe("0");
    expect(Number(words.style.getPropertyValue("--read-progress"))).toBe(
      initialReading,
    );
    expect(
      Number(illustration.style.getPropertyValue("--parallax-progress")),
    ).toBe(initialParallax);
  });

  it("FE-08 keeps illustration positions stable when the scroll position has not changed", () => {
    scroll = 360;
    render(<Scene />);
    flush();
    const illustration = screen
      .getByTestId("root")
      .querySelector<HTMLElement>("[data-parallax]")!;
    const position = illustration.style.cssText;
    fireEvent.scroll(window);
    flush();
    expect(illustration.style.cssText).toBe(position);
  });

  it("FE-08 reveals a section once it enters view", () => {
    render(<Scene />);
    const target = screen
      .getByTestId("root")
      .querySelector<HTMLElement>("[data-reveal]")!;
    expect(target.dataset.revealed).toBe("false");
    expect(observe).toHaveBeenCalledWith(target);
    act(() =>
      observerCallback(
        [
          {
            target,
            isIntersecting: true,
          } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      ),
    );
    expect(target.dataset.revealed).toBe("true");
    expect(unobserve).toHaveBeenCalledWith(target);
  });

  it("FE-09 respects initial and live reduced-motion preferences without scheduling scroll frames", () => {
    reduced = true;
    render(<Scene />);
    const root = screen.getByTestId("root");
    expect(root.dataset.motion).toBe("reduced");
    fireEvent.scroll(window);
    expect(frames.size).toBe(0);
    act(() => {
      reduced = false;
      preferenceListeners.forEach((fn) => fn());
    });
    flush();
    expect(root.dataset.motion).toBe("active");
    act(() => {
      reduced = true;
      preferenceListeners.forEach((fn) => fn());
    });
    expect(root.dataset.motion).toBe("reduced");
    fireEvent.scroll(window);
    expect(frames.size).toBe(0);
    expect(
      root.querySelector<HTMLElement>("[data-reveal]")!.dataset.revealed,
    ).toBe("true");
  });

  it.each([
    "IntersectionObserver",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "matchMedia",
  ])("FE-09 leaves content readable when %s is unavailable", (missing) => {
    vi.stubGlobal(missing, undefined);
    render(<Scene />);
    const root = screen.getByTestId("root");
    expect(root.dataset.motion).toBe("static");
    expect(
      root.querySelector<HTMLElement>("[data-reveal]")!.dataset.revealed,
    ).toBe("true");
    expect(frames.size).toBe(0);
  });

  it.each(["addEventListener", "removeEventListener"])(
    "FE-09 leaves content readable when media %s is unavailable",
    (missing) => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({
          matches: false,
          addEventListener:
            missing === "addEventListener" ? undefined : vi.fn(),
          removeEventListener:
            missing === "removeEventListener" ? undefined : vi.fn(),
        })),
      );
      render(<Scene />);
      const root = screen.getByTestId("root");
      expect(root.dataset.motion).toBe("static");
      expect(
        root.querySelector<HTMLElement>("[data-reveal]")!.dataset.revealed,
      ).toBe("true");
      expect(frames.size).toBe(0);
    },
  );

  it("FE-10 removes observers, preferences, listeners, and pending frames on unmount", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<Scene />);
    fireEvent.scroll(window);
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
    expect(disconnect).toHaveBeenCalled();
    expect(preferenceListeners.size).toBe(0);
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
    fireEvent.scroll(window);
    expect(frames.size).toBe(0);
  });

  it("FE-10 starts one working listener set after StrictMode replay and remount", () => {
    const initial = render(
      <StrictMode>
        <Scene />
      </StrictMode>,
    );
    expect(preferenceListeners.size).toBe(1);
    expect(frames.size).toBe(1);
    initial.unmount();
    expect(preferenceListeners.size).toBe(0);
    expect(frames.size).toBe(0);

    const second = render(
      <StrictMode>
        <Scene />
      </StrictMode>,
    );
    expect(preferenceListeners.size).toBe(1);
    flush();
    scroll = 360;
    fireEvent.scroll(window);
    fireEvent.scroll(window);
    expect(frames.size).toBe(1);
    flush();
    expect(
      Number(
        screen
          .getByTestId("root")
          .querySelector<HTMLElement>("[data-motion-scene]")!
          .style.getPropertyValue("--scroll-progress"),
      ),
    ).toBeGreaterThan(0);
    second.unmount();
    expect(preferenceListeners.size).toBe(0);
    expect(frames.size).toBe(0);
    fireEvent.scroll(window);
    expect(frames.size).toBe(0);
  });
});
