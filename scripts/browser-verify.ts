import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execSync, type ChildProcess } from "node:child_process";

const SCREENSHOT_DIR = path.resolve("review-packages/2/screenshots");
const PORT = 4199;
const CDP_PORT = 9222;

// In-memory server state mimicking Health API pending meal endpoints
interface PendingRecord {
  id: string;
  label: string;
  items: Array<{ name: string; portionDescription: string; calories?: number; proteinG?: number; carbsG?: number; fatG?: number; fiberG?: number | null }>;
  caloriesBest: number;
  caloriesLow: number;
  caloriesHigh: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number | null;
  confidence: string;
  uncertaintyReasons: string[];
  source: string;
  rawUserText: string | null;
  occurredAt: string;
  idempotencyKey: string;
  confirmed: boolean;
  cancelledAt: string | null;
  version: number;
}

let latestPending: PendingRecord | null = null;
let confirmedMeals: Array<Record<string, unknown>> = [];
let simulateServerVersionAdvance = false;
let simulateDeleteFailure = false;

async function buildHarness() {
  const scratchDir = path.resolve("scratch");
  await fs.mkdir(scratchDir, { recursive: true });

  const navShimPath = path.join(scratchDir, "nav-shim.ts");
  await fs.writeFile(
    navShimPath,
    `
    export function useRouter() {
      return {
        refresh: () => { (window as any).__refreshed = true; },
        push: () => {},
        replace: () => {},
      };
    }
    `,
  );

  const linkShimPath = path.join(scratchDir, "link-shim.tsx");
  await fs.writeFile(
    linkShimPath,
    `
    import React from "react";
    export default function Link({ href, children, ...props }: any) {
      return <a href={href} {...props}>{children}</a>;
    }
    `,
  );

  const entryPath = path.join(scratchDir, "entry.tsx");
  await fs.writeFile(
    entryPath,
    `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { MealLogFlow } from "../apps/web/components/MealLogFlow";

    function mount() {
      const container = document.getElementById("root");
      if (container) {
        const root = createRoot(container);
        root.render(
          <div className="page meal-log-page">
            <header className="page-header compact">
              <div>
                <span className="kicker">NUTRITION INTAKE · DIRECT RECORD</span>
                <h1>
                  Log a<br />
                  <em>meal.</em>
                </h1>
              </div>
              <div className="header-code">
                INPUT: TEXT / PHOTO / MANUAL
                <br />
                CONFIRMATION REQUIRED
              </div>
            </header>
            <MealLogFlow timezone="Asia/Kuala_Lumpur" />
          </div>
        );
      }
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mount);
    } else {
      mount();
    }
    `,
  );

  const outBundle = path.join(scratchDir, "bundle.js");
  execSync(
    `npx esbuild "${entryPath}" --bundle --outfile="${outBundle}" --define:process.env.NODE_ENV='"production"' --alias:next/navigation="${navShimPath}" --alias:next/link="${linkShimPath}" --loader:.tsx=tsx --loader:.ts=ts --jsx=automatic --target=chrome120`,
    { stdio: "inherit" },
  );

  return outBundle;
}

function createMockServer(bundlePath: string) {
  const globalsCssPath = path.resolve("apps/web/app/globals.css");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    const method = req.method?.toUpperCase();

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/" || url.pathname === "/meals/log") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>ClawFit - Meal Logging</title>
          <link rel="stylesheet" href="/globals.css" />
        </head>
        <body>
          <div id="root"></div>
          <script src="/bundle.js"></script>
        </body>
        </html>
      `);
      return;
    }

    if (url.pathname === "/globals.css") {
      const css = await fs.readFile(globalsCssPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/css" });
      res.end(css);
      return;
    }

    if (url.pathname === "/bundle.js") {
      const js = await fs.readFile(bundlePath, "utf-8");
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(js);
      return;
    }

    // Test control endpoints
    if (url.pathname === "/test/advance-version" && method === "POST") {
      if (latestPending) {
        latestPending.version += 1;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: latestPending?.version }));
      return;
    }

    if (url.pathname === "/test/set-fail-delete" && method === "POST") {
      simulateDeleteFailure = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ simulateDeleteFailure }));
      return;
    }

    if (url.pathname === "/test/clear-fail-delete" && method === "POST") {
      simulateDeleteFailure = false;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ simulateDeleteFailure }));
      return;
    }

    // API endpoints
    if (url.pathname === "/api/meals/pending" && method === "GET") {
      if (latestPending && !latestPending.confirmed && !latestPending.cancelledAt) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pending: latestPending }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pending: null }));
      }
      return;
    }

    // GET /api/meals/pending/:id
    if (url.pathname.startsWith("/api/meals/pending/") && !url.pathname.endsWith("/confirm") && method === "GET") {
      const id = url.pathname.replace("/api/meals/pending/", "");
      if (latestPending && latestPending.id === id && !latestPending.cancelledAt) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(latestPending));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Pending meal not found" }));
      }
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsedBody: any = {};
      try { if (body) parsedBody = JSON.parse(body); } catch {}

      if (url.pathname === "/api/meals/estimate" && method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          estimate: {
            label: "Grilled chicken, rice and broccoli",
            items: [
              { name: "Grilled chicken breast", portionDescription: "1 breast (200g)", calories: 200, proteinG: 38, carbsG: 0, fatG: 4, fiberG: 0 },
              { name: "Steamed white rice", portionDescription: "1 bowl (180g)", calories: 250, proteinG: 5, carbsG: 53, fatG: 1, fiberG: 1 },
              { name: "Steamed broccoli", portionDescription: "1 cup (150g)", calories: 150, proteinG: 7, carbsG: 20, fatG: 3, fiberG: 6 },
            ],
            calories: { best: 600, low: 540, high: 660 },
            macros: { proteinG: 50, carbsG: 73, fatG: 8, fiberG: 7 },
            confidence: "high",
            uncertaintyReasons: [],
          },
        }));
        return;
      }

      if (url.pathname === "/api/meals/pending" && method === "POST") {
        const id = `pend_${Date.now()}`;
        latestPending = {
          id,
          label: parsedBody.label || "Meal Draft",
          items: parsedBody.items || [],
          caloriesBest: parsedBody.calories?.best ?? parsedBody.caloriesBest ?? 600,
          caloriesLow: parsedBody.calories?.low ?? parsedBody.caloriesLow ?? 540,
          caloriesHigh: parsedBody.calories?.high ?? parsedBody.caloriesHigh ?? 660,
          proteinG: parsedBody.macros?.proteinG ?? parsedBody.proteinG ?? 50,
          carbsG: parsedBody.macros?.carbsG ?? parsedBody.carbsG ?? 73,
          fatG: parsedBody.macros?.fatG ?? parsedBody.fatG ?? 8,
          fiberG: parsedBody.macros?.fiberG ?? parsedBody.fiberG ?? 7,
          confidence: parsedBody.confidence || "high",
          uncertaintyReasons: parsedBody.uncertaintyReasons || [],
          source: parsedBody.source || "text",
          rawUserText: parsedBody.rawUserText || null,
          occurredAt: parsedBody.occurredAt || new Date().toISOString(),
          idempotencyKey: parsedBody.idempotencyKey || `key_${Date.now()}`,
          confirmed: false,
          cancelledAt: null,
          version: 1,
        };
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(latestPending));
        return;
      }

      if (url.pathname.startsWith("/api/meals/pending/") && !url.pathname.endsWith("/confirm") && method === "PATCH") {
        const id = url.pathname.replace("/api/meals/pending/", "");
        if (!latestPending || latestPending.id !== id) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Pending meal not found" }));
          return;
        }

        if (simulateServerVersionAdvance) {
          simulateServerVersionAdvance = false;
          latestPending.version += 1;
        }

        if (parsedBody.expectedVersion !== undefined && latestPending.version !== parsedBody.expectedVersion) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Draft version mismatch: server version is ${latestPending.version}, expected ${parsedBody.expectedVersion}` }));
          return;
        }

        latestPending.version += 1;
        if (parsedBody.items) latestPending.items = parsedBody.items;
        if (parsedBody.caloriesBest !== undefined) latestPending.caloriesBest = parsedBody.caloriesBest;
        if (parsedBody.caloriesLow !== undefined) latestPending.caloriesLow = parsedBody.caloriesLow;
        if (parsedBody.caloriesHigh !== undefined) latestPending.caloriesHigh = parsedBody.caloriesHigh;
        if (parsedBody.proteinG !== undefined) latestPending.proteinG = parsedBody.proteinG;
        if (parsedBody.carbsG !== undefined) latestPending.carbsG = parsedBody.carbsG;
        if (parsedBody.fatG !== undefined) latestPending.fatG = parsedBody.fatG;
        if (parsedBody.fiberG !== undefined) latestPending.fiberG = parsedBody.fiberG;
        if (parsedBody.occurredAt !== undefined) latestPending.occurredAt = parsedBody.occurredAt;
        if (parsedBody.rawUserText !== undefined) latestPending.rawUserText = parsedBody.rawUserText;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(latestPending));
        return;
      }

      if (url.pathname.startsWith("/api/meals/pending/") && url.pathname.endsWith("/confirm") && method === "POST") {
        const id = url.pathname.replace("/api/meals/pending/", "").replace("/confirm", "");
        if (!latestPending || latestPending.id !== id) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Pending meal not found" }));
          return;
        }

        if (parsedBody.expectedVersion !== undefined && latestPending.version !== parsedBody.expectedVersion) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Draft version mismatch on confirm: server version is ${latestPending.version}, expected ${parsedBody.expectedVersion}` }));
          return;
        }

        latestPending.confirmed = true;
        const confirmedMeal = {
          id: `meal_${Date.now()}`,
          userId: "user_1",
          pendingId: id,
          label: latestPending.label,
          caloriesBest: latestPending.caloriesBest,
          caloriesLow: latestPending.caloriesLow,
          caloriesHigh: latestPending.caloriesHigh,
          proteinG: latestPending.proteinG,
          carbsG: latestPending.carbsG,
          fatG: latestPending.fatG,
          fiberG: latestPending.fiberG,
          confidence: latestPending.confidence,
          source: latestPending.source,
          occurredAt: parsedBody.occurredAt || latestPending.occurredAt,
          idempotencyKey: parsedBody.idempotencyKey || `confirmed_${id}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          items: latestPending.items,
        };
        confirmedMeals.push(confirmedMeal);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(confirmedMeal));
        return;
      }

      if (url.pathname.startsWith("/api/meals/pending/") && method === "DELETE") {
        const id = url.pathname.replace("/api/meals/pending/", "");
        if (simulateDeleteFailure) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Database failure while discarding draft" } }));
          return;
        }

        if (latestPending && latestPending.id === id) {
          latestPending.cancelledAt = new Date().toISOString();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, id }));
        return;
      }

      if (url.pathname === "/api/food-presets" && method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          presets: [
            {
              id: "preset_1",
              name: "Oatmeal with whey & berries",
              label: "Oatmeal with whey & berries",
              caloriesBest: 450,
              caloriesLow: 420,
              caloriesHigh: 480,
              proteinG: 35,
              carbsG: 60,
              fatG: 7,
              fiberG: 9,
              confidence: "high",
            },
          ],
        }));
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });
  });

  return server;
}

class ChromeClient {
  private ws: WebSocket;
  private messageId = 0;
  private pending = new Map<number, (res: any) => void>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.method === "Runtime.exceptionThrown") {
          console.error("[Browser Exception]", JSON.stringify(msg.params?.exceptionDetails));
        }
        if (msg.method === "Runtime.consoleAPICalled") {
          console.log("[Browser Console]", JSON.stringify(msg.params?.args));
        }
        if (msg.id && this.pending.has(msg.id)) {
          const resolver = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          resolver(msg);
        }
      } catch {}
    };
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.messageId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string): Promise<any> {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result?.result?.value;
  }

  async captureScreenshot(filename: string) {
    const res = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    const buffer = Buffer.from(res.result.data, "base64");
    const outPath = path.join(SCREENSHOT_DIR, filename);
    await fs.writeFile(outPath, buffer);
    console.log(`[Screenshot saved] ${outPath}`);
  }

  async waitFor(expression: string, timeoutMs = 8000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const val = await this.evaluate(expression);
      if (val) return val;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for expression: ${expression}`);
  }

  async setInputValue(selector: string, value: string, isTextarea = false) {
    const proto = isTextarea ? "HTMLTextAreaElement" : "HTMLInputElement";
    const result = await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) {
          throw new Error("Element not found for selector: " + ${JSON.stringify(selector)});
        }
        const setter = Object.getOwnPropertyDescriptor(window.${proto}.prototype, "value")?.set;
        if (setter) {
          setter.call(el, ${JSON.stringify(value)});
        } else {
          el.value = ${JSON.stringify(value)};
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()
    `);
    if (!result) {
      throw new Error(`Failed setting input value on ${selector}`);
    }
  }

  async setViewport(width: number, height: number, isMobile = false) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: isMobile,
    });
  }
}

async function main() {
  if (process.argv.includes("--serve")) {
    console.log("Building harness bundle...");
    const bundlePath = await buildHarness();
    console.log("Starting preview server on port " + PORT);
    const server = createMockServer(bundlePath);
    await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", () => resolve()));
    console.log(`ClawFit Frontend Preview Server running at http://localhost:${PORT}/meals/log`);
    return new Promise(() => {});
  }

  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });

  console.log("1. Building harness bundle...");
  const bundlePath = await buildHarness();

  console.log("2. Starting mock server on port " + PORT);
  const server = createMockServer(bundlePath);
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", () => resolve()));

  const tempProfileDir = path.join(os.tmpdir(), `clawfit-chrome-${Date.now()}`);
  await fs.mkdir(tempProfileDir, { recursive: true });

  console.log("3. Launching Chrome headless...");
  const chromeProc: ChildProcess = spawn(
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${tempProfileDir}`,
      "--window-size=1280,960",
      "--disable-gpu",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { stdio: "ignore" },
  );

  try {
    let wsUrl: string | null = null;
    for (let i = 0; i < 30; i++) {
      try {
        const createRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?http://127.0.0.1:${PORT}/meals/log`, { method: "PUT" });
        if (createRes.ok) {
          const tab = (await createRes.json()) as any;
          if (tab?.webSocketDebuggerUrl) {
            wsUrl = tab.webSocketDebuggerUrl;
            break;
          }
        }
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
        if (res.ok) {
          const list = (await res.json()) as any[];
          const page = list.find((t: any) => t.type === "page" && t.webSocketDebuggerUrl);
          if (page) {
            wsUrl = page.webSocketDebuggerUrl;
            break;
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!wsUrl) throw new Error("Could not connect to Chrome CDP WebSocket");

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => { ws.onopen = resolve; });
    const cdp = new ChromeClient(ws);

    await cdp.send("Page.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Runtime.enable");

    // 1. Initial page load (Desktop 1280x960)
    console.log("4. Navigating to meal log flow (desktop 1280x960)...");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/meals/log` });
    await cdp.waitFor('document.getElementById("meal-text-input") !== null');
    await new Promise((r) => setTimeout(r, 500));
    await cdp.captureScreenshot("01-initial-estimate-form.png");

    // 2. Fill AI description and estimate
    console.log("5. Estimating 600 kcal meal...");
    await cdp.setInputValue("#meal-text-input", "Grilled chicken, rice and broccoli", true);
    await new Promise((r) => setTimeout(r, 200));
    await cdp.evaluate(`
      const btn = document.querySelector(".estimate-submit-btn");
      btn.click();
    `);

    // Wait for review panel
    await cdp.waitFor('document.querySelector(".meal-review-panel") !== null');
    const calText = await cdp.evaluate('document.querySelector(".review-energy-hero strong")?.textContent');
    console.log(`Review panel displayed: ${calText} kcal`);
    await new Promise((r) => setTimeout(r, 300));
    await cdp.captureScreenshot("02-ai-draft-reviewed.png");

    // 3. Halve first item (Grilled chicken breast: 200 kcal -> 100 kcal, meal drops from 600 to 500)
    console.log("6. Halving 200 kcal chicken item to 100 kcal...");
    await cdp.evaluate(`
      const halveBtn = document.querySelectorAll(".item-scaling-controls button")[0];
      halveBtn.click();
    `);

    // Wait for server patch to complete and draft to update to 500 kcal
    await cdp.waitFor('document.querySelector(".review-energy-hero strong")?.textContent === "500"');
    console.log("Energy successfully scaled to 500 kcal (server acknowledged)");
    await new Promise((r) => setTimeout(r, 300));
    await cdp.captureScreenshot("03-portion-halved-to-500.png");

    // 4. Update time to 14:30 and add notes
    console.log("7. Updating time to 14:30 and adding preparation notes...");
    await cdp.setInputValue('input[type="time"]', "14:30", false);
    await cdp.setInputValue("#meal-notes-input", "Cooked in olive oil, extra garlic", false);
    // Wait for debounced sync to persist time and notes to server
    await new Promise((r) => setTimeout(r, 700));
    // Verify notes are rendered in .review-notes-box
    await cdp.waitFor('document.querySelector(".review-notes-box") !== null');
    await cdp.captureScreenshot("04-time-and-notes-updated.png");

    // 5. Reload page and verify state restoration
    console.log("8. Reloading page to verify persistence and recovery...");
    await cdp.send("Page.reload");
    await cdp.waitFor('document.querySelector(".review-energy-hero strong")?.textContent === "500"');
    const restoredTime = await cdp.evaluate('document.querySelector(\'input[type="time"]\')?.value');
    console.log(`Draft restored: 500 kcal, occurredAt time: ${restoredTime}`);
    await new Promise((r) => setTimeout(r, 400));
    await cdp.captureScreenshot("05-restored-after-refresh.png");

    // 6. Test 409 Conflict Handling on Revision
    console.log("9. Simulating concurrent version advancement and testing 409 conflict handling...");
    // Advance version on server to simulate external/metadata change (version 2 -> 3)
    await fetch(`http://127.0.0.1:${PORT}/test/advance-version`, { method: "POST" });

    // Enter revision prompt
    await cdp.setInputValue("#refine-input", "skinless chicken, add hot sauce", false);
    await new Promise((r) => setTimeout(r, 200));

    // Click Re-estimate
    await cdp.evaluate(`
      const reEstBtn = document.querySelectorAll(".refine-input-row button")[0];
      reEstBtn.click();
    `);

    // Wait for error notice to appear
    await cdp.waitFor('document.querySelector(".meal-error-alert") !== null');
    const errorNotice = await cdp.evaluate('document.querySelector(".meal-error-alert")?.textContent');
    console.log(`Conflict error handled gracefully: ${errorNotice}`);

    // Verify:
    // a) Draft calories remain intact at acknowledged 500 kcal (NOT corrupted by unacknowledged revision)
    const intactCalories = await cdp.evaluate('document.querySelector(".review-energy-hero strong")?.textContent');
    if (intactCalories !== "500") {
      throw new Error(`Expected calories to remain 500, but got: ${intactCalories}`);
    }
    // b) Revision text remains in input so user can retry without re-typing
    const preservedInput = await cdp.evaluate('document.getElementById("refine-input")?.value');
    if (preservedInput !== "skinless chicken, add hot sauce") {
      throw new Error(`Expected revision text to be preserved, got: ${preservedInput}`);
    }
    console.log("Verified: Acknowledged draft preserved at 500 kcal, revision input retained for retry.");
    await new Promise((r) => setTimeout(r, 300));
    await cdp.captureScreenshot("06-revision-409-preserved.png");

    // 7. Test Discard Failure Handling
    console.log("10. Testing server-side discard failure handling...");
    // Tell mock server to fail next DELETE
    await fetch(`http://127.0.0.1:${PORT}/test/set-fail-delete`, { method: "POST" });

    // Click Discard
    await cdp.evaluate(`
      const discardBtn = document.querySelector(".discard-btn");
      discardBtn.click();
    `);

    // Wait for error notice
    await cdp.waitFor('document.querySelector(".meal-error-alert") !== null');
    // Verify draft remains on screen intact
    await cdp.waitFor('document.querySelector(".meal-review-panel") !== null');
    console.log("Verified: Server discard failure surfaces error and leaves draft intact on screen.");
    await new Promise((r) => setTimeout(r, 300));
    await cdp.captureScreenshot("07-discard-failure-intact.png");

    // Clear delete failure
    await fetch(`http://127.0.0.1:${PORT}/test/clear-fail-delete`, { method: "POST" });

    // 8. Confirm meal
    console.log("11. Confirming meal...");
    await cdp.evaluate(`
      const saveBtn = document.querySelector(".confirm-save-btn");
      saveBtn.click();
    `);
    await cdp.waitFor('document.querySelector(".meal-saved-panel") !== null');
    const savedHero = await cdp.evaluate('document.querySelector(".meal-saved-body h2")?.textContent');
    console.log(`Meal confirmed and saved: ${savedHero}`);
    await new Promise((r) => setTimeout(r, 400));
    await cdp.captureScreenshot("08-meal-confirmed-saved.png");

    // 9. Clean discard flow
    console.log("12. Testing clean discard cleanup and reload non-resurrection...");
    await cdp.evaluate(`
      const anotherBtn = document.querySelectorAll(".meal-saved-actions button")[0];
      anotherBtn.click();
    `);
    await cdp.waitFor('document.getElementById("meal-text-input") !== null');

    // Create a new draft and cleanly discard
    await cdp.setInputValue("#meal-text-input", "Snack: crisp apple", true);
    await new Promise((r) => setTimeout(r, 200));
    await cdp.evaluate(`
      document.querySelector(".estimate-submit-btn").click();
    `);
    await cdp.waitFor('document.querySelector(".meal-review-panel") !== null');
    await cdp.evaluate(`
      document.querySelector(".discard-btn").click();
    `);
    await cdp.waitFor('document.getElementById("meal-text-input") !== null');

    // Verify after reload that draft does NOT resurrect
    await cdp.send("Page.reload");
    await cdp.waitFor('document.getElementById("meal-text-input") !== null');
    await new Promise((r) => setTimeout(r, 400));
    await cdp.captureScreenshot("09-discard-cleaned-up.png");

    // 10. Manual Entry flow
    console.log("13. Testing manual entry flow...");
    await cdp.evaluate(`
      const manualBtn = document.querySelectorAll(".meta-mode-switch button")[1];
      manualBtn.click();
    `);
    await cdp.waitFor('document.getElementById("manual-label-input") !== null');
    await cdp.setInputValue("#manual-label-input", "Post-workout whey shake", false);
    await cdp.setInputValue("#manual-calories-input", "450", false);
    await new Promise((r) => setTimeout(r, 200));
    await cdp.evaluate(`
      const reviewBtn = document.querySelector(".estimate-submit-btn");
      reviewBtn.click();
    `);
    await cdp.waitFor('document.querySelector(".meal-review-panel") !== null');
    await new Promise((r) => setTimeout(r, 400));
    await cdp.captureScreenshot("10-manual-entry-flow.png");

    // 11. Mobile Viewport (390px) Layout Verification
    console.log("14. Verifying mobile viewport (390px width)...");
    await cdp.setViewport(390, 844, true);
    await new Promise((r) => setTimeout(r, 500));
    await cdp.captureScreenshot("11-mobile-viewport-390px.png");

    console.log("All 11 browser verification screenshots successfully captured in review-packages/2/screenshots/!");
  } finally {
    chromeProc.kill();
    server.close();
    await fs.rm(tempProfileDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.resolve("scratch"), { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("Browser verification failed:", err);
  process.exit(1);
});
