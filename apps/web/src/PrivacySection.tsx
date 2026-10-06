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
        <h2 id="privacy-title">
          Your secrets. <span>Yours.</span>
        </h2>
        <a className="text-link" href="/docs/?topic=spec#13-privacy">
          Privacy model <ArrowUpRight size={15} aria-hidden="true" />
        </a>
      </div>

      <div className="privacy-canvas" data-reveal>
        <div className="privacy-boundary-scene">
          <div
            className="privacy-local-zone"
            role="group"
            aria-label="Kept on your device"
          >
            <div className="privacy-zone-label">
              <LockKeyhole size={13} aria-hidden="true" /> Your device
            </div>
            <div className="privacy-vault-stack" aria-hidden="true">
              <span />
              <span />
            </div>
            <div className="privacy-vault">
              <div className="privacy-vault-top">
                <Fingerprint size={27} strokeWidth={1.3} aria-hidden="true" />
                <span>
                  PRIVATE NOTE<span>LOCAL BY DEFAULT</span>
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
                <span>Proof generated locally</span>
              </div>
            </div>
          </div>

          <div className="privacy-crossing" aria-hidden="true">
            <div className="privacy-boundary-rule" />
            <div className="privacy-proof-track">
              <span />
              <div className="privacy-proof-packet">
                <ScanLine size={22} strokeWidth={1.3} />
                <span>ZK PROOF</span>
              </div>
              <ArrowRight size={18} />
            </div>
          </div>

          <div
            className="privacy-network-zone"
            role="group"
            aria-label="Shared with the network"
          >
            <div className="privacy-zone-label">
              <ScanLine size={13} aria-hidden="true" /> The network
            </div>
            <div className="privacy-receipt">
              <div className="privacy-receipt-row">
                <span>To the relayer</span>
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
            </div>
          </div>
        </div>
      </div>

      <p className="privacy-limit" data-reveal>
        Amounts, recipients, and timing remain public.
        <span>
          Privacy depends on the approved deposit set and payment patterns.
        </span>
      </p>
    </section>
  );
}
