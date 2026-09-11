"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AssistantDrawer } from "./AssistantDrawer";
import { signOutAction } from "../app/actions";

const navigation = [
  ["Today", "/"],
  ["Together", "/together"],
  ["Nutrition", "/nutrition"],
  ["Workouts", "/workouts"],
  ["Settings", "/settings"],
] as const;

export interface ShellUser {
  id?: string | undefined;
  name?: string | null | undefined;
  email?: string | null | undefined;
  displayName?: string | null | undefined;
  role?: string | null | undefined;
}

export function Shell({ children, user }: { children: ReactNode; user?: ShellUser | undefined }) {
  const pathname = usePathname();
  const isAuthPage = pathname?.startsWith("/auth");

  if (isAuthPage) {
    return (
      <div className="auth-shell">
        <main id="main">{children}</main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="rail">
        <Link className="brand" href="/" aria-label="ClawFit home"><span>CF</span><strong>CLAW/FIT</strong></Link>
        <nav aria-label="Primary navigation">
          {navigation.map(([label, href], index) => <Link href={href} key={href} aria-current={pathname === href ? "page" : undefined}><small>0{index + 1}</small>{label}</Link>)}
        </nav>
        {user && (
          <div className="rail-user">
            <div className="rail-user-meta">
              <strong className="user-name">{user.displayName ?? user.name ?? "User"}</strong>
            </div>
            <form action={signOutAction}>
              <button type="submit" className="rail-signout-btn">Sign Out</button>
            </form>
          </div>
        )}
        <div className="rail-status">API / SERVER-SIDE<br /><span>PRIVATE HEALTH DATA</span></div>
      </aside>
      {user && (
        <div className="mobile-user-bar">
          <div className="mobile-user-meta">
            <strong className="user-name">{user.displayName ?? user.name ?? "User"}</strong>
          </div>
          <form action={signOutAction}>
            <button type="submit" className="mobile-signout-btn">Sign Out</button>
          </form>
        </div>
      )}
      <main id="main">{children}</main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        <Link href="/" aria-current={pathname === "/" ? "page" : undefined}><small>01</small>Today</Link>
        <Link href="/together" aria-current={pathname === "/together" ? "page" : undefined}><small>02</small>Together</Link>
        <Link href="/nutrition" aria-current={pathname === "/nutrition" ? "page" : undefined}><small>03</small>Nutrition</Link>
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("clawfit:ask"))}><strong>+</strong>Ask</button>
        <Link href="/workouts" aria-current={pathname === "/workouts" ? "page" : undefined}><small>04</small>Workouts</Link>
        <Link href="/settings" aria-current={pathname === "/settings" ? "page" : undefined}><small>05</small>More</Link>
      </nav>
      <AssistantDrawer key={user?.id ?? "anon"} />
    </div>
  );
}
