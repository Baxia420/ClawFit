import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { Shell } from "../components/Shell";
import { ServiceWorkerRegister } from "../components/ServiceWorkerRegister";
import "./globals.css";

const archivo = Archivo({ subsets: ["latin"], variable: "--font-body" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: { default: "ClawFit", template: "%s / ClawFit" },
  description: "Private nutrition and strength log",
  applicationName: "ClawFit",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "ClawFit" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#171b18", colorScheme: "light" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={`${archivo.variable} ${mono.variable}`}><body><div className="grain" /><Shell>{children}</Shell><ServiceWorkerRegister /></body></html>;
}
