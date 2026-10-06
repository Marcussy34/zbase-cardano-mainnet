import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useLandingMotion } from "./useLandingMotion";
import HeroHeadline from "./HeroHeadline";
import PaymentOrbit from "./PaymentOrbit";
import ScrollWalkthrough from "./ScrollWalkthrough";
import PrivacySection from "./PrivacySection";
import {
  ArrowDown,
  ArrowUpRight,
  ChevronDown,
  Fingerprint,
  Menu,
  Pause,
  Play,
  ShieldCheck,
  X,
} from "lucide-react";

const DOCS = "/docs/";
const portraits = [0, 1, 5, 8, 3, 6, 4, 7, 2, 5, 1, 8];
const scatterPositions = [
  [0, -400],
  [0.28, -320],
  [0.43, -175],
  [0.46, 10],
  [0.44, 190],
  [0.3, 365],
  [0, 420],
  [-0.28, 380],
  [-0.44, 220],
  [-0.46, 15],
  [-0.43, -170],
  [-0.28, -360],
];
const introLines = [
  "Your agent has work to do.",
  "Its entire treasury doesn’t",
  "need to come with it.",
];
const introWords = introLines.join(" ").split(" ");

function Mark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M5 7h22l-6 6H5V7Zm6 12h16v6H5l6-6Z" fill="currentColor" />
      <path d="m19 13-6 6H5l6-6h8Z" fill="currentColor" opacity=".45" />
    </svg>
  );
}

function Portrait({
  index,
  className = "",
  style,
}: {
  index: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      className={`character ${className}`}
      style={{
        backgroundPosition: `${(index % 3) * 50}% ${Math.floor(index / 3) * 50}%`,
        ...style,
      }}
    />
  );
}

function ReadDocs() {
  return (
    <a href={DOCS} className="button button-light">
      Read docs <ArrowUpRight size={17} aria-hidden="true" />
    </a>
  );
}

const questions = [
  {
    question: "Is zBase Cardano live?",
    answer:
      "The protocol runs on the Preprod test network. Mainnet is not live. The next step is a capped ADA canary using team funds. An external audit is required before caps are lifted.",
  },
  {
    question: "What does “private” mean here?",
    answer:
      "The design aims to break the on-chain link between your funding wallet and your payments. Amounts, recipients, and timing remain public. Privacy also depends on the size of the approved deposit set and your payment patterns.",
  },
  {
    question: "Do my secrets leave my machine?",
    answer:
      "In the default design, your agent generates proofs locally. The relayer receives a proof and a payment intent. It does not receive your note secrets.",
  },
  {
    question: "What can my agent pay for?",
    answer:
      "The first release targets ADA payments through x402. Private funding for Masumi escrows, payment channels, and tabs is planned for later releases. It is designed for meaningful funding flows, not tiny payments settled one by one on-chain.",
  },
  {
    question: "Can I take my funds out?",
    answer:
      "The design includes a public exit for the original depositor, even when their deposit is not approved for private payments. A public exit reveals the link to that depositor. Before the pool absorbs a deposit, its owner can refund it.",
  },
];

export default function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [faq, setFaq] = useState<number | null>(null);
  const site = useRef<HTMLDivElement>(null);
  useLandingMotion(site, paused);
  const menuButton = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (!header.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
    };
  }, [menuOpen]);

  return (
    <div ref={site} className={paused ? "site motion-paused" : "site"}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header" ref={header}>
        <a className="brand" href="/" aria-label="zBase Cardano home">
          <Mark />
          <span>
            zBase<span className="brand-network">Cardano</span>
          </span>
        </a>
        <div className="header-actions">
          <a className="header-docs" href={DOCS}>
            Read docs <ArrowUpRight size={15} aria-hidden="true" />
          </a>
          <button
            ref={menuButton}
            className="menu-toggle"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="site-menu"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <X size={21} /> : <Menu size={21} />}
          </button>
        </div>
        {menuOpen && (
          <nav className="menu-panel" id="site-menu" aria-label="Menu">
            <span className="eyebrow">Explore zBase</span>
            {[
              ["How it works", "#how-it-works"],
              ["Privacy by design", "#privacy"],
              ["The roadmap", "#roadmap"],
              ["Questions", "#questions"],
              ["Documentation", DOCS],
            ].map(([label, href]) => (
              <a key={label} href={href} onClick={() => setMenuOpen(false)}>
                {label}
                <ArrowUpRight size={17} aria-hidden="true" />
              </a>
            ))}
            <span className="menu-status">
              <i /> In development
            </span>
          </nav>
        )}
      </header>
      <button
        className="motion-toggle"
        aria-label={paused ? "Play motion" : "Pause motion"}
        aria-pressed={paused}
        onClick={() => setPaused(!paused)}
      >
        {paused ? <Play size={13} /> : <Pause size={13} />}
        <span>{paused ? "Play motion" : "Pause motion"}</span>
      </button>
      <main id="main">
        <div className="opening-story" data-motion-scene>
          <div className="opening-art" aria-hidden="true">
            <div className="orbit-viewport">
              <div className="orbit-stage" aria-hidden="true">
                {portraits.map((portrait, i) => (
                  <div
                    className="orbit-position"
                    key={i}
                    style={
                      {
                        "--angle": `${i * 30 - 90}deg`,
                        "--scatter-x": `calc(${scatterPositions[i][0]} * var(--scatter-width, 100vw))`,
                        "--scatter-y": `${scatterPositions[i][1]}px`,
                        "--scatter-tilt": `${(i % 2 ? 1 : -1) * (8 + (i % 4) * 3)}deg`,
                        "--depth": [0.62, 0.82, 1.12][i % 3],
                        "--size": `${i % 3 === 0 ? 100 : i % 3 === 1 ? 86 : 94}px`,
                      } as CSSProperties
                    }
                  >
                    <Portrait index={portrait} className="orbit-character" />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <section
            className="hero"
            data-motion-hero
            aria-labelledby="hero-title"
          >
            <div className="hero-copy">
              <div className="release-status">
                <span /> In development <i /> ADA first
              </div>
              <HeroHeadline />
              <p>
                A private funding rail for AI agents.
                <br />
                Built on Cardano. Designed to keep you private.
              </p>
              <ReadDocs />
            </div>
            <div className="hero-foot">
              <div className="foundation">
                <span>Built around</span>
                <b>
                  <span className="cardano-glyph" aria-hidden="true">
                    ⠿
                  </span>{" "}
                  Cardano
                </b>
                <span className="foundation-divider" />
                <b className="x402-wordmark">x402</b>
                <span className="foundation-divider" />
                <b className="zk-wordmark">
                  <ShieldCheck size={18} aria-hidden="true" /> Zero knowledge
                </b>
              </div>
              <a
                className="scroll-cue"
                href="#idea"
                aria-label="Discover zBase"
              >
                <ArrowDown size={17} />
              </a>
            </div>
          </section>
          <section className="intro section-wrap" id="idea">
            <span className="eyebrow">A little less public.</span>
            <h2 className="word-reveal" data-motion-words>
              {introLines.map((line, lineIndex) => (
                <Fragment key={line}>
                  {lineIndex > 0 && (
                    <br
                      className={lineIndex === 2 ? "desktop-break" : undefined}
                    />
                  )}
                  {line.split(" ").map((word, wordIndex) => {
                    const index =
                      introLines
                        .slice(0, lineIndex)
                        .join(" ")
                        .split(" ")
                        .filter(Boolean).length + wordIndex;
                    return (
                      <Fragment key={wordIndex}>
                        <span
                          className="scroll-word"
                          style={
                            {
                              "--word-start":
                                (index / introWords.length) * 0.85,
                            } as CSSProperties
                          }
                        >
                          {word}
                        </span>{" "}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
            </h2>
            <p>
              zBase Cardano is being built to separate the wallet that funds
              your agent from the payments it makes. A shared pool. A local
              proof. A little more privacy.
            </p>
            <div className="intro-rule">
              <span />
              <Fingerprint size={25} aria-hidden="true" />
              <span />
            </div>
          </section>
        </div>
        <ScrollWalkthrough paused={paused} />
        <PrivacySection />
        <PaymentOrbit paused={paused} />
        <section
          className="roadmap-section section-wrap"
          id="roadmap"
          aria-labelledby="roadmap-title"
        >
          <div className="section-heading" data-reveal>
            <div>
              <span className="eyebrow">Built carefully. In the open.</span>
              <h2 id="roadmap-title">
                Small steps.
                <br />
                <span>Long-term thinking.</span>
              </h2>
            </div>
            <a className="text-link" href="/docs/?topic=plan">
              Explore the build plan <ArrowUpRight size={16} />
            </a>
          </div>
          <div className="roadmap-grid">
            <article className="roadmap-item" data-reveal>
              <div className="roadmap-top">
                <span className="mono">01 / M0</span>
                <span className="roadmap-tag">Tested on Preprod</span>
              </div>
              <div className="roadmap-track">
                <span />
              </div>
              <h3>ADA first.</h3>
              <p>
                Deposits, local proofs, private x402 payments, and public exits
                run on Preprod. Mainnet is not live. A capped canary with team
                funds is next.
              </p>
              <span className="roadmap-bottom">Prove the foundations.</span>
            </article>
            <article className="roadmap-item" data-reveal>
              <div className="roadmap-top">
                <span className="mono">02 / M1</span>
                <span className="roadmap-tag muted">Planned</span>
              </div>
              <div className="roadmap-track">
                <span />
              </div>
              <h3>Open the circle.</h3>
              <p>
                A guarded alpha for invited users. Private escrow funding, more
                payment modes, and a public status page.
              </p>
              <span className="roadmap-bottom">Grow with intention.</span>
            </article>
            <article className="roadmap-item" data-reveal>
              <div className="roadmap-top">
                <span className="mono">03 / M2</span>
                <span className="roadmap-tag muted">Planned</span>
              </div>
              <div className="roadmap-track">
                <span />
              </div>
              <h3>More possibilities.</h3>
              <p>
                A public beta with stablecoin pools. Broader access follows an
                external audit and legal review.
              </p>
              <span className="roadmap-bottom">Build toward wider access.</span>
            </article>
          </div>
        </section>
        <section
          className="faq-section section-wrap"
          id="questions"
          aria-labelledby="faq-title"
        >
          <div>
            <span className="eyebrow">Good questions.</span>
            <h2 id="faq-title">
              A little more
              <br />
              <span>clarity.</span>
            </h2>
            <a className="text-link" href={DOCS}>
              Go deeper in the docs <ArrowUpRight size={16} />
            </a>
          </div>
          <div className="faq-list" data-reveal>
            {questions.map((item, i) => (
              <div
                className={`faq-item ${faq === i ? "faq-open" : ""}`}
                key={item.question}
              >
                <h3>
                  <button
                    aria-expanded={faq === i}
                    aria-controls={`answer-${i}`}
                    onClick={() => setFaq(faq === i ? null : i)}
                  >
                    {item.question}
                    <ChevronDown size={18} aria-hidden="true" />
                  </button>
                </h3>
                <div
                  id={`answer-${i}`}
                  className="faq-answer"
                  hidden={faq !== i}
                >
                  <p>{item.answer}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
      <footer className="site-footer footer-redesign">
        <section
          className="footer-invitation"
          aria-labelledby="footer-invitation-title"
        >
          <div className="footer-landscape" data-parallax aria-hidden="true">
            <img
              src="/images/privacy-horizon.jpg"
              alt=""
              width="1983"
              height="793"
              loading="lazy"
            />
          </div>
          <div className="footer-invitation-copy" data-reveal>
            <span className="eyebrow">For agents. For their humans.</span>
            <h2 id="footer-invitation-title">
              Move <em>freely.</em>
            </h2>
            <p>A little less public. A little more yours.</p>
            <ReadDocs />
          </div>
        </section>
        <div className="footer-container section-wrap">
          <div className="footer-top">
            <div className="footer-about">
              <a href="/" className="brand" aria-label="zBase Cardano home">
                <Mark />
                <span>
                  zBase<span className="brand-network">Cardano</span>
                </span>
              </a>
              <p>
                A private funding rail for AI agents.
                <br />
                Built on Cardano. Designed for you.
              </p>
              <span className="footer-signature">
                <Fingerprint size={16} aria-hidden="true" /> Privacy is a choice
                worth building for.
              </span>
            </div>
            <nav aria-label="Footer explore">
              <h3>Explore</h3>
              <a href="#how-it-works">How it works</a>
              <a href="#payment-path">The payment path</a>
              <a href="#privacy">Privacy by design</a>
              <a href="#roadmap">Roadmap</a>
              <a href="#questions">Questions</a>
            </nav>
            <nav aria-label="Footer documentation">
              <h3>Documentation</h3>
              <a href={DOCS}>Overview</a>
              <a href="/docs/?topic=spec">Specification</a>
              <a href="/docs/?topic=plan">Build plan</a>
            </nav>
            <nav aria-label="Footer project">
              <h3>Project</h3>
              <a
                href="https://github.com/Marcussy34/zbase-cardano-mainnet"
                target="_blank"
                rel="noreferrer"
              >
                GitHub <ArrowUpRight size={13} />
              </a>
              <a href="/docs/?topic=spec#13-privacy">Privacy model</a>
              <a href="/docs/?topic=spec#12-security">Security</a>
            </nav>
          </div>
          <div className="footer-wordmark" aria-hidden="true" data-reveal>
            <span>zBase</span>
            <span className="footer-wordmark-network">Cardano</span>
          </div>
          <div className="footer-bottom">
            <span>© 2026 zBase Cardano</span>
            <span>Built in the open. Private by design.</span>
            <span className="footer-status">
              <i /> In development · ADA first
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
