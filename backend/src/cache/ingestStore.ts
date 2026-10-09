import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BookingStatsDay } from "../types/availability.js";
import { parseBookingStats } from "../providers/parseBookingStats.js";
import { logInfo } from "../utils/logger.js";

export type IngestSnapshot = {
  days: BookingStatsDay[];
  ingestedAt: string;
  dayCount: number;
  sourceLabel: string;
};

const DEFAULT_CACHE_PATH = path.resolve(
  process.cwd(),
  process.env.FOREST_DISK_CACHE_PATH ?? "./.forest-cache/bookingStats.json",
);

/**
 * Holds availability chart data synced from a verified browser session.
 * Also persists to disk so backend restarts keep working without re-fetch.
 */
export class BrowserIngestStore {
  private snapshot: IngestSnapshot | null = null;
  private persistence = Promise.resolve();
  private readonly ttlMs: number;
  private readonly diskPath: string;

  constructor(ttlSeconds: number, diskPath = DEFAULT_CACHE_PATH) {
    this.ttlMs = ttlSeconds * 1000;
    this.diskPath = diskPath;
  }

  async loadFromDisk(): Promise<IngestSnapshot | null> {
    try {
      const raw = await readFile(this.diskPath, "utf8");
      const days = parseBookingStats(raw);
      const metaPath = `${this.diskPath}.meta.json`;
      let ingestedAt = new Date().toISOString();
      try {
        const meta = JSON.parse(await readFile(metaPath, "utf8")) as { ingestedAt?: string };
        if (meta.ingestedAt) ingestedAt = meta.ingestedAt;
      } catch {
        // no meta file
      }
      this.snapshot = {
        days,
        ingestedAt,
        dayCount: days.length,
        sourceLabel: "disk_cache",
      };
      logInfo("availability_disk_cache_loaded", {
        path: this.diskPath,
        dayCount: days.length,
        ingestedAt,
      });
      return this.snapshot;
    } catch {
      return null;
    }
  }

  set(days: BookingStatsDay[], sourceLabel = "browser_ingest"): IngestSnapshot {
    this.snapshot = {
      days,
      ingestedAt: new Date().toISOString(),
      dayCount: days.length,
      sourceLabel,
    };
    this.persistence = this.persistToDisk(days, this.snapshot.ingestedAt);
    return this.snapshot;
  }

  async flush(): Promise<void> {
    await this.persistence;
  }

  private async persistToDisk(days: BookingStatsDay[], ingestedAt: string): Promise<void> {
    try {
      await mkdir(path.dirname(this.diskPath), { recursive: true });
      await writeFile(this.diskPath, JSON.stringify(days), "utf8");
      await writeFile(
        `${this.diskPath}.meta.json`,
        JSON.stringify({ ingestedAt, dayCount: days.length }),
        "utf8",
      );
      logInfo("availability_disk_cache_saved", {
        path: this.diskPath,
        dayCount: days.length,
      });
    } catch (error) {
      logInfo("availability_disk_cache_save_failed", {
        path: this.diskPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getFresh(): IngestSnapshot | null {
    if (!this.snapshot) return null;
    const age = Date.now() - new Date(this.snapshot.ingestedAt).getTime();
    if (age > this.ttlMs) return null;
    return this.snapshot;
  }

  /** Latest ingest even if TTL expired (used when live fetch is blocked). */
  getLatest(): IngestSnapshot | null {
    return this.snapshot;
  }

  getStatus(): {
    present: boolean;
    fresh: boolean;
    ingestedAt: string | null;
    dayCount: number;
    expiresInSeconds: number | null;
  } {
    if (!this.snapshot) {
      return {
        present: false,
        fresh: false,
        ingestedAt: null,
        dayCount: 0,
        expiresInSeconds: null,
      };
    }
    const ageMs = Date.now() - new Date(this.snapshot.ingestedAt).getTime();
    const remainingMs = this.ttlMs - ageMs;
    return {
      present: true,
      fresh: remainingMs > 0,
      ingestedAt: this.snapshot.ingestedAt,
      dayCount: this.snapshot.dayCount,
      expiresInSeconds: remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0,
    };
  }

  clear(): void {
    this.snapshot = null;
  }
}
