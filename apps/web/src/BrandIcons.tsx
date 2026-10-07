import { type ReactNode, type SVGProps } from "react";
import "./brand-icons.css";

export type BrandIconProps = SVGProps<SVGSVGElement> & { size?: number | string };
export type BrandIcon = (props: BrandIconProps) => ReactNode;
function Symbol({ size = 32, className = "", children, ...props }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false" {...props} className={`z-icon z-icon-illustration ${className}`}>
      {children}
    </svg>
  );
}

function Utility({ size = 24, className = "", children, ...props }: BrandIconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props} className={`z-icon z-icon-ui ${className}`}>{children}</svg>;
}

export function WalletIcon(props: BrandIconProps) {
  return <Symbol {...props}>
    <path d="M10 18h32l12 12v23H10V18Zm7 7v21h30V33l-8-8H17Z" fill="var(--glyph-primary)" fillRule="evenodd" />
    <path d="M17 11h25v7H17zM36 32h19v9H36z" fill="var(--glyph-secondary)" />
    <path d="M42 35h5v3h-5z" fill="var(--glyph-primary)" />
  </Symbol>;
}

export function PoolIcon(props: BrandIconProps) {
  return <Symbol {...props}>
    <path d="M23 8H10v14m31 34h13V42" stroke="var(--glyph-secondary)" strokeWidth="3" />
    <path d="M17 20h32L38 31H17Zm11 17h21v11H17Z" fill="var(--glyph-primary)" />
    <path d="m38 31-10 6H17l10-6Z" fill="var(--glyph-secondary)" />
  </Symbol>;
}

export function RelayerIcon(props: BrandIconProps) {
  return <Symbol {...props}>
    <path d="M8 14h16v6H14v24h10v6H8Zm32 0h16v36H40v-6h10V20H40Z" fill="var(--glyph-primary)" />
    <path d="m24 32 8-8 8 8-8 8Z" fill="var(--glyph-secondary)" />
    <path d="M14 32h10m16 0h10" stroke="var(--glyph-secondary)" strokeWidth="2" />
  </Symbol>;
}

export function KeyIcon(props: BrandIconProps) {
  return <Symbol {...props}>
    <path d="m32 10 17 0 9 9v17l-9 9H33l-5 5h-7v7H7V43l16-16V19l9-9Zm5 8-6 6v7l6 6h7l6-6v-7l-6-6h-7Z" fill="var(--glyph-primary)" fillRule="evenodd" />
    <path d="m14 46 12-12" stroke="var(--glyph-secondary)" strokeWidth="3" />
  </Symbol>;
}

export function SellerIcon(props: BrandIconProps) {
  return <Symbol {...props}>
    <path d="M12 11h31l9 9v33H12V11Zm7 15v20h26V26H19Z" fill="var(--glyph-primary)" fillRule="evenodd" />
    <path d="M20 16h18v4H20zM25 32l7 4-7 4m12-8v8" stroke="var(--glyph-secondary)" strokeWidth="3" />
  </Symbol>;
}

export function ProofIcon(props: BrandIconProps) {
  return <Symbol {...props}>
    <path d="M14 9h25l12 12v34H14V9Zm7 7v32h23V24L36 16H21Z" fill="var(--glyph-primary)" fillRule="evenodd" />
    <path d="M36 9v15h15" stroke="var(--glyph-secondary)" strokeWidth="3" />
    <path d="m25 35 6 6 10-13" stroke="var(--glyph-secondary)" strokeWidth="4" strokeLinejoin="miter" />
  </Symbol>;
}

export function NetworkIcon(props: BrandIconProps) {
  return <Symbol {...props}>
    <path d="m18 19 29 6-15 24Z" stroke="var(--glyph-secondary)" strokeWidth="3" />
    <path d="m18 9 10 10-10 10L8 19Zm29 7 9 9-9 9-9-9ZM32 40l9 9-9 9-9-9Z" fill="var(--glyph-primary)" />
  </Symbol>;
}

export function LockIcon(props: BrandIconProps) {
  return <Utility {...props}><path d="M7.5 10V7a4.5 4.5 0 0 1 9 0v3" strokeWidth="3" /><path d="M5 10.5c4-1 10-1 14 0l.5 7c0 3-2.5 4-7.5 4s-7.5-1-7.5-4Z" fill="currentColor" stroke="none" /><path d="M12 14v3" stroke="var(--icon-cutout, #d7cbe1)" strokeWidth="2" /></Utility>;
}
export function ShieldIcon(props: BrandIconProps) {
  return <Utility {...props}><path d="M12 2.5c3 2 6 3 8.5 3.5 0 8-2 12-8.5 15.5C5.5 18 3.5 14 3.5 6 6 5.5 9 4.5 12 2.5Z" fill="currentColor" fillOpacity=".2" strokeWidth="1.8" /><path d="m8.5 12 2.5 2.5 4.5-5" strokeWidth="2.5" /></Utility>;
}
export function CheckIcon(props: BrandIconProps) {
  return <Utility {...props}><path d="m5 12 4.5 4.5L19 7" strokeWidth="3" /></Utility>;
}
export function ArrowRightIcon(props: BrandIconProps) {
  return <Utility {...props}><path d="M4 13c5-1 10-1 15-1M14 6l6 6-6 6" /></Utility>;
}
export function ArrowUpRightIcon(props: BrandIconProps) {
  return <Utility {...props}><path d="M6 18c1-4 5-8 11-12M9 5h10v10" /></Utility>;
}
export function ArrowDownIcon(props: BrandIconProps) {
  return <Utility {...props}><path d="M11 4c1 5 1 10 1 15M6 14l6 6 6-6" /></Utility>;
}
export function ChevronDownIcon(props: BrandIconProps) {
  return <Utility {...props}><path d="m6 9 6 6 6-6" strokeWidth="2.6" /></Utility>;
}
export function MenuIcon(props: BrandIconProps) {
  return <Utility {...props}><path d="M4 6h16M4 12h11M4 18h16" strokeWidth="2.7" /></Utility>;
}
export function CloseIcon(props: BrandIconProps) {
  return <Utility {...props}><path d="m6 6 12 12M18 6 6 18" strokeWidth="2.7" /></Utility>;
}
export function PauseIcon(props: BrandIconProps) {
  return <Utility {...props}><rect x="5" y="4" width="5" height="16" rx="2.5" fill="currentColor" stroke="none" /><rect x="14" y="4" width="5" height="16" rx="2.5" fill="currentColor" stroke="none" /></Utility>;
}
export function PlayIcon(props: BrandIconProps) {
  return <Utility {...props}><path d="M6 5c0-2 1.5-2.5 3-1.5l11 7c1.5 1 1.5 2 0 3l-11 7c-1.5 1-3 .5-3-1.5Z" fill="currentColor" stroke="none" /></Utility>;
}

export function Zx402Mark({ size = 32, className = "", ...props }: BrandIconProps) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false" {...props} className={`z-icon z-icon-mark ${className}`}>
    <path d="M6 7h21l-6 6H5V8a1 1 0 0 1 1-1Zm5 12h16v5a1 1 0 0 1-1 1H5Z" fill="currentColor" />
    <path d="m19 13-6 6H5l6-6Z" fill="currentColor" opacity=".45" />
  </svg>;
}
export function CardanoIcon(props: BrandIconProps) {
  return <Utility {...props} stroke="none"><circle cx="12" cy="12" r="2" fill="currentColor" />{[0,60,120,180,240,300].map((angle) => <g key={angle} transform={`rotate(${angle} 12 12)`}><circle cx="12" cy="6.5" r="1.5" fill="currentColor" /><circle cx="12" cy="1.5" r=".8" fill="currentColor" /></g>)}</Utility>;
}
