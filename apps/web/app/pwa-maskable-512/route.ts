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
      },
    }, createElement("div", {
      style: {
        width: 360,
        height: 360,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#b8f34a",
        fontSize: 150,
        fontWeight: 900,
        border: "30px solid #24786d",
        borderRadius: 90,
      },
    }, "CF")),
    { width: 512, height: 512 },
  );
}
