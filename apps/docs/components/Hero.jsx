import Link from 'next/link';
import Mark from './Mark';

const buttonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 44,
  padding: '0.6rem 1.1rem',
  borderRadius: 8,
  fontWeight: 600,
  textDecoration: 'none',
};

export default function Hero() {
  return (
    <section aria-labelledby="overview-title" style={{ padding: '2rem 0 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Mark size={72} style={{ flexShrink: 0 }} />
        <h1 id="overview-title" style={{ margin: 0, fontSize: 'clamp(2.8rem, 7vw, 4rem)', fontWeight: 700, letterSpacing: '-0.04em', lineHeight: 1.1 }}>
          zx402
        </h1>
      </div>
      <p style={{ margin: '1rem 0', maxWidth: '32rem', fontSize: '1.4rem', lineHeight: 1.5 }}>
        Private payments for AI agents on Cardano
      </p>
      <span className="hero-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '0.35rem 0.7rem', borderRadius: 20, fontSize: '0.8rem', fontWeight: 600 }}>
        <span className="hero-dot" aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%' }} />
        Live on Cardano Preprod
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: '1.5rem' }}>
        <Link href="/guide/life-of-a-payment" className="hero-button-primary x:focus-visible:nextra-focus" style={buttonStyle}>
          How it works
        </Link>
        <Link href="/guide/running" className="hero-button-secondary x:focus-visible:nextra-focus" style={buttonStyle}>
          Run it
        </Link>
      </div>
    </section>
  );
}
