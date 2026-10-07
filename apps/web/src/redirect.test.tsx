import { afterEach, expect, it, vi } from "vitest";

const { render } = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render, unmount: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(["/docs", "/docs/", "/docs/reference/spec"])(
  "FE-02 redirects %s to the documentation site without rendering",
  async (pathname) => {
    const replace = vi.fn();
    // Keep navigation inside the test instead of leaving jsdom.
    vi.stubGlobal("window", { location: { pathname, replace } });
    vi.resetModules();

    await import("./main");

    expect(replace).toHaveBeenCalledExactlyOnceWith("https://docs.zx402.org/");
    expect(render).not.toHaveBeenCalled();
  },
);
