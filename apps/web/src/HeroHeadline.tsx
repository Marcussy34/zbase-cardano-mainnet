export default function HeroHeadline() {
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
          <span
            className="hero-word-finish"
            data-word="Unknown"
            aria-hidden="true"
          />
        </span>{" "}
        origins.
      </span>
    </h1>
  );
}
