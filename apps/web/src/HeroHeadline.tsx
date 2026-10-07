import { useId } from "react";

export default function HeroHeadline() {
  const smokeFilter = useId();
  return (
    <h1
      id="hero-title"
      className="hero-headline"
      aria-label="Private payments. Unknown origins."
    >
      <span className="hero-headline-line" aria-hidden="true">
        Private payments.
      </span>
      <span
        className="hero-headline-line hero-headline-second"
        aria-hidden="true"
      >
        <span className="hero-unknown-word">
          <span className="hero-word-fill">Unknown</span>
          <span className="hero-word-smoke" aria-hidden="true">
            <svg className="hero-smoke-defs" width="0" height="0" focusable="false">
              <defs>
                <filter id={smokeFilter} x="-25%" y="-50%" width="150%" height="200%" colorInterpolationFilters="sRGB">
                  <feTurbulence type="fractalNoise" baseFrequency=".012 .028" numOctaves="3" seed="8" result="noise" />
                  <feDisplacementMap in="SourceGraphic" in2="noise" scale="34" xChannelSelector="R" yChannelSelector="G" />
                  <feGaussianBlur stdDeviation="3" />
                </filter>
              </defs>
            </svg>
            <span className="hero-smoke-clouds" style={{ filter: `url(#${smokeFilter})` }}>
              <span className="hero-smoke-wisp hero-smoke-wisp-one" />
              <span className="hero-smoke-wisp hero-smoke-wisp-two" />
              <span className="hero-smoke-wisp hero-smoke-wisp-three" />
            </span>
          </span>
        </span>{" "}
        origins.
      </span>
    </h1>
  );
}
