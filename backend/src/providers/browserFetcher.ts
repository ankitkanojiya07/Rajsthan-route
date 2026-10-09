import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { logInfo } from "../utils/logger.js";
import { isCloudflareChallenge } from "./parseBookingStats.js";

export type BrowserFetchOptions = {
  baseUrl: string;
  profileDir: string;
  timeoutMs: number;
  headless: boolean;
  waitForHuman?: boolean;
  onBookingPage?: (page: Page) => Promise<void>;
  /** Prefer "chrome" (installed Google Chrome). Default: chrome */
  channel?: "chrome" | "chromium";
};

export type BrowserFetchResult =
  | { ok: true; html: string; durationMs: number }
  | {
      ok: false;
      code:
        | "PLAYWRIGHT_NOT_INSTALLED"
        | "CAPTCHA_REQUIRED"
        | "TIMEOUT"
        | "BOOKING_STATS_NOT_FOUND"
        | "BROWSER_FETCH_FAILED";
      message: string;
    };

// Near Ranthambore / Sawai Madhopur — used when the site asks for location
const DEFAULT_GEO = {
  latitude: 26.0173,
  longitude: 76.5026,
  accuracy: 100,
};

async function ensureProfileDir(profileDir: string): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  // Stale locks make Chrome refuse to start ("SingletonLock: File exists")
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    await unlink(path.join(profileDir, name)).catch(() => undefined);
  }
}

/**
 * IMPORTANT: pass evaluate code as a STRING.
 * tsx injects `__name(...)` into function expressions, which crashes inside Playwright's browser.
 */
async function pageHasBookingStats(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const html = document.documentElement ? document.documentElement.outerHTML : "";
    return html.includes("bookingStats") && html.includes("visit_date");
  })()`);
}

async function dismissOkPopups(page: Page): Promise<number> {
  let clicks = 0;

  const labels = [
    "Okay!",
    "Okay",
    "OK",
    "Ok",
    "Close",
    "Don't show this message again",
    "I agree to the instructions",
  ];

  for (let round = 0; round < 6; round++) {
    let clickedThisRound = false;

    for (const label of labels) {
      const button = page.getByRole("button", { name: label, exact: false }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 2000 }).catch(() => undefined);
        clicks += 1;
        clickedThisRound = true;
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    const extra = await page.evaluate(`(() => {
      const match = (t) => /^(ok|okay!?|close|got it)$/i.test(String(t || "").trim());
      const nodes = Array.from(
        document.querySelectorAll("button, a.btn, [role='button'], .btn, input[type='button']")
      );
      let n = 0;
      for (const el of nodes) {
        const text = (el.innerText || el.textContent || el.value || "").trim();
        if (!match(text)) continue;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        el.click();
        n += 1;
      }
      return n;
    })()`);

    clicks += Number(extra) || 0;
    if (Number(extra) > 0) clickedThisRound = true;

    if (!clickedThisRound) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  return clicks;
}

async function allowLocation(context: BrowserContext, origin: string): Promise<void> {
  await context.grantPermissions(["geolocation"], { origin });
  await context.setGeolocation(DEFAULT_GEO);
}

async function launchChromeContext(
  playwright: typeof import("playwright"),
  profileDir: string,
  headless: boolean,
  preferredChannel: "chrome" | "chromium",
): Promise<{ context: BrowserContext; channelUsed: string }> {
  const common = {
    headless,
    viewport: { width: 1365, height: 900 } as const,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--use-fake-ui-for-media-stream",
    ],
    ignoreDefaultArgs: ["--enable-automation"] as string[],
  };

  if (preferredChannel === "chrome") {
    try {
      const context = await playwright.chromium.launchPersistentContext(profileDir, {
        ...common,
        channel: "chrome",
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      });
      return { context, channelUsed: "chrome" };
    } catch {
      try {
        const context = await playwright.chromium.launchPersistentContext(profileDir, {
          ...common,
          channel: "chrome",
        });
        return { context, channelUsed: "chrome" };
      } catch (err) {
        console.warn(
          "Google Chrome launch failed, falling back to Playwright Chromium:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  const context = await playwright.chromium.launchPersistentContext(profileDir, {
    ...common,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  return { context, channelUsed: "chromium" };
}

/**
 * Loads the official booking page in Google Chrome (persistent profile).
 * Location permission is granted for the booking origin.
 */
export async function fetchBookingPageViaBrowser(
  options: BrowserFetchOptions,
): Promise<BrowserFetchResult> {
  const started = Date.now();
  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    return {
      ok: false,
      code: "PLAYWRIGHT_NOT_INSTALLED",
      message:
        "Playwright is not installed. Run: npm install playwright && npx playwright install chromium",
    };
  }

  const profileDir = path.resolve(options.profileDir);
  await ensureProfileDir(profileDir);

  const url = options.baseUrl.replace(/\/$/, "") + "/";
  const origin = new URL(url).origin;
  const waitForHuman = options.waitForHuman === true;
  const timeoutMs = waitForHuman
    ? Math.max(options.timeoutMs, 300_000)
    : options.timeoutMs;
  const preferredChannel = options.channel ?? "chrome";

  try {
    const { context, channelUsed } = await launchChromeContext(
      playwright,
      profileDir,
      options.headless,
      preferredChannel,
    );

    console.log(`Using browser channel: ${channelUsed}`);

    try {
      await allowLocation(context, origin);

      const page = context.pages()[0] ?? (await context.newPage());
      await page.addInitScript(
        `Object.defineProperty(navigator, "webdriver", { get: () => undefined });`,
      );

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(timeoutMs, 60_000),
      });

      await new Promise((r) => setTimeout(r, 1500));
      let dismissed = await dismissOkPopups(page);
      if (dismissed > 0) {
        console.log(`Dismissed ${dismissed} popup button(s) (OK / Okay / Close).`);
      }

      let found = await pageHasBookingStats(page);

      if (!found && waitForHuman) {
        console.log("");
        console.log(">>> Google Chrome window is open.");
        console.log(">>> Location is allowed for this site.");
        console.log(">>> If Cloudflare Verify appears — click it.");
        console.log(">>> OK / Okay popups are clicked automatically.");
        console.log(">>> Waiting until Availability Chart loads…");
        console.log("");

        const deadline = Date.now() + timeoutMs;
        let lastLog = 0;
        while (!found && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          dismissed += await dismissOkPopups(page);
          found = await pageHasBookingStats(page);
          const elapsed = Math.round((Date.now() - started) / 1000);
          if (Date.now() - lastLog > 10_000) {
            console.log(
              `… still waiting (${elapsed}s). Finish Cloudflare if needed; OK popups are handled automatically.`,
            );
            lastLog = Date.now();
          }
        }
      } else if (!found) {
        const deadline = Date.now() + timeoutMs;
        while (!found && Date.now() < deadline) {
          await dismissOkPopups(page);
          found = await pageHasBookingStats(page);
          if (found) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      dismissed += await dismissOkPopups(page);
      const html = await page.content();
      if (found && options.onBookingPage) {
        await options.onBookingPage(page);
      }
      const durationMs = Date.now() - started;

      logInfo("browser_fetch_complete", {
        url,
        durationMs,
        htmlBytes: html.length,
        bookingStatsFound: found,
        headless: options.headless,
        waitForHuman,
        popupsDismissed: dismissed,
        channelUsed,
        geolocationGranted: true,
      });

      if (!found || isCloudflareChallenge(200, html)) {
        return {
          ok: false,
          code: "CAPTCHA_REQUIRED",
          message: waitForHuman
            ? "Timed out waiting for the booking page. Click Cloudflare Verify if shown; OK popups are auto-clicked. Wait until Availability Chart appears."
            : "Cloudflare verification is required. Run: npm run forest:login — complete verification in the window, then try Fetch again.",
        };
      }

      return { ok: true, html, durationMs };
    } finally {
      await context.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(message)) {
      return {
        ok: false,
        code: "TIMEOUT",
        message: "Browser fetch timed out waiting for the booking page.",
      };
    }
    return {
      ok: false,
      code: "BROWSER_FETCH_FAILED",
      message,
    };
  }
}
