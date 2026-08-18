import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ClawFit — Nutrition & Strength",
    short_name: "ClawFit",
    description: "Private nutrition and strength tracking with Ask ClawFit.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#efeee6",
    theme_color: "#171b18",
    orientation: "portrait-primary",
    categories: ["health", "fitness", "lifestyle"],
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
