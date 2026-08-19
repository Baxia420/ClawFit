import { createElement } from "react";
import { ImageResponse } from "next/og";

export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(
    createElement("div", {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#171b18",
        color: "#b8f34a",
        fontSize: 68,
        fontWeight: 900,
        border: "13px solid #24786d",
        borderRadius: 36,
      },
    }, "CF"),
    { width: 192, height: 192 },
  );
}
