import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type {
  SafariTicketCategory,
  ShiftDaySnapshot,
  ZoneShiftSeats,
} from "../cache/shiftStore.js";
import { logInfo } from "../utils/logger.js";

export type ZoneShiftScrapeOptions = {
  baseUrl: string;
  profileDir: string;
  date: string; // YYYY-MM-DD
  timeoutMs: number;
  headless: boolean;
  channel?: "chrome" | "chromium";
  /** Limit how many zones to open (default 10). */
  maxZones?: number;
  /** Delay between zones to reduce 429s. */
  pauseMs?: number;
};

export type ZoneShiftScrapeResult =
  | { ok: true; snapshot: ShiftDaySnapshot; durationMs: number }
  | {
      ok: false;
      code: "PLAYWRIGHT_NOT_INSTALLED" | "CAPTCHA_REQUIRED" | "TIMEOUT" | "SCRAPE_FAILED";
      message: string;
    };

type TicketSeatRecord = {
  shift: "morning" | "afternoon";
  vehicle: "canter" | "gypsy";
  category: SafariTicketCategory | null;
  seats: number;
};

const DEFAULT_GEO = {
  latitude: 26.0173,
  longitude: 76.5026,
  accuracy: 100,
};

async function ensureProfileDir(profileDir: string): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    await unlink(path.join(profileDir, name)).catch(() => undefined);
  }
}

async function dismissOk(page: Page): Promise<void> {
  for (let round = 0; round < 6; round++) {
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

async function waitForBookingHome(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await dismissOk(page);
    const ready = await page
      .evaluate(`(() => {
        const t = document.body ? document.body.innerText : "";
        if (/Verifying your connection|Verify you are human/i.test(t)) return false;
        return /Book Now/i.test(t) && /Zone\\s*1/i.test(t);
      })()`)
      .catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(1200).catch(() => undefined);
  }
  return false;
}

/** Select a calendar day card for YYYY-MM-DD on the booking home strip. */
async function selectDate(page: Page, isoDate: string): Promise<boolean> {
  const d = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  const day = String(d.getDate());
  const mon = d
    .toLocaleString("en-US", { month: "short" })
    .toUpperCase()
    .slice(0, 3); // OCT / NOV

  const result = await page.evaluate<{ selected: boolean; candidates: string[] }>(`((args) => {
    const day = args.day;
    const mon = args.mon;
    const nodes = Array.from(document.querySelectorAll("button, [role='button'], a, li, div"));
    const candidates = nodes
      .filter((el) => {
        const text = (el.innerText || "").replace(/\\s+/g, " ").trim();
        const normalized = text.replace(/[^a-z0-9]/gi, "").toUpperCase();
        return text.length <= 32 &&
          (normalized.startsWith(day + mon) || normalized.startsWith(mon + day));
      })
      .sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
    const target = candidates[0];
    if (!target) {
      return {
        selected: false,
        candidates: nodes
          .map((el) => (el.innerText || "").replace(/\\s+/g, " ").trim())
          .filter((text) => text.length <= 32 && /\\d/.test(text) && /[A-Z]{3}/i.test(text))
          .slice(0, 12),
      };
    }
    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
    return { selected: true, candidates: [] };
  })(${JSON.stringify({ day, mon })})`);
  if (!result.selected) {
    logInfo("zone_shift_calendar_date_not_found", {
      day,
      month: mon,
      candidates: result.candidates,
    });
  }
  return result.selected;
}

/**
 * Parse ticket counts by Morning/Afternoon, Canter/Gypsy, and ticket category.
 */
async function scrapeOpenZoneTickets(page: Page): Promise<ZoneShiftSeats | null> {
  const records = await page.evaluate<TicketSeatRecord[] | null>(`(() => {
    const body = document.body ? document.body.innerText : "";
    if (!/Morning/i.test(body) || !/Afternoon/i.test(body)) return null;

    const classify = (text) => {
      const morning = /\\bMorning\\b/i.test(text);
      const afternoon = /\\bAfternoon\\b/i.test(text);
      const canter = /\\bCanter\\b/i.test(text);
      const gypsy = /\\bGypsy\\b/i.test(text);
      if (morning === afternoon || canter === gypsy) return null;
      const ticketCategory = /\\bTatkal\\b/i.test(text)
        ? "tatkal"
        : /\\bAdvance\\b/i.test(text)
          ? "advance"
          : /\\bCurrent\\b/i.test(text)
            ? "current"
            : /\\bPremium\\b/i.test(text)
              ? "premium"
              : null;
      return {
        shift: morning ? "morning" : "afternoon",
        vehicle: canter ? "canter" : "gypsy",
        category: ticketCategory,
      };
    };
    const seatNumbers = (el) => Array.from(el.querySelectorAll("span, strong, b, small, label"))
      .map((n) => (n.innerText || n.textContent || "").trim())
      .filter((x) => /^\\d{1,3}$/.test(x))
      .map(Number);
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };

    const candidates = Array.from(
      document.querySelectorAll("button, a, [role='button'], li, label, div"),
    )
      .filter(visible)
      .map((el) => ({
        el,
        text: (el.innerText || "").replace(/\\s+/g, " ").trim(),
      }))
      .filter(({ text }) => text.length > 0 && text.length <= 100)
      .map((candidate) => ({ ...candidate, category: classify(candidate.text) }))
      .filter((candidate) => candidate.category !== null);

    const ticketCards = candidates.filter(({ el, category }) => {
      const childHasTicketCount = Array.from(
        el.querySelectorAll("button, a, [role='button'], li, label, div"),
      ).some((child) => {
        const childCategory = classify((child.innerText || "").replace(/\\s+/g, " ").trim());
        return childCategory?.shift === category.shift &&
          childCategory?.vehicle === category.vehicle &&
          childCategory?.category === category.category &&
          seatNumbers(child).length > 0;
      });
      return !childHasTicketCount;
    });

    return ticketCards.map(({ el, category }) => {
      const nums = seatNumbers(el);
      return {
        shift: category.shift,
        vehicle: category.vehicle,
        category: category.category,
        seats: nums.length > 0 ? nums[nums.length - 1] : 0,
      };
    });
  })()`);

  return records ? sumTicketAvailability(records) : null;
}

function sumTicketAvailability(records: TicketSeatRecord[]): ZoneShiftSeats | null {
  if (records.length === 0) return null;
  const result: ZoneShiftSeats = {
    morning: { canter: null, gypsy: null },
    afternoon: { canter: null, gypsy: null },
  };
  for (const { shift, vehicle, seats } of records) {
    const bucket = result[shift];
    if (typeof bucket === "number" || bucket === null) continue;
    bucket[vehicle] = (bucket[vehicle] ?? 0) + seats;
  }
  for (const { shift, vehicle, category, seats } of records) {
    if (category === null) continue;
    const bucket = result[shift];
    if (typeof bucket === "number" || bucket === null) continue;
    const categoriesKey = vehicle === "canter" ? "canterCategories" : "gypsyCategories";
    const categories = bucket[categoriesKey] ?? [];
    const existing = categories.find((item) => item.category === category);
    if (existing) {
      existing.seats += seats;
    } else {
      categories.push({ category, seats });
    }
    bucket[categoriesKey] = categories;
  }
  return result;
}

async function clickZoneBookNow(page: Page, zoneLabel: string): Promise<boolean> {
  const zoneNum = zoneLabel.replace(/\D/g, "");
  const marked = await page.evaluate<boolean>(`((zoneNum) => {
    const zonePattern = new RegExp("\\\\bZone\\\\s*" + zoneNum + "\\\\b", "i");
    const controls = Array.from(document.querySelectorAll("button, a, [role='button'], .btn"))
      .filter((el) => /^Book Now!?$/i.test((el.innerText || el.textContent || "").trim()));
    let target = null;
    let targetLength = Number.POSITIVE_INFINITY;
    for (const control of controls) {
      let card = control.parentElement;
      for (let depth = 0; card && depth < 8; depth++, card = card.parentElement) {
        const text = (card.innerText || "").replace(/\\s+/g, " ").trim();
        if (!zonePattern.test(text) || text.length >= targetLength) continue;
        target = control;
        targetLength = text.length;
      }
    }
    if (!target) return false;
    target.setAttribute("data-rtr-zone-book", zoneNum);
    target.scrollIntoView({ block: "center" });
    return true;
  })(${JSON.stringify(zoneNum)})`);
  if (!marked) return false;
  const control = page.locator(`[data-rtr-zone-book="${zoneNum}"]`);
  try {
    await control.click({ timeout: 5000 });
    await control.evaluate((el) => el.removeAttribute("data-rtr-zone-book"));
    return true;
  } catch (error) {
    logInfo("zone_shift_book_click_failed", {
      zone: zoneLabel,
      error: error instanceof Error ? error.message : String(error),
    });
    await control.evaluate((el) => el.removeAttribute("data-rtr-zone-book")).catch(() => undefined);
    return false;
  }
}

async function clickBack(page: Page): Promise<void> {
  // Official zone page has a circular back arrow bottom-left
  const went = await page.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll("button, a, div[role='button']"));
    for (const el of buttons) {
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      if (aria.includes("back") || aria.includes("close")) {
        el.click();
        return true;
      }
    }
    // Heuristic: round control near bottom-left
    for (const el of buttons) {
      const r = el.getBoundingClientRect();
      if (r.width > 28 && r.width < 72 && r.height > 28 && r.height < 72 && r.left < 120 && r.bottom > window.innerHeight - 140) {
        el.click();
        return true;
      }
    }
    return false;
  })()`);
  if (!went) {
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  await page.waitForTimeout(900).catch(() => undefined);
  await dismissOk(page);
}

export async function scrapeZoneShiftsOnPage(
  page: Page,
  date: string,
  options: Partial<Pick<ZoneShiftScrapeOptions, "maxZones" | "pauseMs" | "timeoutMs">> = {},
): Promise<ZoneShiftScrapeResult> {
  const started = Date.now();
  const maxZones = options.maxZones ?? 10;
  const pauseMs = options.pauseMs ?? 700;
  const timeoutMs = options.timeoutMs ?? 15_000;

  try {
    const homeOk = await waitForBookingHome(page, timeoutMs);
    if (!homeOk) {
      return {
        ok: false,
        code: "CAPTCHA_REQUIRED",
        message: "The verified booking page did not return to the zone list.",
      };
    }

    const dateSelected = await selectDate(page, date);
    logInfo("zone_shift_date_select", { date, ok: dateSelected });
    if (!dateSelected) {
      return {
        ok: false,
        code: "SCRAPE_FAILED",
        message: `Could not select ${date} on the booking page calendar.`,
      };
    }
    await page.waitForTimeout(900);
    await dismissOk(page);

    const zones: Record<string, ZoneShiftSeats> = {};
    for (let n = 1; n <= maxZones; n++) {
      const zoneLabel = `Zone ${n}`;
      const opened = await clickZoneBookNow(page, zoneLabel);
      if (!opened) {
        logInfo("zone_shift_book_miss", { zone: zoneLabel });
        continue;
      }

      let ticketPageReady = false;
      let noSchedules = false;
      for (let i = 0; i < 16; i++) {
        const state = await page
          .evaluate<{ tickets: boolean; noSchedules: boolean }>(`(() => {
            const text = document.body ? document.body.innerText : "";
            const visible = (el) => {
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return style.display !== "none" && style.visibility !== "hidden" &&
                Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
            };
            const hasTickets = /\\bMorning\\b/i.test(text) &&
              /\\bAfternoon\\b/i.test(text) &&
              /\\b(Canter|Gypsy)\\b/i.test(text);
            const hasNoScheduleNotice = Array.from(
              document.querySelectorAll("[role='alert'], .toast, .alert, .notification"),
            ).some((el) => visible(el) && /no schedules are available/i.test(el.innerText || ""));
            return {
              tickets: hasTickets,
              noSchedules: !hasTickets && hasNoScheduleNotice,
            };
          })()`)
          .catch(() => ({ tickets: false, noSchedules: false }));
        ticketPageReady = state.tickets;
        noSchedules = state.noSchedules;
        if (ticketPageReady || noSchedules) break;
        await page.waitForTimeout(500);
      }

      if (ticketPageReady) {
        const seats = await scrapeOpenZoneTickets(page);
        if (seats) {
          zones[zoneLabel] = seats;
          logInfo("zone_shift_scraped", { zone: zoneLabel, ...seats });
        } else {
          logInfo("zone_shift_empty", { zone: zoneLabel });
        }
      } else if (noSchedules) {
        logInfo("zone_shift_no_schedules", { zone: zoneLabel, date });
      } else {
        const pageSummary = await page
          .evaluate(`(() => {
            const text = (document.body?.innerText || "").replace(/\\s+/g, " ");
            return {
              url: location.href,
              summary: text.slice(-1200),
              notices: Array.from(document.querySelectorAll("[role='alert'], .toast, .alert, .notification"))
                .map((el) => (el.innerText || "").trim())
                .filter(Boolean)
                .slice(0, 5),
            };
          })()`)
          .catch(() => "page unavailable");
        logInfo("zone_shift_page_not_ready", { zone: zoneLabel, pageSummary });
      }

      await clickBack(page);
      const returnedHome = await waitForBookingHome(page, timeoutMs);
      if (!returnedHome) {
        return {
          ok: false,
          code: "SCRAPE_FAILED",
          message: `Could not return to the zone list after opening ${zoneLabel}.`,
        };
      }
      if (pauseMs > 0) await page.waitForTimeout(pauseMs);
    }

    if (Object.keys(zones).length === 0) {
      return {
        ok: false,
        code: "SCRAPE_FAILED",
        message:
          "Opened the booking page but no zone ticket grids loaded. Check the selected date and booking-site response.",
      };
    }

    return {
      ok: true,
      snapshot: {
        date,
        zones,
        scrapedAt: new Date().toISOString(),
        source: "zone_page",
      },
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(message)) {
      return { ok: false, code: "TIMEOUT", message: "Timed out scraping zone Morning/Afternoon seats." };
    }
    return { ok: false, code: "SCRAPE_FAILED", message };
  }
}

/**
 * Opens the official booking site, selects a date, opens each zone ticket page,
 * and sums Morning / Afternoon seat badges (same grid as the govt Zone page).
 */
export async function scrapeZoneShiftsForDate(
  options: ZoneShiftScrapeOptions,
): Promise<ZoneShiftScrapeResult> {
  const started = Date.now();
  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    return {
      ok: false,
      code: "PLAYWRIGHT_NOT_INSTALLED",
      message: "Playwright is not installed.",
    };
  }

  const profileDir = path.resolve(options.profileDir);
  await ensureProfileDir(profileDir);
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  try {
    const common = {
      headless: options.headless,
      viewport: { width: 1400, height: 950 } as const,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--use-fake-ui-for-media-stream",
      ],
      ignoreDefaultArgs: ["--enable-automation"] as string[],
    };

    let context;
    try {
      context = await playwright.chromium.launchPersistentContext(profileDir, {
        ...common,
        channel: "chrome",
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      });
    } catch {
      context = await playwright.chromium.launchPersistentContext(profileDir, {
        ...common,
        channel: options.channel === "chromium" ? undefined : "chrome",
      });
    }

    try {
      await context.grantPermissions(["geolocation"], { origin: baseUrl });
      await context.setGeolocation(DEFAULT_GEO);

      const page = context.pages()[0] ?? (await context.newPage());
      await page.addInitScript(
        `Object.defineProperty(navigator, "webdriver", { get: () => undefined });`,
      );

      await page.goto(baseUrl + "/", {
        waitUntil: "domcontentloaded",
        timeout: Math.min(options.timeoutMs, 60_000),
      });

      return await scrapeZoneShiftsOnPage(page, options.date, {
        maxZones: options.maxZones,
        pauseMs: options.pauseMs,
        timeoutMs: Math.max(options.timeoutMs, 90_000),
      });
    } finally {
      await context.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(message)) {
      return { ok: false, code: "TIMEOUT", message: "Timed out scraping zone Morning/Afternoon seats." };
    }
    return { ok: false, code: "SCRAPE_FAILED", message };
  }
}

export const __test = { sumTicketAvailability };
