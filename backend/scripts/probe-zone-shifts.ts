/**
 * Headed probe: open Zone booking page and capture Morning/Afternoon ticket seats.
 * If Cloudflare appears, wait for you to click Verify (same as forest:login).
 */
import "dotenv/config";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page, type Response } from "playwright";

const baseUrl = (process.env.FOREST_API_BASE_URL ?? "https://booking.forestrajasthan.com").replace(
  /\/$/,
  "",
);
const profileDir = path.resolve(
  process.env.FOREST_BROWSER_PROFILE_DIR ?? "./.forest-browser-profile",
);
const outDir = path.resolve("./.forest-cache/zone-probe");
const targetZone = process.env.PROBE_ZONE ?? "Zone 2";
const waitMs = Number(process.env.PROBE_WAIT_MS ?? 180_000);

type Captured = {
  url: string;
  method: string;
  status: number;
  requestBody?: string;
  responseBody?: string;
};

const captures: Captured[] = [];

async function ensureProfileDir(dir: string) {
  await mkdir(dir, { recursive: true });
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    await unlink(path.join(dir, name)).catch(() => undefined);
  }
}

async function dismissOk(page: Page) {
  for (let i = 0; i < 8; i++) {
    if (page.isClosed()) return;
    const n = await page
      .evaluate(`(() => {
        const match = (t) => /^(ok|okay!?|close|got it)$/i.test(String(t || "").trim());
        let c = 0;
        for (const el of document.querySelectorAll("button, a.btn, [role='button'], .btn, input[type='button']")) {
          const text = (el.innerText || el.textContent || el.value || "").trim();
          if (!match(text)) continue;
          el.click();
          c++;
        }
        return c;
      })()`)
      .catch(() => 0);
    if (!n) break;
    await page.waitForTimeout(300).catch(() => undefined);
  }
}

function attachCapture(page: Page) {
  page.on("response", async (res: Response) => {
    const url = res.url();
    if (!/booking\.forestrajasthan\.com\/(sch|seats)\//i.test(url)) return;
    const req = res.request();
    let responseBody: string | undefined;
    try {
      responseBody = await res.text();
    } catch {
      responseBody = undefined;
    }
    captures.push({
      url,
      method: req.method(),
      status: res.status(),
      requestBody: req.postData() ?? undefined,
      responseBody,
    });
    console.log("API", res.status(), req.method(), url);
    console.log("  req", req.postData());
    console.log("  res", (responseBody || "").slice(0, 300));
  });
}

async function waitForHome(page: Page): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  let lastLog = 0;
  while (Date.now() < deadline) {
    await dismissOk(page);
    const state = await page
      .evaluate(`(() => {
        const t = document.body ? document.body.innerText : "";
        const cf = /Verifying your connection|Verify you are human/i.test(t);
        const home = /Book Now/i.test(t) && /Zone\\s*1/i.test(t);
        return { cf, home, snippet: t.slice(0, 120) };
      })()`)
      .catch(() => ({ cf: true, home: false, snippet: "" }));
    if (state.home) return true;
    if (Date.now() - lastLog > 8_000) {
      console.log(state.cf ? ">>> Cloudflare — click Verify you are human in the Chrome window…" : `… waiting (${state.snippet})`);
      lastLog = Date.now();
    }
    await page.waitForTimeout(1500).catch(() => undefined);
  }
  return false;
}

async function scrapeZoneTickets(page: Page) {
  return page.evaluate(`(() => {
    const body = document.body ? document.body.innerText : "";
    const tickets = [];
    // Prefer nodes that look like ticket cards with Morning/Afternoon
    const nodes = Array.from(document.querySelectorAll("button, div, a, li, label, span"));
    for (const el of nodes) {
      const raw = (el.innerText || "").trim();
      if (!raw || raw.length > 90) continue;
      const t = raw.replace(/\\s+/g, " ");
      const shiftMatch = t.match(/\\b(Morning|Afternoon)\\b/i);
      if (!shiftMatch) continue;
      const vehicleMatch = t.match(/\\b(Gypsy|Canter)\\b/i);
      const typeMatch = t.match(/\\b(Tatkal|Advance|Current|Premium)\\b/i);
      // Seat badge: trailing number or circled count
      let seats = null;
      const badge = t.match(/(?:^|\\s)(\\d{1,3})(?:\\s*)$/);
      const embedded = t.match(/\\b(\\d{1,3})\\b(?!.*(Morning|Afternoon))/i);
      // Look for child badge
      const childNums = Array.from(el.querySelectorAll("*"))
        .map((c) => (c.textContent || "").trim())
        .filter((x) => /^\\d{1,3}$/.test(x));
      if (childNums.length) seats = Number(childNums[childNums.length - 1]);
      else if (badge) seats = Number(badge[1]);

      const style = window.getComputedStyle(el);
      const disabled =
        el.matches(":disabled") ||
        el.getAttribute("aria-disabled") === "true" ||
        /disabled|unavailable|grey|gray/i.test(el.className || "") ||
        style.pointerEvents === "none";

      const data = {};
      for (const a of el.attributes || []) {
        if (a.name.startsWith("data-")) data[a.name] = a.value;
      }

      if (!vehicleMatch && !typeMatch && t.split(" ").length > 8) continue;

      tickets.push({
        text: t,
        shift: shiftMatch[1].toLowerCase(),
        vehicle: vehicleMatch ? vehicleMatch[1].toLowerCase() : null,
        ticketType: typeMatch ? typeMatch[1].toLowerCase() : null,
        seats,
        disabled,
        tag: el.tagName,
        className: String(el.className || "").slice(0, 100),
        data,
      });
    }

    // Dedupe by text
    const seen = new Set();
    const uniq = [];
    for (const t of tickets) {
      if (seen.has(t.text)) continue;
      seen.add(t.text);
      uniq.push(t);
    }

    // Aggregate available seats by shift (active/non-disabled with seats)
    const byShift = { morning: 0, afternoon: 0 };
    for (const t of uniq) {
      if (t.seats == null) continue;
      if (t.disabled && t.seats === 0) continue;
      if (t.shift === "morning") byShift.morning += t.seats;
      if (t.shift === "afternoon") byShift.afternoon += t.seats;
    }

    return {
      url: location.href,
      hasMorning: /Morning/i.test(body),
      hasAfternoon: /Afternoon/i.test(body),
      byShift,
      tickets: uniq.slice(0, 60),
      lines: body.split("\\n").map((s) => s.trim()).filter(Boolean).slice(0, 80),
    };
  })()`);
}

async function main() {
  await ensureProfileDir(profileDir);
  await mkdir(outDir, { recursive: true });

  console.log("══════════════════════════════════════");
  console.log(" Zone Morning/Afternoon probe (headed)");
  console.log("══════════════════════════════════════");
  console.log("If Cloudflare shows — click Verify in the Chrome window.");
  console.log("Target zone:", targetZone);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: "chrome",
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    viewport: { width: 1400, height: 950 },
    args: ["--disable-blink-features=AutomationControlled", "--use-fake-ui-for-media-stream"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  await context.grantPermissions(["geolocation"], { origin: baseUrl });
  await context.setGeolocation({ latitude: 26.0173, longitude: 76.5026, accuracy: 100 });
  context.on("page", (p) => attachCapture(p));

  const page = context.pages()[0] ?? (await context.newPage());
  attachCapture(page);
  await page.addInitScript(
    `Object.defineProperty(navigator, "webdriver", { get: () => undefined });`,
  );

  await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  const ok = await waitForHome(page);
  if (!ok) {
    await page.screenshot({ path: path.join(outDir, "failed-home.png"), fullPage: true });
    console.error("Timed out waiting for booking home (Cloudflare?).");
    await context.close();
    process.exit(2);
  }
  console.log("Home loaded.");
  await dismissOk(page);

  // Click Book Now on target zone card
  const zoneNum = targetZone.replace(/\D/g, "") || "2";
  const book = page
    .locator("div, article, section, li")
    .filter({ hasText: new RegExp(`Zone\\s*${zoneNum}\\b`, "i") })
    .filter({ hasText: /Book Now/i })
    .getByText(/Book Now!?/i)
    .first();

  console.log("Clicking Book Now for", targetZone);
  await book.scrollIntoViewIfNeeded().catch(() => undefined);
  await book.click({ timeout: 10_000 });
  await page.waitForTimeout(2500);
  await dismissOk(page);

  // Wait for Morning/Afternoon ticket grid
  for (let i = 0; i < 20; i++) {
    const ready = await page
      .evaluate(`(() => /Morning/i.test(document.body.innerText) && /Afternoon/i.test(document.body.innerText))()`)
      .catch(() => false);
    if (ready) break;
    await dismissOk(page);
    await page.waitForTimeout(700);
  }

  const scraped = await scrapeZoneTickets(page);
  await page.screenshot({ path: path.join(outDir, "zone-detail.png"), fullPage: true });
  await writeFile(path.join(outDir, "zone-tickets.json"), JSON.stringify(scraped, null, 2));
  await writeFile(path.join(outDir, "schedule-apis.json"), JSON.stringify(captures, null, 2));

  console.log("URL:", scraped.url);
  console.log("Morning/Afternoon present:", scraped.hasMorning, scraped.hasAfternoon);
  console.log("Shift totals:", scraped.byShift);
  console.log("Tickets:", scraped.tickets.length);
  for (const t of scraped.tickets.slice(0, 20)) {
    console.log(" -", t.text, "| seats=", t.seats, "disabled=", t.disabled);
  }
  console.log("API captures:", captures.length);
  console.log("Wrote", outDir);

  await context.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
