import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowDown,
  ArrowRight,
  Check,
  Fingerprint,
  KeyRound,
  Layers3,
  Radio,
  ShoppingBag,
  Wallet,
} from "lucide-react";
import "./payment-orbit.css";

const path = [
  {
    name: "Wallet",
    icon: Wallet,
    label: "Start with an ordinary deposit",
    title: "Your funds enter. Your story stays yours.",
    description:
      "Deposit ADA through an ordinary Cardano transaction. Your agent keeps a private note for its balance.",
    signal: "ADA deposit",
    destination: "Shared pool",
    detail: "Private note held locally",
  },
  {
    name: "Shared pool",
    icon: Layers3,
    label: "A shared starting point",
    title: "One pool. Many possible origins.",
    description:
      "Funds join one shared pool. A proof shows that a payment comes from an approved deposit, without identifying it.",
    signal: "Approved deposits",
    destination: "Shared pool",
    detail: "Approved deposits. Private note ownership.",
  },
  {
    name: "Local proof",
    icon: Fingerprint,
    label: "Prove without exposing",
    title: "The proof travels. The secrets stay.",
    description:
      "Your agent creates a zero-knowledge proof locally. Note secrets stay on your machine in default mode.",
    signal: "Private note",
    destination: "Local proof",
    detail: "Generated on your machine",
  },
  {
    name: "Relayer",
    icon: Radio,
    label: "Only what the network needs",
    title: "Pass the proof. Keep the origin.",
    description:
      "The relayer receives a proof and a payment intent. It submits the pool transaction without receiving your note secrets.",
    signal: "Proof + intent",
    destination: "Relayer",
    detail: "No note secrets sent",
  },
  {
    name: "One-time key",
    icon: KeyRound,
    label: "A fresh address for the next step",
    title: "Give each payment a fresh start.",
    description:
      "The pool funds a one-time key with the seller’s price plus the next transaction’s fee. Your agent controls that key.",
    signal: "Price + fee",
    destination: "One-time key",
    detail: "Fresh key controlled by your agent",
  },
  {
    name: "x402 seller",
    icon: ShoppingBag,
    label: "Back to work",
    title: "Get the resource. Carry on.",
    description:
      "The one-time key makes a standard x402 payment to the seller. The seller sees a fresh address funded by the pool.",
    signal: "One-time key",
    destination: "x402 seller",
    detail: "Planned default payment path",
  },
];
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export default function PaymentOrbit({ paused = false }: { paused?: boolean }) {
  const section = useRef<HTMLElement>(null);
  const sticky = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState("static");
  const syncScrollStage = useRef<() => void>(() => {});

  useEffect(() => {
    const element = section.current;
    if (!element || typeof window.matchMedia !== "function") return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (
      typeof preference.addEventListener !== "function" ||
      typeof preference.removeEventListener !== "function"
    )
      return;
    let frame: number | null = null;
    let lastStage: number | null = null;
    let shouldSelect = true;
    let listening = false;
    let observer: ResizeObserver | null = null;

    function measureScene() {
      const height = sticky.current?.getBoundingClientRect().height ?? 0;
      const fits =
        window.innerWidth >= 900 &&
        height > 0 &&
        height <= window.innerHeight - 104;
      if (element) {
        element.dataset.orbitPinned = String(fits);
        element.style.setProperty("--orbit-scene-height", `${height}px`);
      }
      return { height, fits };
    }

    function readProgress() {
      if (!element) return 0;
      const scene = measureScene();
      const rect = element.getBoundingClientRect();
      const viewport = window.innerHeight;
      const start = scene.fits ? 80 : viewport * 0.5;
      const travel = scene.fits
        ? Math.max(rect.height - scene.height, 1)
        : Math.max(rect.height * 0.7, 1);
      return clamp((start - rect.top) / travel);
    }
    const stageAt = (progress: number) =>
      Math.min(path.length - 1, Math.floor(progress * path.length));
    syncScrollStage.current = () => {
      lastStage = stageAt(readProgress());
    };
    function update() {
      frame = null;
      if (!element) return;
      const progress = readProgress();
      const stage = stageAt(progress);
      element.style.setProperty("--path-progress", String(progress));
      if (shouldSelect && stage !== lastStage) setSelected(stage);
      lastStage = stage;
      shouldSelect = false;
    }
    function schedule(select: boolean) {
      shouldSelect ||= select;
      if (frame === null) frame = window.requestAnimationFrame(update);
    }
    const onScroll = () => schedule(true);
    const onResize = () => schedule(false);
    function stop() {
      if (listening) {
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onResize);
        listening = false;
      }
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      observer?.disconnect();
      observer = null;
    }
    function reconcile() {
      stop();
      if (preference.matches) {
        element!.dataset.orbitPinned = "false";
        setMode("reduced");
        return;
      }
      if (paused) {
        setMode("paused");
        return;
      }
      if (
        typeof window.IntersectionObserver !== "function" ||
        typeof window.requestAnimationFrame !== "function" ||
        typeof window.cancelAnimationFrame !== "function"
      ) {
        element!.dataset.orbitPinned = "false";
        setMode("static");
        return;
      }
      setMode("active");
      lastStage = null;
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onResize);
      if (typeof window.ResizeObserver === "function" && sticky.current) {
        observer = new ResizeObserver(onResize);
        observer.observe(sticky.current);
      }
      listening = true;
      schedule(true);
    }
    preference.addEventListener("change", reconcile);
    reconcile();
    return () => {
      syncScrollStage.current = () => {};
      stop();
      preference.removeEventListener("change", reconcile);
    };
  }, [paused]);

  const active = path[selected];
  const ActiveIcon = active.icon;
  return (
    <section
      ref={section}
      id="payment-path"
      className="payment-path"
      aria-labelledby="payment-path-heading"
      data-orbit-mode={mode}
    >
      <div ref={sticky} className="payment-path-sticky section-wrap">
        <header className="payment-path-heading">
          <span className="eyebrow">THE PAYMENT PATH</span>
          <h2 id="payment-path-heading">One agent. A more private path.</h2>
          <p>
            From your wallet to the tools your agent uses.
            <br />A shared pool puts space between them.
          </p>
          <a className="path-docs-link" href="/docs/?topic=spec">
            Explore the design <ArrowRight size={15} aria-hidden="true" />
          </a>
        </header>
        <div className="payment-path-stage">
          <div
            id="payment-path-detail"
            className="payment-path-card"
            role="region"
            aria-label="Payment path detail"
          >
            <div className="path-card-top">
              <span>Design preview · In development</span>
              <span className="path-count">
                0{selected + 1}
                <span> / 06</span>
              </span>
            </div>
            <div className="path-card-content" key={selected}>
              <div className="path-card-label">
                <ActiveIcon size={16} aria-hidden="true" />
                {active.label}
              </div>
              <h3>{active.title}</h3>
              <p>{active.description}</p>
              <div className="path-card-transfer">
                <span>{active.signal}</span>
                <ArrowRight size={14} aria-hidden="true" />
                <span>{active.destination}</span>
              </div>
              <div className="path-card-note">
                <Check size={13} aria-hidden="true" />
                {active.detail}
              </div>
            </div>
          </div>
          <div
            className="payment-path-orbit"
            role="group"
            aria-label="Explore the six payment steps"
          >
            <div className="path-orbit-ring" aria-hidden="true" />
            <div className="path-orbit-center" aria-hidden="true">
              <span className="path-portrait" />
              <span className="path-agent-label">YOUR AGENT</span>
            </div>
            {path.map(({ name, icon: Icon }, index) => (
              <button
                key={name}
                type="button"
                className="path-node"
                aria-label={name}
                aria-pressed={selected === index}
                aria-controls="payment-path-detail"
                onClick={() => {
                  syncScrollStage.current();
                  setSelected(index);
                }}
                style={
                  {
                    "--node-angle": `${index * 60 - 90}deg`,
                    "--node-index": index,
                  } as CSSProperties
                }
              >
                <span className="path-node-icon">
                  <Icon size={23} strokeWidth={1.5} aria-hidden="true" />
                </span>
                <span className="path-node-label" aria-hidden="true">
                  {name}
                </span>
              </button>
            ))}
          </div>
        </div>
        <p className="path-boundary">
          Amounts, recipients and timing are visible on-chain.
          <br className="path-mobile-break" /> Privacy also depends on the
          approved deposit set and payment patterns.
        </p>
        <div className="path-scroll-guide" aria-hidden="true">
          <span>Scroll to follow the path</span>
          <span className="path-scroll-track" />
          <ArrowDown size={12} />
        </div>
      </div>
    </section>
  );
}
