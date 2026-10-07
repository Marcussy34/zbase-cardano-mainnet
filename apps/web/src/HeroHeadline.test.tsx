import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import HeroHeadline from "./HeroHeadline";

const headline = "Private payments. Unknown origins.";

describe("Hero headline", () => {
  it.each(["active", "paused", "reduced", "static"])(
    "FE-11 keeps the word and accessible headline unchanged on pointer entry in %s mode",
    (mode) => {
      render(
        <div data-motion={mode}>
          <HeroHeadline />
        </div>,
      );
      const heading = screen.getByRole("heading", { level: 1, name: headline });
      const word = screen.getByText("Unknown");
      fireEvent.pointerEnter(word);
      fireEvent.pointerLeave(word);
      fireEvent.pointerEnter(word);
      expect(screen.getByText("Unknown")).toBe(word);
      expect(screen.getByRole("heading", { level: 1, name: headline })).toBe(
        heading,
      );
      expect(heading.querySelector("button, a, [tabindex]")).toBeNull();
    },
  );

  it("FE-11 keeps the smoke decorative and exposes one stable readable word", () => {
    const { container } = render(<HeroHeadline />);
    expect(screen.getAllByText("Unknown")).toHaveLength(1);
    const smoke = container.querySelector(".hero-word-smoke");
    expect(smoke?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".hero-word-fill")?.textContent).toBe("Unknown");
    expect(container.querySelector(".hero-cipher")).toBeNull();
  });
});
