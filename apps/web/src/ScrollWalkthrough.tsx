import { useEffect, useId, useRef } from "react";
import SoffitBackdrop from "./SoffitBackdrop";
import {
  KeyIcon,
  LockIcon,
  PoolIcon,
  RelayerIcon,
  SellerIcon,
  WalletIcon,
  type BrandIcon,
} from "./BrandIcons";
import "./scroll-walkthrough.css";

// The spoken description walks the real flow in order, the same order the packet loop plays.
const description = "Your wallet deposits into one shared pool and can withdraw from it at any time. Your agent asks the x402 seller for a price, checks its private balance, gets a fee quote from the relayer, and proves on your device: note secrets stay local. Only the proof goes to the relayer. The relayer submits the proof to the shared pool, and the pool pays out to a one-time key with no link to your wallet. The one-time key pays the x402 seller, and the seller delivers to your agent. The pool keeps the change private.";

type FlowNodeProps = { name: string; label: string; note: string; icon?: BrandIcon };

function FlowNode({ name, label, note, icon: Icon }: FlowNodeProps) {
  return (
    <div className={`overview-node overview-node-${name}`}>
      <span className="overview-symbol">
        {Icon ? <Icon /> : <span className="overview-agent-portrait" />}
      </span>
      <strong>{label}</strong>
      {/* The agent's note keeps the lock: its secrets never leave the device. */}
      <small>{name === "agent" && <LockIcon size={10} />}{note}</small>
    </div>
  );
}

// Solid routes are on-chain transactions, dashed routes are web requests.
// Lavender marks every route with no link to the wallet. Mint is the agent's talk with the seller.
type Tone = "neutral" | "lavender" | "mint";
type Leg = { name: string; reverse?: boolean };
type Route = { name: string; kind: "chain" | "web"; tone: Tone; twoWay?: boolean; legs: Leg[]; desktop: string; mobile: string };

const routes: Route[] = [
  { name: "deposit", kind: "chain", tone: "neutral", legs: [{ name: "deposit" }], desktop: "M214 72H446", mobile: "M238 212V342" },
  { name: "withdraw", kind: "chain", tone: "neutral", legs: [{ name: "withdraw" }], desktop: "M446 96H214", mobile: "M218 342V212" },
  { name: "payout", kind: "chain", tone: "lavender", legs: [{ name: "payout" }], desktop: "M554 84H786", mobile: "M228 504V632" },
  { name: "pay", kind: "chain", tone: "lavender", legs: [{ name: "pay" }], desktop: "M840 200V260", mobile: "M186 680H132" },
  { name: "proof", kind: "web", tone: "lavender", legs: [{ name: "proof" }], desktop: "M214 310H446", mobile: "M90 212V342" },
  { name: "submit", kind: "chain", tone: "lavender", legs: [{ name: "submit" }], desktop: "M500 260V200", mobile: "M132 390H186" },
  // Drawn from the agent to the seller. The price quote and the delivery travel back along it.
  { name: "seller", kind: "web", tone: "mint", twoWay: true, legs: [{ name: "ask" }, { name: "quote", reverse: true }, { name: "deliver", reverse: true }], desktop: "M160 426V462H840V426", mobile: "M48 100H14V680H48" },
];
const tones: Tone[] = ["neutral", "lavender", "mint"];

// Short labels next to the routes. Positions live in the stylesheet, one set per layout.
const labels = [
  ["deposit", "Deposit"],
  ["withdraw", "Withdraw"],
  ["payout", "Pays out"],
  ["unlinkable", "unlinkable"],
  ["pay", "Pays the seller"],
  ["fee", "Fee quote"],
  ["proof", "Proof"],
  ["submit", "Submits the proof"],
  ["ask", "Agent asks, seller quotes a price"],
  ["deliver", "Seller is paid and delivers"],
] as const;

function Routes({ mobile = false }: { mobile?: boolean }) {
  const id = useId();
  return (
    <svg className={`overview-routes overview-routes-${mobile ? "mobile" : "desktop"}`} viewBox={mobile ? "0 0 300 800" : "0 0 1000 500"} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        {/* auto-start-reverse lets the two-way seller route carry an arrowhead at both ends. */}
        {tones.map((tone) => <marker key={tone} id={`${id}-${tone}`} markerWidth="7" markerHeight="8" refX="6" refY="4" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path className={`overview-arrow-${tone}`} d="m1 1 5 3-5 3" fill="none" strokeWidth="1.5" /></marker>)}
      </defs>
      {routes.map((route) => {
        const d = mobile ? route.mobile : route.desktop;
        const arrow = `url(#${id}-${route.tone})`;
        return <g key={route.name} className={`overview-route overview-route-${route.kind} overview-tone-${route.tone}`}>
          <path className="overview-wire" d={d} markerEnd={arrow} markerStart={route.twoWay ? arrow : undefined} />
          {route.legs.map((leg) => <path key={leg.name} className={`overview-packet overview-leg-${leg.name}`} d={d} pathLength="100" />)}
        </g>;
      })}
    </svg>
  );
}

export default function ScrollWalkthrough() {
  const diagram = useRef<HTMLElement>(null);

  useEffect(() => {
    const target = diagram.current;
    if (!target || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        (entry.target as HTMLElement).dataset.inView = String(entry.isIntersecting && entry.intersectionRatio >= .25);
      }
    }, { threshold: [0, .25] });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="how-section section-wrap payment-overview" id="how-it-works" aria-labelledby="how-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">How it works</span>
          <h2 id="how-title">One payment. <span>The whole picture.</span></h2>
        </div>
      </div>
      <div className="overview-panel" role="region" aria-label="Payment overview">
        <div className="overview-atmosphere" aria-hidden="true"><SoffitBackdrop /></div>
        <div className="overview-meta">
          <span className="overview-preview"><i aria-hidden="true" />Live on Preprod</span>
          <span className="overview-boundary"><LockIcon size={12} />Note secrets stay local</span>
        </div>
        <figure className="overview-diagram" ref={diagram} role="img" aria-label={description}>
          <Routes />
          <Routes mobile />
          <FlowNode name="wallet" label="Your wallet" note="Holds your agent's funds" icon={WalletIcon} />
          <FlowNode name="pool" label="Shared pool" note="Shared by many agents" icon={PoolIcon} />
          <FlowNode name="key" label="One-time key" note="A fresh address, used once" icon={KeyIcon} />
          <FlowNode name="agent" label="Your agent" note="Private note stays local" />
          <FlowNode name="relayer" label="Relayer" note="Never sees your secrets" icon={RelayerIcon} />
          <FlowNode name="seller" label="x402 seller" note="A normal paid API. Nothing changes." icon={SellerIcon} />
          {labels.map(([key, text]) => <span key={key} className={`overview-route-label overview-label-${key}`}>{text}</span>)}
          <span className="overview-local-label">Proves on your device</span>
        </figure>
        <div className="overview-legend" aria-hidden="true">
          <span><i className="overview-key-chain" />On chain</span>
          <span><i className="overview-key-web" />Web request</span>
          <span><i className="overview-key-unlinkable" />No link to your wallet</span>
        </div>
      </div>
    </section>
  );
}
