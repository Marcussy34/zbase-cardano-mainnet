import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Fingerprint,
  LockKeyhole,
  ScanLine,
  ShieldCheck,
} from "lucide-react";
import "./privacy-section.css";

export default function PrivacySection() {
  return (
    <section
      className="privacy-boundary section-wrap"
      id="privacy"
      aria-labelledby="privacy-title"
    >
      <div className="privacy-heading" data-reveal>
        <div>
          <span className="eyebrow">Privacy, with a clear boundary.</span>
          <h2 id="privacy-title">
            A proof can travel.
            <br />
            <span>Your secrets stay home.</span>
          </h2>
        </div>
        <p>
          Give the network what it needs.
          <br />
          Keep the rest on your side.
        </p>
      </div>

      <div className="privacy-canvas" data-reveal>
        <div className="privacy-canvas-meta">
          <span>
            <i /> The default design
          </span>
          <span>01 / THE PRIVACY BOUNDARY</span>
        </div>
        <div className="privacy-boundary-scene">
          <div
            className="privacy-local-zone"
            role="group"
            aria-label="Kept on your device"
          >
            <div className="privacy-zone-label">
              <LockKeyhole size={13} aria-hidden="true" /> Kept on your device
            </div>
            <div className="privacy-vault-stack" aria-hidden="true">
              <span />
              <span />
            </div>
            <div className="privacy-vault">
              <div className="privacy-vault-top">
                <Fingerprint size={27} strokeWidth={1.3} aria-hidden="true" />
                <span>
                  PRIVATE NOTE<span>LOCAL ACCESS ONLY</span>
                </span>
                <LockKeyhole size={15} aria-hidden="true" />
              </div>
              <div className="privacy-secret-row">
                <span>Note secrets</span>
                <span
                  className="privacy-redacted"
                  role="img"
                  aria-label="Kept private"
                >
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              </div>
              <div className="privacy-secret-row">
                <span>Private balance</span>
                <span
                  className="privacy-redacted"
                  role="img"
                  aria-label="Kept private"
                >
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              </div>
              <div className="privacy-vault-bottom">
                <ShieldCheck size={15} aria-hidden="true" />
                <span>Proved here. Kept here.</span>
                <span className="privacy-vault-id" aria-hidden="true">
                  Z / 001
                </span>
              </div>
            </div>
            <p className="privacy-zone-caption">
              Your agent holds the note.
              <br />
              Your machine makes the proof.
            </p>
          </div>

          <div className="privacy-crossing" aria-hidden="true">
            <div className="privacy-boundary-rule">
              <span>THE BOUNDARY</span>
            </div>
            <div className="privacy-proof-track">
              <span />
              <div className="privacy-proof-packet">
                <ScanLine size={22} strokeWidth={1.3} />
                <span>ZK PROOF</span>
              </div>
              <ArrowRight size={18} />
            </div>
            <span className="privacy-crossing-note">
              Proof out.
              <br />
              Secrets in.
            </span>
          </div>

          <div
            className="privacy-network-zone"
            role="group"
            aria-label="Shared with the network"
          >
            <div className="privacy-zone-label">
              <ScanLine size={13} aria-hidden="true" /> Shared with the network
            </div>
            <div className="privacy-receipt">
              <div className="privacy-receipt-top">
                <span>PAYMENT PATH</span>
                <span>ILLUSTRATION</span>
              </div>
              <div className="privacy-receipt-row">
                <span>Sent to the relayer</span>
                <strong>
                  Proof + intent <Check size={13} aria-hidden="true" />
                </strong>
              </div>
              <div className="privacy-receipt-row">
                <span>Funding source</span>
                <strong>
                  Shared pool{" "}
                  <span className="privacy-pool-dots" aria-hidden="true">
                    ⠿
                  </span>
                </strong>
              </div>
              <div className="privacy-receipt-row">
                <span>Public payment details</span>
                <strong>Amount · Recipient · Timing</strong>
              </div>
              <div className="privacy-receipt-foot">
                <LockKeyhole size={12} aria-hidden="true" />
                <span>No note secrets sent</span>
              </div>
            </div>
            <p className="privacy-zone-caption">
              The relayer gets what it needs.
              <br />
              The seller receives a standard payment.
            </p>
          </div>
        </div>
        <div className="privacy-canvas-foot">
          <span>
            <ShieldCheck size={14} aria-hidden="true" /> Designed to separate
            your funding wallet from your payments.
          </span>
          <span>In development</span>
        </div>
      </div>

      <div className="privacy-facts">
        <article data-reveal>
          <span className="privacy-fact-number">01 / KEEP</span>
          <h3>Local by default.</h3>
          <p>
            Proofs are generated on your agent’s machine. The relayer gets a
            proof and an intent. Your note secrets never make the trip.
          </p>
          <a className="text-link" href="/docs/?topic=spec">
            Explore local proving <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        </article>
        <article data-reveal>
          <span className="privacy-fact-number">02 / SEPARATE</span>
          <h3>One pool. Many origins.</h3>
          <p>
            Funds join a shared pool. Payments are designed to leave it without
            identifying the deposit that funded them.
          </p>
          <a className="text-link" href="/docs/?topic=overview">
            Understand the privacy model{" "}
            <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        </article>
        <article className="privacy-limit" data-reveal>
          <span className="privacy-fact-number">03 / UNDERSTAND</span>
          <h3>Privacy has boundaries.</h3>
          <p>
            Amounts, recipients, and timing remain public. Privacy also depends
            on the approved deposit set and your payment patterns.
          </p>
          <span className="privacy-limit-label">
            <ScanLine size={13} aria-hidden="true" /> A clear view of the
            limits.
          </span>
        </article>
      </div>
    </section>
  );
}
