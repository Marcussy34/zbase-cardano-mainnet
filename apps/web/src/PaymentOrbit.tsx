import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowDown,
  ArrowRight,
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
    title: "Start with ADA.",
    description:
      "An ordinary deposit creates a private note kept on your device.",
    signal: "ADA deposit",
    destination: "Shared pool",
  },
  {
    name: "Shared pool",
    icon: Layers3,
    title: "One shared pool.",
    description:
      "Payments prove an approved deposit without revealing which one.",
    signal: "Approved deposits",
    destination: "Shared pool",
  },
  {
    name: "Local proof",
    icon: Fingerprint,
    title: "Prove it locally.",
    description:
      "Your agent proves locally; note secrets stay on your machine.",
    signal: "Private note",
    destination: "Local proof",
  },
  {
    name: "Relayer",
    icon: Radio,
    title: "Pass the proof.",
    description:
      "The relayer gets proof and intent, never note secrets.",
    signal: "Proof + intent",
    destination: "Relayer",
  },
  {
    name: "One-time key",
    icon: KeyRound,
    title: "A fresh key.",
    description:
      "The pool funds your agent’s one-time key with price plus fee.",
    signal: "Price + fee",
    destination: "One-time key",
  },
  {
    name: "x402 seller",
    icon: ShoppingBag,
    title: "Back to work.",
    description:
      "Your one-time key makes a standard x402 payment to the seller.",
    signal: "One-time key",
    destination: "x402 seller",
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
          <span className="eyebrow">Payment path</span>
          <h2 id="payment-path-heading">From wallet to work.</h2>
        </header>
        <div className="payment-path-stage">
          <div
            id="payment-path-detail"
            className="payment-path-card"
            role="region"
            aria-label="Payment path detail"
          >
            <div className="path-card-top">
              <span>Design preview</span>
              <span className="path-count">
                0{selected + 1}
                <span> / 06</span>
              </span>
            </div>
            <div className="path-card-content" key={selected}>
              <h3>{active.title}</h3>
              <p>{active.description}</p>
              <div className="path-card-transfer">
                <span>{active.signal}</span>
                <ArrowRight size={14} aria-hidden="true" />
                <span>{active.destination}</span>
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
          Amounts, recipients and timing stay public.
          <br className="path-mobile-break" /> Privacy depends on approved
          deposits and payment patterns.
        </p>
        <div className="path-scroll-guide" aria-hidden="true">
          <span>Scroll to explore</span>
          <span className="path-scroll-track" />
          <ArrowDown size={12} />
        </div>
      </div>
    </section>
  );
}
