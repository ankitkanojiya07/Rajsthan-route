import "dotenv/config";
import cors from "cors";
import express from "express";
import { BrowserIngestStore } from "./cache/ingestStore.js";
import { ZoneShiftStore } from "./cache/shiftStore.js";
import { MemoryCacheStore } from "./cache/store.js";
import { ForestAvailabilityProvider } from "./providers/ForestAvailabilityProvider.js";
import { createAvailabilityRouter } from "./routes/availability.js";
import { createFetchLiveHandler } from "./routes/fetchLive.js";
import { createIngestHandlers } from "./routes/ingest.js";
import { logInfo } from "./utils/logger.js";

const port = Number(process.env.PORT ?? 4000);
const cacheTtlSeconds = Number(process.env.AVAILABILITY_CACHE_TTL ?? 300);
const ingestTtlSeconds = Number(process.env.AVAILABILITY_INGEST_TTL ?? cacheTtlSeconds);
const timeoutMs = Number(process.env.FOREST_API_TIMEOUT ?? 10000);
const baseUrl = process.env.FOREST_API_BASE_URL ?? "https://booking.forestrajasthan.com";
const fixturePath = process.env.FOREST_HTML_FIXTURE_PATH;
const useFixtureOnly = process.env.FOREST_USE_FIXTURE_ONLY === "true";
const fetchMode = (process.env.FOREST_FETCH_MODE ?? "browser") as "http" | "browser" | "ingest_only";
const browserProfileDir = process.env.FOREST_BROWSER_PROFILE_DIR ?? "./.forest-browser-profile";
const browserHeadless = process.env.FOREST_BROWSER_HEADLESS !== "false";

const cache = new MemoryCacheStore();
const ingestStore = new BrowserIngestStore(ingestTtlSeconds);
await ingestStore.loadFromDisk();
const shiftStore = new ZoneShiftStore();
await shiftStore.loadFromDisk();

const provider = new ForestAvailabilityProvider({
  baseUrl,
  timeoutMs,
  fixturePath,
  useFixtureOnly,
  ingestStore,
  shiftStore,
  fetchMode: useFixtureOnly ? "ingest_only" : fetchMode,
  browserProfileDir,
  browserHeadless,
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "6mb" }));
app.use(express.text({ type: ["text/plain", "text/html"], limit: "6mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "rajasthan-routes-backend" });
});

const availability = createAvailabilityRouter({
  provider,
  cache,
  cacheTtlSeconds,
});

const ingest = createIngestHandlers({
  ingestStore,
  cache,
  cacheTtlSeconds,
});

app.get("/api/safari/availability", availability.rateLimiter, availability.handler);
app.post("/api/safari/ingest", availability.rateLimiter, ingest.ingest);
app.get("/api/safari/ingest/status", ingest.status);

const fetchLive = createFetchLiveHandler({
  baseUrl,
  profileDir: browserProfileDir,
  timeoutMs: Math.max(timeoutMs, 45000),
  headless: browserHeadless,
  channel: "chrome",
  ingestStore,
  shiftStore,
  cache,
});
app.post("/api/safari/fetch-live", availability.rateLimiter, fetchLive);

app.get("/api/config", (_req, res) => {
  res.json({
    refreshIntervalSeconds: Number(process.env.AVAILABILITY_REFRESH_INTERVAL ?? 300),
    cacheTtlSeconds,
    ingestTtlSeconds,
    parks: [
      {
        id: "ranthambore",
        name: "Ranthambore National Park",
      },
    ],
    shifts: ["morning", "afternoon"],
    officialBookingUrl: "https://booking.forestrajasthan.com/",
    fetchMode: useFixtureOnly ? "fixture" : fetchMode,
    sourceDisclaimer:
      "Cloudflare blocks plain server HTTP. Default mode uses Chromium (real browser) to read the official chart. Morning/Afternoon come from each zone ticket page.",
    ingest: ingestStore.getStatus(),
    fetchLiveHint: "POST /api/safari/fetch-live with { date } to refresh chart + Morning/Afternoon",
  });
});

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    logInfo("server_started", {
      port,
      baseUrl,
      cacheTtlSeconds,
      ingestTtlSeconds,
      useFixtureOnly,
      fetchMode,
      browserHeadless,
      hasFixture: Boolean(fixturePath),
    });
  });
}

export { app, ingestStore, shiftStore, cache };
