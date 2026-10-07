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

const description = "Your wallet deposits ADA into one shared pool. The pool funds a one-time key, and that key pays the x402 seller. Your agent keeps its private note secrets local and generates a proof on your device. Only proof and intent go to the relayer. The relayer submits the proof to the shared pool.";

function FlowNode({ name, label, icon: Icon }: { name: string; label: string; icon?: BrandIcon }) {
  return (
    <div className={`overview-node overview-node-${name}`}>
      <span className="overview-symbol">
        {Icon ? <Icon /> : <span className="overview-agent-portrait" />}
      </span>
      <strong>{label}</strong>
      {name === "agent" && <small><LockIcon size={10} />Private note stays local</small>}
    </div>
  );
}

const desktopRoutes = [
  "M134 90H306",
  "M414 90H586",
  "M694 90H866",
  "M314 295H586",
  "M640 243V216Q640 200 624 200H376Q360 200 360 184V169",
];
const mobileRoutes = [
  "M220 147V207",
  "M220 334V432",
  "M220 560V644",
  "M66 245V323",
  "M103 370H129Q145 370 145 354V266Q145 250 161 250H185",
];

function Routes({ mobile = false }: { mobile?: boolean }) {
  const id = useId();
  const routes = mobile ? mobileRoutes : desktopRoutes;
  return (
    <svg className={`overview-routes overview-routes-${mobile ? "mobile" : "desktop"}`} viewBox={mobile ? "0 0 300 760" : "0 0 1000 420"} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        {["funds", "proof"].map((kind) => <marker key={kind} id={`${id}-${kind}`} markerWidth="7" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path className={`overview-arrow-${kind}`} d="m1 1 5 3-5 3" fill="none" strokeWidth="1.5" /></marker>)}
      </defs>
      {routes.map((d, i) => <g key={d} className={`overview-route overview-route-${i} ${i > 2 ? "overview-route-proof" : "overview-route-funds"}`}>
        <path className="overview-wire" d={d} markerEnd={`url(#${id}-${i > 2 ? "proof" : "funds"})`} />
        <path className="overview-packet" d={d} pathLength="100" />
      </g>)}
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
          <span className="overview-preview"><i aria-hidden="true" />Planned flow</span>
          <span className="overview-boundary"><LockIcon size={12} />Note secrets stay local</span>
        </div>
        <figure className="overview-diagram" ref={diagram} role="img" aria-label={description}>
          <Routes />
          <Routes mobile />
          <FlowNode name="wallet" label="Your wallet" icon={WalletIcon} />
          <FlowNode name="pool" label="Shared pool" icon={PoolIcon} />
          <FlowNode name="key" label="One-time key" icon={KeyIcon} />
          <FlowNode name="seller" label="x402 seller" icon={SellerIcon} />
          <FlowNode name="agent" label="Your agent" />
          <FlowNode name="relayer" label="Relayer" icon={RelayerIcon} />
          <span className="overview-route-label overview-label-deposit">ADA deposit</span>
          <span className="overview-route-label overview-label-fund">Price + fee</span>
          <span className="overview-route-label overview-label-pay">x402 payment</span>
          <span className="overview-route-label overview-label-proof">Proof + intent</span>
          <span className="overview-route-label overview-label-submit">Submit proof</span>
          <span className="overview-local-label">Proves on your device</span>
        </figure>
        <div className="overview-legend" aria-hidden="true">
          <span><i />Funds</span>
          <span><i />Proof &amp; authorization</span>
        </div>
      </div>
    </section>
  );
}
