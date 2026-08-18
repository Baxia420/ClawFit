import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(<div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#171b18", color: "#b8f34a", fontSize: 64, fontWeight: 900, border: "12px solid #24786d" }}>CF</div>, size);
}
