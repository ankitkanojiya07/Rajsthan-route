import { readFile } from "node:fs/promises";
import type { BrowserIngestStore } from "../cache/ingestStore.js";
import type { ZoneShiftStore } from "../cache/shiftStore.js";
import type {
  AvailabilityProvider,
  AvailabilityResult,
  BookingStatsDay,
  Park,
  Shift,
  ZoneAvailability,
} from "../types/availability.js";
import { logError, logInfo } from "../utils/logger.js";
import { fetchBookingPageViaBrowser, type BrowserFetchResult } from "./browserFetcher.js";
import { FormatError, isCloudflareChallenge, parseBookingStats } from "./parseBookingStats.js";

export type ForestProviderOptions = {
  baseUrl: string;
  timeoutMs: number;
  fixturePath?: string;
  useFixtureOnly?: boolean;
  fetchImpl?: typeof fetch;
  ingestStore?: BrowserIngestStore;
  shiftStore?: ZoneShiftStore;
  fetchMode?: "http" | "browser" | "ingest_only";
  browserProfileDir?: string;
  browserHeadless?: boolean;
  browserFetchImpl?: typeof fetchBookingPageViaBrowser;
};

const PARK_LABELS: Record<Park, string> = {
  ranthambore: "Ranthambore Tiger Reserve",
};

function seatStatus(raw: number | null | undefined): ZoneAvailability["status"] {
  if (raw === null || raw === undefined) return "unavailable";
  if (typeof raw !== "number" || Number.isNaN(raw)) return "unknown";
  if (raw > 0) return "available";
  return "full";
}

function toZoneRow(zone: string, raw: number | null | undefined): ZoneAvailability {
  const status = seatStatus(raw);
  if (status === "unavailable" || status === "unknown") {
    return { zone, available: false, availability: null, status };
  }
  if (status === "available") {
    return { zone, available: true, availability: raw as number, status };
  }
  return { zone, available: false, availability: 0, status: "full" };
}

function normalizeZones(zones: Record<string, number | null>): ZoneAvailability[] {
  const baseZones = Object.keys(zones)
    .filter((key) => /^Zone\s+\d+$/i.test(key))
    .sort((a, b) => {
      const na = Number(a.replace(/\D/g, ""));
      const nb = Number(b.replace(/\D/g, ""));
      return na - nb;
    });

  return baseZones.map((zone) => toZoneRow(zone, zones[zone]));
}

/** Overlay Morning/Afternoon seats from the official zone ticket page when available. */
function applyShiftOverlay(
  dayZones: ZoneAvailability[],
  shiftStore: ZoneShiftStore | undefined,
  date: string,
  shift: Shift,
): { zones: ZoneAvailability[]; dataScope: "day" | "shift"; covered: number } {
  if (!shiftStore) return { zones: dayZones, dataScope: "day", covered: 0 };
  const daySnap = shiftStore.getDay(date);
  if (!daySnap) return { zones: dayZones, dataScope: "day", covered: 0 };

  let covered = 0;
  const zones = dayZones.map((row) => {
    const shiftSeats = shiftStore.getShiftSeats(date, row.zone, shift);
    const dayAvailability = {
      availability: row.availability,
      status: row.status,
    };
    if (shiftSeats === undefined) {
      // Shift scrape ran for this date but this zone was not captured
      return {
        zone: row.zone,
        available: false,
        availability: null,
        status: "unknown" as const,
        dayAvailability,
      };
    }
    covered += 1;
    if (shiftSeats === null || typeof shiftSeats === "number") {
      return { ...toZoneRow(row.zone, shiftSeats), dayAvailability };
    }

    const knownSeats = [shiftSeats.canter, shiftSeats.gypsy].filter(
      (seats): seats is number => seats !== null,
    );
    const totalSeats = knownSeats.length > 0
      ? knownSeats.reduce((total, seats) => total + seats, 0)
      : null;
    return {
      ...toZoneRow(row.zone, totalSeats),
      dayAvailability,
      safariAvailability: shiftSeats,
    };
  });

  return {
    zones,
    dataScope: "shift",
    covered,
  };
}

/**
 * Isolates integration with the Rajasthan Forest booking availability source.
 *
 * Does NOT bypass Cloudflare, CAPTCHA, Turnstile, or authentication.
 * When automated fetch is blocked, uses browser-ingested bookingStats if present.
 */
export class ForestAvailabilityProvider implements AvailabilityProvider {
  private readonly options: Required<
    Pick<ForestProviderOptions, "baseUrl" | "timeoutMs" | "useFixtureOnly">
  > &
    Pick<
      ForestProviderOptions,
      | "fixturePath"
      | "fetchImpl"
      | "ingestStore"
      | "shiftStore"
      | "fetchMode"
      | "browserProfileDir"
      | "browserHeadless"
      | "browserFetchImpl"
    >;

  constructor(options: ForestProviderOptions) {
    this.options = {
      baseUrl: options.baseUrl.replace(/\/$/, ""),
      timeoutMs: options.timeoutMs,
      fixturePath: options.fixturePath,
      useFixtureOnly: options.useFixtureOnly ?? false,
      fetchImpl: options.fetchImpl,
      ingestStore: options.ingestStore,
      shiftStore: options.shiftStore,
      fetchMode: options.fetchMode ?? "browser",
      browserProfileDir: options.browserProfileDir ?? "./.forest-browser-profile",
      browserHeadless: options.browserHeadless ?? true,
      browserFetchImpl: options.browserFetchImpl ?? fetchBookingPageViaBrowser,
    };
  }

  async getAvailability(params: {
    park: Park;
    date: string;
    shift: Shift;
    safariType?: string;
  }): Promise<AvailabilityResult> {
    const started = Date.now();
    const sourceEndpoint = `${this.options.baseUrl}/`;

    try {
      if (params.park !== "ranthambore") {
        return {
          success: false,
          error: "INVALID_PARK",
          message: "Unsupported park. Currently only ranthambore is supported.",
          park: params.park,
          date: params.date,
          shift: params.shift,
        };
      }

      const { days, source } = await this.loadBookingStats(sourceEndpoint);

      const day = days.find((entry) => entry.visit_date === params.date);
      if (!day) {
        return {
          success: false,
          error: "AVAILABILITY_TEMPORARILY_UNAVAILABLE",
          message: `No availability chart data was present for ${params.date}.`,
          park: params.park,
          date: params.date,
          shift: params.shift,
          details: `Loaded ${days.length} chart days from ${source}`,
        };
      }

      const dayZones = normalizeZones(day.zones);
      const overlay = applyShiftOverlay(
        dayZones,
        this.options.shiftStore,
        params.date,
        params.shift,
      );
      const zones = overlay.zones;
      const durationMs = Date.now() - started;

      logInfo("availability_source_ok", {
        park: params.park,
        date: params.date,
        shift: params.shift,
        sourceEndpoint,
        responseStatus: 200,
        responseDurationMs: durationMs,
        source,
        zoneCount: zones.length,
        dataScope: overlay.dataScope,
        shiftZonesCovered: overlay.covered,
      });

      const notes =
        overlay.dataScope === "shift"
          ? [
              `Morning/Afternoon seats for ${params.shift} come from the official zone ticket page (same grid as “Available tickets/seats for Zone N”).`,
              `${overlay.covered} zone(s) have scraped shift seats for ${params.date}.`,
              source === "browser_ingest"
                ? "Day chart still loaded from synced/cached bookingStats."
                : "Day chart loaded from the official booking page session/cache.",
            ]
          : [
              `Day chart for ${PARK_LABELS[params.park]} has one total per zone (not split by Morning/Afternoon).`,
              "True Morning/Afternoon appears on each zone’s ticket page — click Fetch latest with a safari date to scrape that grid.",
              source === "browser_ingest"
                ? "Data from synced/cached official chart (browser session or disk cache)."
                : source === "browser_session"
                  ? "Data was fetched with Chromium using your saved browser profile."
                  : "Source is the publicly embedded bookingStats payload on the official booking page.",
            ];

      return {
        success: true,
        source,
        officialApi: false,
        park: params.park,
        date: params.date,
        shift: params.shift,
        safariType: params.safariType ?? null,
        zones,
        lastUpdated: new Date().toISOString(),
        dataScope: overlay.dataScope,
        notes,
        cache: {
          hit: false,
          key: "",
          ttlSeconds: 0,
        },
      };
    } catch (error) {
      return this.mapError(error, params, sourceEndpoint, Date.now() - started);
    }
  }

  private async loadBookingStats(sourceEndpoint: string): Promise<{
    days: BookingStatsDay[];
    source: "undocumented_public_page" | "fixture" | "browser_ingest" | "browser_session";
  }> {
    if (this.options.useFixtureOnly || this.options.fixturePath) {
      if (this.options.useFixtureOnly && !this.options.fixturePath) {
        throw Object.assign(new Error("Fixture-only mode requires FOREST_HTML_FIXTURE_PATH"), {
          code: "AVAILABILITY_SOURCE_UNAVAILABLE",
        });
      }
      if (this.options.fixturePath && (this.options.useFixtureOnly || process.env.NODE_ENV === "test")) {
        const raw = await readFile(this.options.fixturePath, "utf8");
        return { days: parseBookingStats(raw), source: "fixture" };
      }
    }

    // Prefer a fresh browser-synced snapshot before hitting Cloudflare-protected HTML.
    const ingested = this.options.ingestStore?.getFresh();
    if (ingested) {
      logInfo("availability_using_browser_ingest", {
        ingestedAt: ingested.ingestedAt,
        dayCount: ingested.dayCount,
      });
      return { days: ingested.days, source: "browser_ingest" };
    }

    if (this.options.fetchMode === "browser") {
      const browserResult = await this.tryBrowserFetch(sourceEndpoint);
      if (browserResult) {
        return browserResult;
      }
    }

    if (this.options.fetchMode === "ingest_only") {
      throw Object.assign(
        new Error("No synced data yet. Use Fetch latest on the dashboard or npm run forest:login."),
        { code: "CAPTCHA_REQUIRED" },
      );
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetchImpl(sourceEndpoint, {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "RajasthanRoutesDashboard/1.0 (+personal-availability-dashboard)",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      const body = await response.text();

      logInfo("availability_upstream_response", {
        sourceEndpoint,
        responseStatus: response.status,
        bodyBytes: body.length,
      });

      if (isCloudflareChallenge(response.status, body)) {
        throw Object.assign(
          new Error("Official booking page requires browser/CAPTCHA verification (Cloudflare)."),
          { code: "CAPTCHA_REQUIRED", status: response.status },
        );
      }

      if (response.status === 401 || response.status === 403) {
        throw Object.assign(new Error("Official booking page denied access."), {
          code: "AUTHENTICATION_REQUIRED",
          status: response.status,
        });
      }

      if (response.status >= 500) {
        throw Object.assign(new Error("Official availability source returned a server error."), {
          code: "AVAILABILITY_SOURCE_UNAVAILABLE",
          status: response.status,
        });
      }

      if (!response.ok) {
        throw Object.assign(new Error(`Unexpected upstream status ${response.status}`), {
          code: "AVAILABILITY_SOURCE_UNAVAILABLE",
          status: response.status,
        });
      }

      return {
        days: parseBookingStats(body),
        source: "undocumented_public_page",
      };
    } catch (error) {
      const err = error as { code?: string };
      const latest = this.options.ingestStore?.getLatest();
      if (
        latest &&
        (err?.code === "CAPTCHA_REQUIRED" ||
          err?.code === "AUTHENTICATION_REQUIRED" ||
          err?.code === "AVAILABILITY_SOURCE_UNAVAILABLE")
      ) {
        logInfo("availability_ingest_fallback_after_block", {
          ingestedAt: latest.ingestedAt,
          dayCount: latest.dayCount,
          blockedCode: err.code,
        });
        return { days: latest.days, source: "browser_ingest" };
      }

      if (this.options.fetchMode === "browser" && err?.code === "CAPTCHA_REQUIRED") {
        const browserResult = await this.tryBrowserFetch(sourceEndpoint);
        if (browserResult) {
          return browserResult;
        }
      }

      if (this.options.fixturePath && !this.options.useFixtureOnly) {
        if (process.env.FOREST_ALLOW_FIXTURE_FALLBACK === "true") {
          const raw = await readFile(this.options.fixturePath, "utf8");
          logInfo("availability_fixture_fallback", { fixturePath: this.options.fixturePath });
          return { days: parseBookingStats(raw), source: "fixture" };
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async tryBrowserFetch(
    sourceEndpoint: string,
  ): Promise<{ days: BookingStatsDay[]; source: "browser_session" } | null> {
    const browserFetch = this.options.browserFetchImpl ?? fetchBookingPageViaBrowser;
    const result: BrowserFetchResult = await browserFetch({
      baseUrl: this.options.baseUrl,
      profileDir: this.options.browserProfileDir ?? "./.forest-browser-profile",
      timeoutMs: Math.max(this.options.timeoutMs, 30000),
      headless: this.options.browserHeadless ?? true,
      channel: "chrome",
    });

    if (!result.ok) {
      logInfo("browser_fetch_skipped", {
        sourceEndpoint,
        code: result.code,
        message: result.message,
      });
      return null;
    }

    const days = parseBookingStats(result.html);
    this.options.ingestStore?.set(days, "browser_session");
    logInfo("availability_using_browser_session", {
      dayCount: days.length,
      durationMs: result.durationMs,
    });
    return { days, source: "browser_session" };
  }

  private mapError(
    error: unknown,
    params: { park: Park; date: string; shift: Shift },
    sourceEndpoint: string,
    durationMs: number,
  ): AvailabilityResult {
    const err = error as { name?: string; code?: string; message?: string; status?: number };

    if (err?.name === "AbortError") {
      logError("availability_timeout", {
        park: params.park,
        date: params.date,
        shift: params.shift,
        sourceEndpoint,
        responseDurationMs: durationMs,
      });
      return {
        success: false,
        error: "API_TIMEOUT",
        message: "The official availability source timed out.",
        park: params.park,
        date: params.date,
        shift: params.shift,
      };
    }

    if (err instanceof FormatError || err?.name === "FormatError") {
      logError("availability_parse_error", {
        park: params.park,
        date: params.date,
        shift: params.shift,
        sourceEndpoint,
        details: err.message,
        responseDurationMs: durationMs,
      });
      return {
        success: false,
        error: "SOURCE_FORMAT_CHANGED",
        message: "The official availability source format could not be parsed.",
        park: params.park,
        date: params.date,
        shift: params.shift,
        details: err.message,
      };
    }

    const code = err?.code;
    if (
      code === "CAPTCHA_REQUIRED" ||
      code === "AUTHENTICATION_REQUIRED" ||
      code === "AVAILABILITY_SOURCE_UNAVAILABLE"
    ) {
      logError("availability_source_blocked", {
        park: params.park,
        date: params.date,
        shift: params.shift,
        sourceEndpoint,
        errorCode: code,
        upstreamStatus: err.status,
        responseDurationMs: durationMs,
      });
      return {
        success: false,
        error: code,
        message:
          code === "CAPTCHA_REQUIRED"
            ? "Plain server fetch is blocked (Cloudflare treats Node as a bot). Click Fetch latest on the dashboard, or run once: npm run forest:login — then availability loads automatically."
            : code === "AUTHENTICATION_REQUIRED"
              ? "Authentication or an allowed browser session is required. Sync availability from your browser instead."
              : "The official availability source could not be reached.",
        park: params.park,
        date: params.date,
        shift: params.shift,
        details: err.message,
      };
    }

    logError("availability_unknown_error", {
      park: params.park,
      date: params.date,
      shift: params.shift,
      sourceEndpoint,
      details: err?.message ?? String(error),
      responseDurationMs: durationMs,
    });

    return {
      success: false,
      error: "AVAILABILITY_SOURCE_UNAVAILABLE",
      message: "The official availability source could not be reached.",
      park: params.park,
      date: params.date,
      shift: params.shift,
      details: err?.message ?? String(error),
    };
  }
}

/** Exported for unit tests */
export const __test = {
  parseBookingStats,
  normalizeZones,
  isCloudflareChallenge,
};
