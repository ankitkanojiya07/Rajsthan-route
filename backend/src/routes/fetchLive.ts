import type { RequestHandler } from "express";
import type { BrowserIngestStore } from "../cache/ingestStore.js";
import type { ZoneShiftStore } from "../cache/shiftStore.js";
import type { CacheStore } from "../cache/store.js";
import { fetchBookingPageViaBrowser } from "../providers/browserFetcher.js";
import { parseBookingStats } from "../providers/parseBookingStats.js";
import {
  scrapeZoneShiftsOnPage,
  type ZoneShiftScrapeResult,
} from "../providers/zoneShiftScraper.js";
import { logInfo } from "../utils/logger.js";

export function createFetchLiveHandler(deps: {
  baseUrl: string;
  profileDir: string;
  timeoutMs: number;
  headless: boolean;
  channel?: "chrome" | "chromium";
  ingestStore: BrowserIngestStore;
  shiftStore: ZoneShiftStore;
  cache: CacheStore;
}): RequestHandler {
  return async (req, res) => {
    const started = Date.now();
    const body = (req.body ?? {}) as {
      date?: string;
      includeShifts?: boolean;
    };
    const includeShifts = body.includeShifts !== false;
    const shiftDate =
      typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : undefined;

    const shiftScrape: { result: ZoneShiftScrapeResult | null } = { result: null };
    const result = await fetchBookingPageViaBrowser({
      baseUrl: deps.baseUrl,
      profileDir: deps.profileDir,
      timeoutMs: deps.timeoutMs,
      headless: deps.headless,
      channel: deps.channel ?? "chrome",
      onBookingPage: includeShifts && shiftDate
        ? async (page) => {
            shiftScrape.result = await scrapeZoneShiftsOnPage(page, shiftDate, {
              timeoutMs: Math.max(deps.timeoutMs, 15_000),
              pauseMs: 700,
            });
          }
        : undefined,
    });

    if (!result.ok) {
      const status =
        result.code === "PLAYWRIGHT_NOT_INSTALLED"
          ? 501
          : result.code === "CAPTCHA_REQUIRED"
            ? 503
            : result.code === "TIMEOUT"
              ? 504
              : 502;

      res.status(status).json({
        success: false,
        error: result.code === "CAPTCHA_REQUIRED" ? "CAPTCHA_REQUIRED" : "AVAILABILITY_SOURCE_UNAVAILABLE",
        message: result.message,
        hint:
          result.code === "CAPTCHA_REQUIRED" || result.code === "PLAYWRIGHT_NOT_INSTALLED"
            ? "Run from backend folder: npm run forest:login"
            : undefined,
      });
      return;
    }

    try {
      const days = parseBookingStats(result.html);
      const snapshot = deps.ingestStore.set(days, "browser_session");
      if (deps.cache.clearPrefix) {
        await deps.cache.clearPrefix("safari:availability:");
      }

      let shifts: {
        ok: boolean;
        date?: string;
        zoneCount?: number;
        message?: string;
      } = { ok: false, message: "Shift scrape skipped." };

      if (includeShifts && shiftDate) {
        const shiftResult = shiftScrape.result;
        logInfo("fetch_live_shift_scrape_complete", {
          date: shiftDate,
          ok: shiftResult?.ok ?? false,
        });
        if (shiftResult?.ok) {
          deps.shiftStore.setDay(shiftResult.snapshot);
          if (deps.cache.clearPrefix) {
            await deps.cache.clearPrefix("safari:availability:");
          }
          shifts = {
            ok: true,
            date: shiftDate,
            zoneCount: Object.keys(shiftResult.snapshot.zones).length,
            message: `Scraped Canter and Gypsy seats for Morning/Afternoon in ${Object.keys(shiftResult.snapshot.zones).length} zones on ${shiftDate}.`,
          };
        } else {
          shifts = {
            ok: false,
            date: shiftDate,
            message: shiftResult?.message ?? "Zone seat scrape did not run on the verified booking page.",
          };
        }
      } else if (includeShifts && !shiftDate) {
        shifts = {
          ok: false,
          message: "Pass { date: 'YYYY-MM-DD' } to also scrape Morning/Afternoon from each zone page.",
        };
      }

      logInfo("fetch_live_ok", {
        dayCount: snapshot.dayCount,
        durationMs: Date.now() - started,
        shiftsOk: shifts.ok,
        shiftDate,
      });

      res.json({
        success: true,
        dayCount: snapshot.dayCount,
        ingestedAt: snapshot.ingestedAt,
        message: `Fetched ${snapshot.dayCount} days from the official booking page.`,
        shifts,
      });
    } catch (error) {
      res.status(502).json({
        success: false,
        error: "SOURCE_FORMAT_CHANGED",
        message: "Page loaded but bookingStats could not be parsed.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
