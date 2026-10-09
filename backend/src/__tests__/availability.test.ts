import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MemoryCacheStore, availabilityCacheKey } from "../cache/store.js";
import {
  ZoneShiftStore,
  type ShiftDaySnapshot,
} from "../cache/shiftStore.js";
import {
  ForestAvailabilityProvider,
  __test as providerTest,
} from "../providers/ForestAvailabilityProvider.js";
import { __test as zoneShiftTest } from "../providers/zoneShiftScraper.js";
import { createAvailabilityRouter } from "../routes/availability.js";
import type { Shift } from "../types/availability.js";
import express from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlFixture = path.join(__dirname, "fixtures/booking-page.html");
const jsonFixture = path.join(__dirname, "fixtures/bookingStats.sample.json");

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

async function withServer(
  app: express.Express,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

test("parses bookingStats from HTML fixture", async () => {
  const html = await readFile(htmlFixture, "utf8");
  const days = providerTest.parseBookingStats(html);
  assert.equal(days.length, 3);
  assert.equal(days[0]?.visit_date, "2026-10-10");
});

test("valid availability response with multiple zones", async () => {
  const provider = new ForestAvailabilityProvider({
    baseUrl: "https://booking.forestrajasthan.com",
    timeoutMs: 5000,
    fixturePath: htmlFixture,
    useFixtureOnly: true,
  });

  const result = await provider.getAvailability({
    park: "ranthambore",
    date: "2026-10-10",
    shift: "morning",
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.park, "ranthambore");
  assert.equal(result.date, "2026-10-10");
  assert.equal(result.shift, "morning");
  assert.equal(result.officialApi, false);
  assert.ok(result.zones.length >= 10);
  const zone1 = result.zones.find((z) => z.zone === "Zone 1");
  assert.deepEqual(zone1, {
    zone: "Zone 1",
    available: true,
    availability: 24,
    status: "available",
  });
  const zone2 = result.zones.find((z) => z.zone === "Zone 2");
  assert.equal(zone2?.status, "full");
  assert.equal(zone2?.availability, 0);
});

test("availability keeps Canter and Gypsy seats separate for each shift", async () => {
  const snapshot: ShiftDaySnapshot = {
    date: "2026-10-10",
    zones: {
      "Zone 1": {
        morning: {
          canter: 5,
          gypsy: 12,
          canterCategories: [{ category: "advance", seats: 5 }],
          gypsyCategories: [{ category: "current", seats: 12 }],
        },
        afternoon: {
          canter: 3,
          gypsy: 8,
          canterCategories: [{ category: "tatkal", seats: 3 }],
          gypsyCategories: [{ category: "premium", seats: 8 }],
        },
      },
    },
    scrapedAt: new Date().toISOString(),
    source: "zone_page",
  };
  const shiftStore = new (class extends ZoneShiftStore {
    override getDay(date: string) {
      return date === snapshot.date ? snapshot : null;
    }

    override getShiftSeats(date: string, zone: string, shift: Shift) {
      return date === snapshot.date ? snapshot.zones[zone]?.[shift] : undefined;
    }
  })();
  const provider = new ForestAvailabilityProvider({
    baseUrl: "https://example.test",
    timeoutMs: 5000,
    fixturePath: htmlFixture,
    useFixtureOnly: true,
    shiftStore,
  });

  for (const shift of ["morning", "afternoon"] as const) {
    const result = await provider.getAvailability({
      park: "ranthambore",
      date: snapshot.date,
      shift,
    });
    assert.equal(result.success, true);
    if (!result.success) continue;
    const zone = result.zones.find((row) => row.zone === "Zone 1");
    assert.deepEqual(zone?.safariAvailability, snapshot.zones["Zone 1"]?.[shift]);
    assert.deepEqual(zone?.dayAvailability, {
      availability: 24,
      status: "available",
    });
    assert.equal(
      zone?.availability,
      shift === "morning" ? 17 : 11,
    );
  }
});

test("zone ticket rows sum seat badges by shift and vehicle", () => {
  const seats = zoneShiftTest.sumTicketAvailability([
    { shift: "afternoon", vehicle: "gypsy", category: "tatkal", seats: 6 },
    { shift: "afternoon", vehicle: "canter", category: "current", seats: 24 },
    { shift: "afternoon", vehicle: "gypsy", category: "premium", seats: 1 },
    { shift: "morning", vehicle: "gypsy", category: "advance", seats: 0 },
    { shift: "morning", vehicle: "canter", category: "current", seats: 0 },
  ]);
  assert.deepEqual(seats, {
    morning: {
      canter: 0,
      gypsy: 0,
      canterCategories: [{ category: "current", seats: 0 }],
      gypsyCategories: [{ category: "advance", seats: 0 }],
    },
    afternoon: {
      canter: 24,
      gypsy: 7,
      canterCategories: [{ category: "current", seats: 24 }],
      gypsyCategories: [
        { category: "tatkal", seats: 6 },
        { category: "premium", seats: 1 },
      ],
    },
  });
});

test("no availability / all full day", async () => {
  const provider = new ForestAvailabilityProvider({
    baseUrl: "https://example.test",
    timeoutMs: 5000,
    fixturePath: htmlFixture,
    useFixtureOnly: true,
  });
  const result = await provider.getAvailability({
    park: "ranthambore",
    date: "2026-10-11",
    shift: "afternoon",
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.ok(result.zones.every((z) => z.status === "full" || z.availability === 0));
});

test("unavailable/closed zones use null counts", async () => {
  const provider = new ForestAvailabilityProvider({
    baseUrl: "https://example.test",
    timeoutMs: 5000,
    fixturePath: htmlFixture,
    useFixtureOnly: true,
  });
  const result = await provider.getAvailability({
    park: "ranthambore",
    date: "2026-10-06",
    shift: "morning",
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  const zone6 = result.zones.find((z) => z.zone === "Zone 6");
  assert.equal(zone6?.status, "unavailable");
  assert.equal(zone6?.availability, null);
});

test("invalid park", async () => {
  const cache = new MemoryCacheStore();
  const provider = new ForestAvailabilityProvider({
    baseUrl: "https://example.test",
    timeoutMs: 1000,
    fixturePath: htmlFixture,
    useFixtureOnly: true,
  });
  const { handler } = createAvailabilityRouter({ provider, cache, cacheTtlSeconds: 300 });
  const app = express();
  app.get("/api/safari/availability", handler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/safari/availability?park=sariska&date=2026-10-10&shift=morning`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, "INVALID_PARK");
  });
});

test("invalid date", async () => {
  const cache = new MemoryCacheStore();
  const provider = new ForestAvailabilityProvider({
    baseUrl: "https://example.test",
    timeoutMs: 1000,
    fixturePath: htmlFixture,
    useFixtureOnly: true,
  });
  const { handler } = createAvailabilityRouter({ provider, cache, cacheTtlSeconds: 300 });
  const app = express();
  app.get("/api/safari/availability", handler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/safari/availability?park=ranthambore&date=10-10-2026&shift=morning`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "INVALID_DATE");
  });
});

const skipBrowserFetch = {
  fetchMode: "http" as const,
  browserFetchImpl: async () =>
    ({ ok: false, code: "BROWSER_FETCH_FAILED", message: "skipped in test" }) as const,
};

test("government API timeout", async () => {
  const provider = new ForestAvailabilityProvider({
    baseUrl: "https://booking.forestrajasthan.com",
    timeoutMs: 50,
    ...skipBrowserFetch,
    fetchImpl: mockFetch(async (_url, init) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 500);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
      return new Response("late", { status: 200 });
    }),
  });

  const result = await provider.getAvailability({
    park: "ranthambore",
    date: "2026-10-10",
    shift: "morning",
  });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error, "API_TIMEOUT");
});

test("government API 500", async () => {
  const provider = new ForestAvailabilityProvider({
    baseUrl: "https://booking.forestrajasthan.com",
    timeoutMs: 2000,
    ...skipBrowserFetch,
    fetchImpl: mockFetch(async () => new Response("error", { status: 500 })),
  });
  const result = await provider.getAvailability({
    park: "ranthambore",
    date: "2026-10-10",
    shift: "morning",
  });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error, "AVAILABILITY_SOURCE_UNAVAILABLE");
});

test("CAPTCHA / Cloudflare challenge", async () => {
  const provider = new ForestAvailabilityProvider({
    baseUrl: "https://booking.forestrajasthan.com",
    timeoutMs: 2000,
    ...skipBrowserFetch,
    fetchImpl: mockFetch(
      async () =>
        new Response("<html><title>Verifying your connection</title>cloudflare</html>", {
          status: 403,
        }),
    ),
  });
  const result = await provider.getAvailability({
    park: "ranthambore",
    date: "2026-10-10",
    shift: "morning",
  });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error, "CAPTCHA_REQUIRED");
});

test("malformed government response", async () => {
  const provider = new ForestAvailabilityProvider({
    baseUrl: "https://booking.forestrajasthan.com",
    timeoutMs: 2000,
    ...skipBrowserFetch,
    fetchImpl: mockFetch(async () => new Response("<html>no stats here</html>", { status: 200 })),
  });
  const result = await provider.getAvailability({
    park: "ranthambore",
    date: "2026-10-10",
    shift: "morning",
  });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error, "SOURCE_FORMAT_CHANGED");
});

test("cache miss then cache hit", async () => {
  const cache = new MemoryCacheStore();
  const provider = new ForestAvailabilityProvider({
    baseUrl: "https://example.test",
    timeoutMs: 1000,
    fixturePath: htmlFixture,
    useFixtureOnly: true,
  });
  const { handler } = createAvailabilityRouter({ provider, cache, cacheTtlSeconds: 300 });
  const app = express();
  app.get("/api/safari/availability", handler);

  await withServer(app, async (base) => {
    const url = `${base}/api/safari/availability?park=ranthambore&date=2026-10-10&shift=morning`;
    const first = await (await fetch(url)).json();
    assert.equal(first.success, true);
    assert.equal(first.cache.hit, false);

    const second = await (await fetch(url)).json();
    assert.equal(second.success, true);
    assert.equal(second.cache.hit, true);
    assert.equal(second.cache.key, availabilityCacheKey("ranthambore", "2026-10-10", "morning"));
  });
});

test("morning and afternoon shifts accepted", async () => {
  const provider = new ForestAvailabilityProvider({
    baseUrl: "https://example.test",
    timeoutMs: 1000,
    fixturePath: htmlFixture,
    useFixtureOnly: true,
  });
  for (const shift of ["morning", "afternoon"] as const) {
    const result = await provider.getAvailability({
      park: "ranthambore",
      date: "2026-10-10",
      shift,
    });
    assert.equal(result.success, true);
    if (!result.success) continue;
    assert.equal(result.shift, shift);
    assert.equal(result.dataScope, "day");
  }
});

test("sample JSON fixture contains many days", async () => {
  const raw = await readFile(jsonFixture, "utf8");
  const days = providerTest.parseBookingStats(raw);
  assert.ok(days.length > 30);
});

test("browser ingest unlocks availability when Cloudflare blocks live fetch", async (t) => {
  const { BrowserIngestStore } = await import("../cache/ingestStore.js");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rajasthan-routes-test-"));
  const ingestStore = new BrowserIngestStore(
    300,
    path.join(tempDir, "bookingStats.json"),
  );
  t.after(async () => {
    await ingestStore.flush();
    await rm(tempDir, { recursive: true, force: true });
  });
  const provider = new ForestAvailabilityProvider({
    baseUrl: "https://booking.forestrajasthan.com",
    timeoutMs: 2000,
    ingestStore,
    ...skipBrowserFetch,
    fetchImpl: mockFetch(
      async () =>
        new Response("<html><title>Verifying your connection</title>cloudflare</html>", {
          status: 403,
        }),
    ),
  });

  const before = await provider.getAvailability({
    park: "ranthambore",
    date: "2026-10-10",
    shift: "morning",
  });
  assert.equal(before.success, false);
  if (!before.success) assert.equal(before.error, "CAPTCHA_REQUIRED");

  const html = await readFile(htmlFixture, "utf8");
  const days = providerTest.parseBookingStats(html);
  ingestStore.set(days);

  const after = await provider.getAvailability({
    park: "ranthambore",
    date: "2026-10-10",
    shift: "morning",
  });
  assert.equal(after.success, true);
  if (!after.success) return;
  assert.equal(after.source, "browser_ingest");
  assert.ok(after.zones.some((z) => z.zone === "Zone 1" && z.availability === 24));
});
