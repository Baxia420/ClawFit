"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AssistantDrawer } from "./AssistantDrawer";

const navigation = [
  ["Today", "/"],
  ["Nutrition", "/nutrition"],
  ["Workouts", "/workouts"],
  ["Settings", "/settings"],
] as const;

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="rail">
        <Link className="brand" href="/" aria-label="ClawFit home"><span>CF</span><strong>CLAW/FIT</strong></Link>
        <nav aria-label="Primary navigation">
          {navigation.map(([label, href], index) => <Link href={href} key={href} aria-current={pathname === href ? "page" : undefined}><small>0{index + 1}</small>{label}</Link>)}
        </nav>
        <div className="rail-status">API / SERVER-SIDE<br /><span>PRIVATE HEALTH DATA</span></div>
      </aside>
      <main id="main">{children}</main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        <Link href="/" aria-current={pathname === "/" ? "page" : undefined}><small>01</small>Today</Link>
        <Link href="/nutrition" aria-current={pathname === "/nutrition" ? "page" : undefined}><small>02</small>Nutrition</Link>
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("clawfit:ask"))}><strong>+</strong>Ask</button>
        <Link href="/workouts" aria-current={pathname === "/workouts" ? "page" : undefined}><small>03</small>Workouts</Link>
        <Link href="/settings" aria-current={pathname === "/settings" ? "page" : undefined}><small>04</small>More</Link>
      </nav>
      <AssistantDrawer />
    </div>
  );
}
