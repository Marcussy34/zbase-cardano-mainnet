import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ProofIcon,
  KeyIcon,
  PoolIcon,
  RelayerIcon,
  SellerIcon,
  WalletIcon,
  ZBaseMark,
} from "./BrandIcons";
import "./payment-orbit.css";

const path = [
  {
    name: "Wallet",
    icon: WalletIcon,
    title: "Start with ADA.",
    description:
      "An ordinary deposit creates a private note kept on your device.",
    signal: "ADA deposit",
    destination: "Shared pool",
  },
  {
    name: "Shared pool",
    icon: PoolIcon,
    title: "One shared pool.",
    description:
      "Payments prove an approved deposit without revealing which one.",
    signal: "Approved deposits",
    destination: "Shared pool",
  },
  {
    name: "Local proof",
    icon: ProofIcon,
    title: "Prove it locally.",
    description:
      "Your agent proves locally; note secrets stay on your machine.",
    signal: "Private note",
    destination: "Local proof",
  },
  {
    name: "Relayer",
    icon: RelayerIcon,
    title: "Pass the proof.",
    description:
      "The relayer gets proof and intent, never note secrets.",
    signal: "Proof + intent",
    destination: "Relayer",
  },
  {
    name: "One-time key",
    icon: KeyIcon,
    title: "A fresh key.",
    description:
      "The pool funds your agent’s one-time key with price plus fee.",
    signal: "Price + fee",
    destination: "One-time key",
  },
  {
    name: "x402 seller",
    icon: SellerIcon,
    title: "Back to work.",
    description:
      "Your one-time key makes a standard x402 payment to the seller.",
    signal: "One-time key",
    destination: "x402 seller",
  },
];
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const portraits = [1, 2, 3, 4, 6, 8];
const phaseAt = (progress: number) => {
  if (progress < 0.1) return "intro";
  if (progress < 0.73) return "steps";
  if (progress < 0.89) return "transform";
  return "complete";
};
const stageAt = (progress: number) =>
  Math.max(0, Math.min(path.length - 1, Math.floor((progress - 0.1 + 1e-8) / 0.1)));
const stageKey = (progress: number) => `${phaseAt(progress)}-${stageAt(progress)}`;
const timelineAt = (progress: number) => ({
  phase: phaseAt(progress),
  revealed: path.filter((_, index) => progress + 1e-8 >= 0.1 + index * 0.1).length,
  portraits: progress >= 0.81 ? path.length : 0,
  centerFace: progress >= 0.81 ? "logo" : "agent",
});

export default function PaymentOrbit({ paused = false }: { paused?: boolean }) {
  const section = useRef<HTMLElement>(null);
  const sticky = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState("static");
  const [manual, setManual] = useState(false);
  const [timeline, setTimeline] = useState(() => timelineAt(0));
  const syncScrollStage = useRef<() => void>(() => {});

  useEffect(() => {
    const element = section.current;
    if (!element || typeof window.matchMedia !== "function") return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (
      typeof preference.addEventListener !== "function" ||
      typeof preference.removeEventListener !== "function"
    ) return;
    let frame: number | null = null;
    let lastStage: string | null = null;
    let shouldSelect = true;
    let listening = false;
    let fits = false;
    let observer: ResizeObserver | null = null;

    function measureScene() {
      const height = sticky.current?.getBoundingClientRect().height ?? 0;
      fits = window.innerWidth >= 900 && height > 0 && height <= window.innerHeight - 104;
      element!.dataset.orbitPinned = String(fits);
      element!.style.setProperty("--orbit-scene-height", `${height}px`);
      return height;
    }
    function readProgress() {
      const height = measureScene();
      const rect = element!.getBoundingClientRect();
      return clamp((80 - rect.top) / Math.max(rect.height - height, 1));
    }
    syncScrollStage.current = () => {
      lastStage = stageKey(readProgress());
    };
    function update() {
      frame = null;
      if (paused) {
        measureScene();
        return;
      }
      const progress = readProgress();
      setMode(fits ? "active" : "static");
      if (!fits) return;
      const stage = stageKey(progress);
      element!.style.setProperty("--path-progress", String(progress));
      element!.style.setProperty("--transform-progress", String(clamp((progress - 0.73) / 0.16)));
      element!.style.setProperty("--path-turn", String(clamp((progress - 0.73) / 0.27) * 90));
      const next = timelineAt(progress);
      setTimeline((previous) =>
        previous.phase === next.phase && previous.revealed === next.revealed &&
        previous.portraits === next.portraits && previous.centerFace === next.centerFace
          ? previous : next,
      );
      if (shouldSelect && stage !== lastStage) {
        setSelected(stageAt(progress));
        setManual(false);
      }
      lastStage = stage;
      shouldSelect = false;
    }
    function schedule(select: boolean) {
      shouldSelect ||= select;
      if (frame === null) frame = window.requestAnimationFrame(update);
    }
    const onScroll = () => { if (fits) schedule(true); };
    const onResize = () => {
      if (paused) measureScene();
      else schedule(false);
    };
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
        measureScene();
        window.addEventListener("resize", onResize);
        if (typeof window.ResizeObserver === "function" && sticky.current) {
          observer = new ResizeObserver(onResize);
          observer.observe(sticky.current);
        }
        listening = true;
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
  const automatic = mode === "active" && !manual;
  const phase = automatic ? timeline.phase : "steps";
  const showDetail = phase === "steps";
  const select = (index: number) => {
    syncScrollStage.current();
    setManual(true);
    setSelected(index);
  };
  return (
    <section
      ref={section}
      id="payment-path"
      className="payment-path"
      aria-labelledby="payment-path-heading"
      data-orbit-mode={mode}
      data-orbit-phase={phase}
      data-orbit-manual={manual}
    >
      <div ref={sticky} className="payment-path-sticky section-wrap">
        <header className="payment-path-heading">
          <span className="eyebrow">Payment path · Design preview</span>
          <h2 id="payment-path-heading">From wallet to work.</h2>
        </header>
        <div
          className="payment-path-stage"
          data-card-side={selected < 3 ? "right" : "left"}
          style={{ "--active-angle": `${selected * 60 - 90}deg` } as CSSProperties}
        >
          <div
            className="payment-path-orbit"
            role="group"
            aria-label="Explore the six payment steps"
          >
            <div className="path-orbit-center" data-face={automatic ? timeline.centerFace : "agent"} aria-hidden="true">
              <div className="path-center-flipper">
                <span className="path-portrait path-center-front" />
                <span className="path-center-back">
                  <ZBaseMark />
                </span>
              </div>
              <span className="path-agent-label">
                <span className="path-agent-name">YOUR AGENT</span>
                <span className="path-pool-name">zBase</span>
              </span>
            </div>
            <div className="path-orbit-turntable">
              <div className="path-orbit-ring" aria-hidden="true" />
              {path.map(({ name, icon: Icon }, index) => (
                <button
                  key={name}
                  type="button"
                  className="path-node"
                  aria-label={name}
                  aria-pressed={selected === index}
                  aria-controls="payment-path-detail"
                  data-revealed={!automatic || index < timeline.revealed}
                  data-portrait={automatic && index < timeline.portraits}
                  onFocus={() => select(index)}
                  onClick={() => select(index)}
                  style={{
                    "--node-angle": `${index * 60 - 90}deg`,
                    "--node-index": index,
                    "--portrait-x": `${(portraits[index] % 3) * 50}%`,
                    "--portrait-y": `${Math.floor(portraits[index] / 3) * 50}%`,
                  } as CSSProperties}
                >
                  <span className="path-node-appearance">
                    <span className="path-node-flipper">
                      <span className="path-node-icon">
                        <Icon size={42} aria-hidden="true" />
                      </span>
                      <span className="path-node-portrait" aria-hidden="true" />
                    </span>
                    <span className="path-node-label" aria-hidden="true">{name}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div
            id="payment-path-detail"
            className="payment-path-card"
            role="region"
            aria-label="Payment path detail"
            aria-hidden={!showDetail}
            data-visible={showDetail}
          >
            <div className="path-card-content" key={selected}>
              <div className="path-card-top">
                <span>{active.name}</span>
                <span className="path-count">0{selected + 1}<span> / 06</span></span>
              </div>
              <h3>{active.title}</h3>
              <p>{active.description}</p>
              <div className="path-card-transfer">
                <span>{active.signal}</span>
                <ArrowRightIcon size={13} aria-hidden="true" />
                <span>{active.destination}</span>
              </div>
            </div>
          </div>
          <p className="path-finale" aria-hidden={phase !== "transform" && phase !== "complete"}>
            One pool. <span>Many private stories.</span>
          </p>
        </div>
        <p className="path-boundary">
          Amounts, recipients and timing stay public.
          <br className="path-mobile-break" /> Privacy depends on approved
          deposits and payment patterns.
        </p>
        <div className="path-scroll-guide" aria-hidden="true">
          <span>{phase === "complete" ? "Keep exploring" : "Scroll to explore"}</span>
          <span className="path-scroll-track" />
          <ArrowDownIcon size={12} />
        </div>
      </div>
    </section>
  );
}
