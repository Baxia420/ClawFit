import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { Shell } from "../components/Shell";
import "./globals.css";

const archivo = Archivo({ subsets: ["latin"], variable: "--font-body" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = { title: "ClawFit", description: "Private nutrition and strength log" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={`${archivo.variable} ${mono.variable}`}><body><div className="grain" /><Shell>{children}</Shell></body></html>;
}

