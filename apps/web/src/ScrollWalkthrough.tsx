import { useEffect, useRef } from "react";
import SoffitBackdrop from "./SoffitBackdrop";
import {
  ArrowRightIcon,
  CheckIcon,
  KeyIcon,
  LockIcon,
  PoolIcon,
  RelayerIcon,
  SellerIcon,
  WalletIcon,
  type BrandIcon,
} from "./BrandIcons";
import "./scroll-walkthrough.css";

function FlowNode({
  label,
  icon: Icon,
  portrait = false,
  tone = "plain",
  cue = "send",
}: {
  label: string;
  icon?: BrandIcon;
  portrait?: boolean;
  tone?: "plain" | "accent" | "sage";
  cue?: "send" | "receive" | "key" | "seller";
}) {
  return (
    <div className={`overview-node overview-node-${tone} overview-cue-${cue}${Icon || portrait ? "" : " overview-node-pool"}`}>
      <span>{portrait ? <i className="overview-agent-portrait" aria-hidden="true" /> : Icon ? <Icon aria-hidden="true" /> : <PoolIcon />}</span>
      <small>{label}</small>
    </div>
  );
}

function FlowArrow({ label, leg = "single" }: { label?: string; leg?: "single" | "first" | "second" }) {
  return (
    <div className={`overview-flow-arrow overview-leg-${leg}`} aria-hidden="true">
      {label && <small>{label}</small>}
      <span><i className="overview-packet" /><ArrowRightIcon size={13} /></span>
    </div>
  );
}

export default function ScrollWalkthrough() {
  const steps = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!steps.current || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        (entry.target as HTMLElement).dataset.inView = String(entry.isIntersecting && entry.intersectionRatio >= .25);
      }
    }, { threshold: [0, .25] });
    for (const card of steps.current.children) observer.observe(card);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      className="how-section section-wrap payment-overview"
      id="how-it-works"
      aria-labelledby="how-title"
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">How it works</span>
          <h2 id="how-title">Private payments. <span>Three simple steps.</span></h2>
        </div>
      </div>
      <div className="overview-panel" role="region" aria-label="Payment overview">
        <div className="overview-atmosphere" aria-hidden="true">
          <SoffitBackdrop />
        </div>
        <div className="overview-meta">
          <span className="overview-preview"><i aria-hidden="true" />Planned flow</span>
          <span className="overview-boundary"><LockIcon size={12} aria-hidden="true" />Note secrets stay local</span>
        </div>
        <ol className="overview-steps" ref={steps}>
          <li className="overview-step">
            <div className="overview-step-label" aria-hidden="true"><span>01</span> FUND <ArrowRightIcon size={15} /></div>
            <h3>Deposit</h3>
            <p>Deposit ADA into the shared pool. Your private note stays on your device.</p>
            <div className="overview-diagram" role="img" aria-label="Your wallet deposits ADA into the shared pool. Your private note stays local.">
              <FlowNode label="Your wallet" icon={WalletIcon} />
              <FlowArrow label="ADA" />
              <FlowNode label="Shared pool" tone="accent" cue="receive" />
              <span className="overview-note"><LockIcon size={10} aria-hidden="true" />Private note saved locally</span>
            </div>
          </li>
          <li className="overview-step">
            <div className="overview-step-label" aria-hidden="true"><span>02</span> AUTHORIZE <ArrowRightIcon size={15} /></div>
            <h3>Prove locally</h3>
            <p>Generate a proof on your device. Send only proof and intent to the relayer.</p>
            <div className="overview-diagram" role="img" aria-label="Your agent generates a proof locally. Only proof and intent go to the relayer.">
              <FlowNode label="Your agent" portrait tone="accent" />
              <FlowArrow label="Proof + intent" />
              <FlowNode label="Relayer" icon={RelayerIcon} cue="receive" />
              <span className="overview-note"><CheckIcon size={11} aria-hidden="true" />Proof generated locally</span>
            </div>
          </li>
          <li className="overview-step overview-step-pay">
            <div className="overview-step-label" aria-hidden="true"><span>03</span> PAY <CheckIcon size={15} /></div>
            <h3>Pay</h3>
            <p>The pool funds a one-time key, which pays the x402 seller. Your agent gets back to work.</p>
            <div className="overview-diagram overview-diagram-pay" role="img" aria-label="The shared pool funds a one-time key. That key makes the standard x402 payment to the seller.">
              <FlowNode label="Shared pool" tone="accent" />
              <FlowArrow leg="first" />
              <FlowNode label="One-time key" icon={KeyIcon} cue="key" />
              <FlowArrow leg="second" />
              <FlowNode label="x402 seller" icon={SellerIcon} tone="sage" cue="seller" />
              <span className="overview-note"><CheckIcon size={11} aria-hidden="true" />Standard x402 payment</span>
            </div>
          </li>
        </ol>
      </div>
    </section>
  );
}
