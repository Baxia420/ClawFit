import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), api: vi.fn() }));
vi.mock("../../../auth", () => ({ auth: mocks.auth }));
vi.mock("../../../lib/api", () => ({ healthApiRequest: mocks.api, HealthApiError: class extends Error { status = 500; } }));
import { POST } from "./route";
function request(command: object, headers: Record<string,string> = {}) {
  return new Request("https://clawfit.example/api/training", { method: "POST", headers: { host: "clawfit.example", origin: "https://clawfit.example", "content-type": "application/json", ...headers }, body: JSON.stringify(command) });
}
describe("training dashboard write boundary", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "signed-in-owner" } }); mocks.api.mockResolvedValue({ saved: true }); });
  it("refuses cross-site writes and unauthenticated requests", async () => {
    expect((await POST(request({ action: "goal", data: { goalKg: null } }, { origin: "https://other.example" }))).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.api).not.toHaveBeenCalled();
    mocks.auth.mockResolvedValue(null);
    expect((await POST(request({ action: "goal", data: { goalKg: null } }))).status).toBe(401);
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it("proxies only validated commands with the session identity, never caller-supplied identity or URL", async () => {
    const response = await POST(request({ action: "weight", day: "2026-10-02", userId: "another-owner", url: "/v1/users", data: { weightKg: 79, userId: "another-owner" } }));
    expect(response.status).toBe(200);
    expect(mocks.api).toHaveBeenCalledWith("/v1/training/weight/2026-10-02", { method: "PUT", body: JSON.stringify({ weightKg: 79, notes: "" }), userId: "signed-in-owner" });
    mocks.api.mockClear();
    expect((await POST(request({ action: "generic-http", url: "/v1/users" }))).status).toBe(400);
    expect((await POST(request({ action: "weight", day: "2026-02-30", data: { weightKg: 79 } }))).status).toBe(400);
    expect(mocks.api).not.toHaveBeenCalled();
  });
});
