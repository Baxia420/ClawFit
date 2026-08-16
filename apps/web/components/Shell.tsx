import Link from "next/link";
import type { ReactNode } from "react";

const navigation = [
  ["Today", "/"],
  ["Nutrition", "/nutrition"],
  ["Workouts", "/workouts"],
] as const;

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="rail">
        <Link className="brand" href="/" aria-label="ClawFit home"><span>CF</span><strong>CLAW/FIT</strong></Link>
        <nav aria-label="Primary navigation">
          {navigation.map(([label, href], index) => <Link href={href} key={href}><small>0{index + 1}</small>{label}</Link>)}
        </nav>
        <div className="rail-status"><i /> API LINK<br /><span>PRIVATE / LOCAL</span></div>
      </aside>
      <main id="main">{children}</main>
    </div>
  );
}

