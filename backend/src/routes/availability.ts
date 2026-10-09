import type { RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import {
  AvailabilityQuerySchema,
  type AvailabilityResult,
  type AvailabilitySuccess,
} from "../types/availability.js";
import type { AvailabilityProvider } from "../types/availability.js";
import { availabilityCacheKey, type CacheStore } from "../cache/store.js";
import { logInfo } from "../utils/logger.js";

export function createAvailabilityRouter(deps: {
  provider: AvailabilityProvider;
  cache: CacheStore;
  cacheTtlSeconds: number;
}): { handler: RequestHandler; rateLimiter: RequestHandler } {
  const rateLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: "RATE_LIMITED",
      message: "Too many availability requests. Please slow down.",
    },
  });

  const handler: RequestHandler = async (req, res) => {
    const started = Date.now();
    const parsed = AvailabilityQuerySchema.safeParse({
      park: req.query.park,
      date: req.query.date,
      shift: req.query.shift ?? "morning",
      safariType: req.query.safariType,
    });

    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path?.[0];
      const error =
        field === "park" ? "INVALID_PARK" : field === "date" ? "INVALID_DATE" : "INVALID_QUERY";

      res.status(400).json({
        success: false,
        error,
        message: issue?.message ?? "Invalid query parameters.",
      } satisfies AvailabilityResult);
      return;
    }

    const { park, date, shift, safariType } = parsed.data;
    const cacheKey = availabilityCacheKey(park, date, shift);

    const cached = await deps.cache.get<AvailabilitySuccess>(cacheKey);
    if (cached?.success) {
      logInfo("availability_request", {
        park,
        date,
        shift,
        cacheHit: true,
        responseDurationMs: Date.now() - started,
        sourceEndpoint: "cache",
        responseStatus: 200,
      });
      res.json({
        ...cached,
        cache: {
          hit: true,
          key: cacheKey,
          ttlSeconds: deps.cacheTtlSeconds,
        },
      });
      return;
    }

    const result = await deps.provider.getAvailability({
      park,
      date,
      shift,
      safariType,
    });

    logInfo("availability_request", {
      park,
      date,
      shift,
      cacheHit: false,
      responseDurationMs: Date.now() - started,
      responseStatus: result.success ? 200 : 502,
      success: result.success,
      error: result.success ? undefined : result.error,
    });

    if (!result.success) {
      const status =
        result.error === "INVALID_PARK" ||
        result.error === "INVALID_DATE" ||
        result.error === "INVALID_QUERY"
          ? 400
          : result.error === "API_TIMEOUT"
            ? 504
            : result.error === "CAPTCHA_REQUIRED" || result.error === "AUTHENTICATION_REQUIRED"
              ? 503
              : 502;

      res.status(status).json(result);
      return;
    }

    const payload: AvailabilitySuccess = {
      ...result,
      cache: {
        hit: false,
        key: cacheKey,
        ttlSeconds: deps.cacheTtlSeconds,
      },
    };

    await deps.cache.set(cacheKey, payload, deps.cacheTtlSeconds);
    res.json(payload);
  };

  return { handler, rateLimiter };
}
