import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  Globe2,
  LockKeyhole,
  Terminal,
} from "lucide-react";
import "./scroll-walkthrough.css";

type SessionRow = { label: string; value: string; secret?: boolean };
const steps: {
  name: string;
  exchange: string;
  text: string;
  localStatus: string;
  networkStatus: string;
  agent: SessionRow[];
  network: SessionRow[];
}[] = [
  {
    name: "Deposit",
    exchange: "ADA deposit",
    text: "An ordinary deposit funds the shared pool. Your agent keeps a private note of its balance.",
    localStatus: "Your note stays on your device.",
    networkStatus: "Many deposits. One shared pool.",
    agent: [
      { label: "Your wallet", value: "Ordinary ADA deposit" },
      { label: "A private note", value: "Created on your device" },
      { label: "Note secrets", value: "•••• •••• ••••", secret: true },
      { label: "Balance", value: "Recorded locally" },
    ],
    network: [
      { label: "Deposit", value: "ADA received" },
      { label: "Insert", value: "Commitment added to pool" },
      { label: "Funding", value: "Shared pool" },
      { label: "Public", value: "Deposit wallet + amount" },
    ],
  },
  {
    name: "Prove locally",
    exchange: "Proof + intent",
    text: "Your agent proves it can spend. The relayer receives a proof and an intent, without your note secrets.",
    localStatus: "Note secrets stay here.",
    networkStatus: "Only the permission to pay travels.",
    agent: [
      { label: "Private note", value: "Loaded on your machine" },
      { label: "Note secrets", value: "•••• •••• ••••", secret: true },
      { label: "Proof", value: "Generated locally" },
      { label: "Intent", value: "Authorized by your agent" },
    ],
    network: [
      { label: "Relayer", value: "Receives proof and intent" },
      { label: "Proof", value: "Permission to spend" },
      { label: "Intent", value: "Fixed payout details" },
      { label: "Note secrets", value: "Never received" },
    ],
  },
  {
    name: "Pay",
    exchange: "x402 payment",
    text: "The pool funds a one-time key with the price and fee. That key pays the seller through the standard x402 flow.",
    localStatus: "Payment complete. Back to work.",
    networkStatus: "A standard payment reaches the seller.",
    agent: [
      { label: "One-time key", value: "Ready for this payment" },
      { label: "Funding", value: "Received from the pool" },
      { label: "Seller payment", value: "Signed with the fresh key" },
      { label: "Resource", value: "Returned to your agent" },
    ],
    network: [
      { label: "Shared pool", value: "Funds a fresh address" },
      { label: "Funding amount", value: "Price + payment fee" },
      { label: "x402 seller", value: "Ordinary key payment" },
      { label: "Payment", value: "Confirmed on-chain" },
    ],
  },
];
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const PIN_TOP = 24;

function SessionTerminal({
  side,
  step,
}: {
  side: "agent" | "network";
  step: number;
}) {
  const local = side === "agent";
  const title = local ? "Your agent" : "The network";
  const scene = steps[step];
  return (
    <section className={`scw-terminal scw-terminal-${side}`} aria-label={title}>
      <div className="scw-window-bar" aria-hidden="true">
        <span className="scw-window-dots">
          <i />
          <i />
          <i />
        </span>
        <span>{local ? "agent.local" : "network.session"}</span>
        {local ? <LockKeyhole size={11} /> : <Globe2 size={11} />}
      </div>
      <div className="scw-terminal-title">
        {local ? (
          <Terminal size={19} strokeWidth={1.4} aria-hidden="true" />
        ) : (
          <Globe2 size={19} strokeWidth={1.4} aria-hidden="true" />
        )}
        <div>
          <h3>{title}</h3>
          <span>{local ? "Your machine" : "Relayer · pool · seller"}</span>
        </div>
        <span className="scw-terminal-badge">
          {local ? "PRIVATE" : "SHARED"}
        </span>
      </div>
      <div className="scw-session-path" aria-hidden="true">
        <span>~</span> / {scene.name.toLowerCase()} <i />
      </div>
      <ol className="scw-session-rows" key={step}>
        {scene[side].map((row, index) => (
          <li
            key={row.label}
            className={row.secret ? "scw-secret-row" : ""}
            style={
              {
                "--row-start": local ? index * 0.15 : 0.25 + index * 0.15,
              } as CSSProperties
            }
          >
            <span className="scw-line-number" aria-hidden="true">
              0{index + 1}
            </span>
            <div>
              <span className="scw-row-label">{row.label}</span>
              <span className="scw-row-value">
                {row.value}
                {row.secret && <LockKeyhole size={10} aria-hidden="true" />}
              </span>
            </div>
            <Check className="scw-row-check" size={12} aria-hidden="true" />
          </li>
        ))}
      </ol>
      <div className="scw-terminal-status">
        <span aria-hidden="true" />
        <span>{local ? scene.localStatus : scene.networkStatus}</span>
      </div>
    </section>
  );
}

export default function ScrollWalkthrough({
  paused = false,
}: {
  paused?: boolean;
}) {
  const section = useRef<HTMLElement>(null);
  const sticky = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState("static");
  const syncManual = useRef<() => void>(() => {});

  useEffect(() => {
    const element = section.current;
    const scene = sticky.current;
    if (!element || !scene) return;
    const complete = () => element.style.setProperty("--scene-progress", "1");
    complete();
    if (typeof window.matchMedia !== "function") {
      element.dataset.pinned = "false";
      return;
    }
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (
      typeof preference.addEventListener !== "function" ||
      typeof preference.removeEventListener !== "function"
    ) {
      element.dataset.pinned = "false";
      return;
    }
    let frame: number | null = null;
    let lastStage: number | null = null;
    let manual = false;
    let listening = false;
    let active = false;
    let pinned = false;
    let sceneHeight = 0;
    let measureNext = true;
    let shouldSelect = true;
    let observer: ResizeObserver | null = null;

    function measure() {
      sceneHeight = Math.ceil(scene!.getBoundingClientRect().height);
      pinned =
        sceneHeight > 0 && sceneHeight <= window.innerHeight - PIN_TOP * 2;
      element!.style.setProperty(
        "--walkthrough-height",
        `${sceneHeight + Math.max(window.innerHeight * 2.25, 1500)}px`,
      );
      element!.dataset.pinned = String(pinned);
      measureNext = false;
    }
    function readProgress() {
      if (!pinned) return 1;
      const rect = element!.getBoundingClientRect();
      return clamp(
        (PIN_TOP - rect.top) / Math.max(rect.height - sceneHeight, 1),
      );
    }
    const stageAt = (progress: number) => Math.min(2, Math.floor(progress * 3));
    syncManual.current = () => {
      lastStage = stageAt(readProgress());
      manual = true;
      complete();
    };
    function update() {
      frame = null;
      if (measureNext) measure();
      if (!pinned || !active) {
        complete();
        return;
      }
      const progress = readProgress();
      const stage = stageAt(progress);
      if ((shouldSelect || !manual) && stage !== lastStage) {
        manual = false;
        setStep(stage);
      }
      if (!manual)
        element!.style.setProperty(
          "--scene-progress",
          String(clamp(progress * 3 - stage)),
        );
      if (shouldSelect || !manual) lastStage = stage;
      shouldSelect = false;
    }
    function schedule(select: boolean) {
      shouldSelect ||= select;
      if (frame === null) frame = window.requestAnimationFrame(update);
    }
    const onScroll = () => schedule(true);
    const onResize = () => {
      measureNext = true;
      schedule(false);
    };
    function stop() {
      if (listening) {
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onResize);
      }
      listening = false;
      observer?.disconnect();
      observer = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
    }
    function reconcile() {
      stop();
      complete();
      active = false;
      pinned = false;
      if (preference.matches) {
        element!.dataset.pinned = "false";
        setMode("reduced");
        return;
      }
      if (
        typeof window.IntersectionObserver !== "function" ||
        typeof window.requestAnimationFrame !== "function" ||
        typeof window.cancelAnimationFrame !== "function"
      ) {
        element!.dataset.pinned = "false";
        setMode("static");
        return;
      }
      setMode(paused ? "paused" : "active");
      active = !paused;
      manual = false;
      lastStage = null;
      measure();
      if (active)
        window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onResize);
      listening = true;
      if (typeof window.ResizeObserver === "function") {
        observer = new window.ResizeObserver(onResize);
        observer.observe(scene!);
      }
      schedule(true);
    }
    preference.addEventListener("change", reconcile);
    reconcile();
    return () => {
      syncManual.current = () => {};
      stop();
      preference.removeEventListener("change", reconcile);
    };
  }, [paused]);

  return (
    <section
      ref={section}
      className="how-section section-wrap scroll-walkthrough"
      id="how-it-works"
      aria-labelledby="how-title"
      data-walkthrough-mode={mode}
      data-scene={step}
    >
      <div ref={sticky} className="scw-sticky">
        <div className="section-heading">
          <div>
            <span className="eyebrow">The planned flow</span>
            <h2 id="how-title">
              Two sides.
              <br />
              <span>One private payment.</span>
            </h2>
          </div>
          <p>
            Follow what stays with your agent.
            <br />
            And what goes out into the world.
          </p>
        </div>
        <div
          className="scw-panel"
          role="region"
          aria-label="Payment walkthrough"
          id="walkthrough-scene"
        >
          <div className="scw-scene-meta">
            <span className="scw-preview-label">
              <span />
              Illustrative session <i>·</i> In development
            </span>
            <span className="scw-scroll-hint" aria-hidden="true">
              Scroll to play <ArrowDown size={11} />
            </span>
            <span className="mono">0{step + 1} / 03</span>
          </div>
          <div className="scw-terminal-pair">
            <SessionTerminal side="agent" step={step} />
            <div className="scw-exchange" aria-hidden="true">
              <div className="scw-exchange-track">
                <span />
                <i />
                <ArrowRight size={13} />
              </div>
              <span className="scw-exchange-icon">
                <LockKeyhole size={14} strokeWidth={1.4} />
              </span>
            </div>
            <SessionTerminal side="network" step={step} />
          </div>
          <div className="scw-exchange-caption">
            <span aria-hidden="true">
              <ArrowRight size={12} />
            </span>
            <span>{steps[step].exchange}</span>
          </div>
          <p className="scw-caption">{steps[step].text}</p>
        </div>
        <div className="step-list">
          {steps.map((item, index) => (
            <button
              key={item.name}
              type="button"
              className={`step-button ${step === index ? "step-active" : ""}`}
              aria-pressed={step === index}
              aria-controls="walkthrough-scene"
              onClick={() => {
                syncManual.current();
                setStep(index);
              }}
            >
              <span className="step-number">0{index + 1}</span>
              <span>{item.name}</span>
              <ArrowUpRight size={17} aria-hidden="true" />
              <span className="scw-step-progress" aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
