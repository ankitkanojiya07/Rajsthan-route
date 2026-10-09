import type { RequestHandler } from "express";
import type { BrowserIngestStore } from "../cache/ingestStore.js";
import type { CacheStore } from "../cache/store.js";
import { parseBookingStats } from "../providers/parseBookingStats.js";
import { logInfo } from "../utils/logger.js";

export function createIngestHandlers(deps: {
  ingestStore: BrowserIngestStore;
  cache: CacheStore;
  cacheTtlSeconds: number;
}): {
  ingest: RequestHandler;
  status: RequestHandler;
} {
  const ingest: RequestHandler = async (req, res) => {
    try {
      let raw: string | null = null;
      if (typeof req.body === "string") {
        raw = req.body;
      } else if (req.body && typeof req.body === "object") {
        const payload = req.body.bookingStats ?? req.body.html ?? req.body.raw ?? req.body;
        raw =
          typeof payload === "string"
            ? payload
            : Array.isArray(payload)
              ? JSON.stringify(payload)
              : null;
      }

      if (!raw) {
        res.status(400).json({
          success: false,
          error: "INVALID_QUERY",
          message: "Send bookingStats JSON array, or HTML containing bookingStats=...",
        });
        return;
      }

      const days = parseBookingStats(raw);
      const snapshot = deps.ingestStore.set(days, "browser_ingest");

      // Drop stale per-query cache so the next read uses the fresh ingest.
      if (deps.cache.clearPrefix) {
        await deps.cache.clearPrefix("safari:availability:");
      }

      logInfo("availability_browser_ingest", {
        dayCount: snapshot.dayCount,
        ingestedAt: snapshot.ingestedAt,
        cacheTtlSeconds: deps.cacheTtlSeconds,
      });

      res.json({
        success: true,
        ingestedAt: snapshot.ingestedAt,
        dayCount: snapshot.dayCount,
        message:
          "Browser-synced availability stored. Refresh the dashboard — no CAPTCHA bypass was used.",
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: "SOURCE_FORMAT_CHANGED",
        message: "Could not parse bookingStats from the submitted payload.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const status: RequestHandler = (_req, res) => {
    res.json({
      success: true,
      ingest: deps.ingestStore.getStatus(),
      officialBookingUrl: "https://booking.forestrajasthan.com/",
      instructions: [
        "Open the official booking site in your browser and wait for Cloudflare verification to finish.",
        "Copy the bookmarklet from the dashboard (or paste bookingStats JSON here).",
        "Run the bookmarklet on the booking tab to copy bookingStats, then paste into the dashboard Sync box.",
      ],
    });
  };

  return { ingest, status };
}
