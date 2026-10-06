import { useEffect, type RefObject } from "react";

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

export function useLandingMotion(
  root: RefObject<HTMLDivElement | null>,
  paused: boolean,
) {
  useEffect(() => {
    const site = root.current;
    if (!site) return;
    const scene = site.querySelector<HTMLElement>("[data-motion-scene]");
    const hero = site.querySelector<HTMLElement>("[data-motion-hero]");
    const words = site.querySelector<HTMLElement>("[data-motion-words]");
    const reveals = [...site.querySelectorAll<HTMLElement>("[data-reveal]")];
    const illustrations = [
      ...site.querySelectorAll<HTMLElement>("[data-parallax]"),
    ];
    const media =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const canWatchPreference =
      media !== null &&
      typeof media.addEventListener === "function" &&
      typeof media.removeEventListener === "function";
    const canAnimate =
      canWatchPreference &&
      typeof window.IntersectionObserver === "function" &&
      typeof window.requestAnimationFrame === "function" &&
      typeof window.cancelAnimationFrame === "function";
    let frame: number | null = null;
    let observer: IntersectionObserver | null = null;

    const revealAll = () =>
      reveals.forEach((element) => {
        element.dataset.revealed = "true";
      });
    const update = () => {
      frame = null;
      const viewport = window.innerHeight;
      if (scene && hero) {
        const sceneBounds = scene.getBoundingClientRect();
        const heroBounds = hero.getBoundingClientRect();
        scene.style.setProperty(
          "--scroll-progress",
          String(
            clamp(-sceneBounds.top / Math.max(heroBounds.height * 0.85, 1)),
          ),
        );
      }
      if (words) {
        const bounds = words.getBoundingClientRect();
        words.style.setProperty(
          "--read-progress",
          String(
            clamp(
              (viewport * 0.86 - bounds.top) /
                (viewport * 0.38 + bounds.height * 0.3),
            ),
          ),
        );
      }
      const compact = window.innerWidth <= 700;
      const positions = illustrations.map((element) => {
        const bounds = (
          element.parentElement ?? element
        ).getBoundingClientRect();
        return clamp(
          (viewport * 0.55 - (bounds.top + bounds.height / 2)) / viewport,
          -0.65,
          0.65,
        );
      });
      illustrations.forEach((element, index) => {
        const progress = positions[index];
        element.style.setProperty(
          "--parallax-y",
          `${progress * (compact ? -22 : -58)}px`,
        );
        element.style.setProperty(
          "--parallax-rotate",
          `${progress * (compact ? 0.8 : 2.8)}deg`,
        );
        element.style.setProperty("--parallax-progress", String(progress));
      });
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    const stop = () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      observer = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
    };
    const reconcile = () => {
      stop();
      if (media?.matches) {
        site.dataset.motion = "reduced";
        revealAll();
        return;
      }
      if (!canAnimate) {
        site.dataset.motion = "static";
        revealAll();
        return;
      }
      if (paused) {
        site.dataset.motion = "paused";
        revealAll();
        return;
      }
      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              (entry.target as HTMLElement).dataset.revealed = "true";
              observer?.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.06, rootMargin: "0px 0px -6% 0px" },
      );
      reveals.forEach((element) => {
        if (element.dataset.revealed === "true") return;
        const bounds = element.getBoundingClientRect();
        element.dataset.revealed = String(
          bounds.top < window.innerHeight * 0.94,
        );
        if (element.dataset.revealed !== "true") observer?.observe(element);
      });
      site.dataset.motion = "active";
      window.addEventListener("scroll", schedule, { passive: true });
      window.addEventListener("resize", schedule, { passive: true });
      schedule();
    };

    if (canWatchPreference) media.addEventListener("change", reconcile);
    reconcile();
    return () => {
      stop();
      if (canWatchPreference) media.removeEventListener("change", reconcile);
    };
  }, [root, paused]);
}
