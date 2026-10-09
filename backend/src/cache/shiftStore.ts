import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Shift } from "../types/availability.js";
import { logInfo } from "../utils/logger.js";

export type SafariTicketCategory = "tatkal" | "advance" | "current" | "premium";

export type SafariTicketCategorySeats = {
  category: SafariTicketCategory;
  seats: number;
};

export type SafariVehicleSeats = {
  canter: number | null;
  gypsy: number | null;
  canterCategories?: SafariTicketCategorySeats[];
  gypsyCategories?: SafariTicketCategorySeats[];
};

export type ZoneShiftSeats = {
  morning: SafariVehicleSeats | number | null;
  afternoon: SafariVehicleSeats | number | null;
};

export type ShiftDaySnapshot = {
  date: string;
  zones: Record<string, ZoneShiftSeats>;
  scrapedAt: string;
  source: "zone_page";
};

/**
 * Persists Morning/Afternoon Canter and Gypsy counts from each zone ticket page.
 */
export class ZoneShiftStore {
  private byDate = new Map<string, ShiftDaySnapshot>();
  private readonly diskPath: string;

  constructor(diskPath?: string) {
    this.diskPath = path.resolve(
      diskPath ??
        process.env.FOREST_SHIFT_CACHE_PATH ??
        "./.forest-cache/zoneShifts.json",
    );
  }

  async loadFromDisk(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.diskPath, "utf8")) as {
        days?: ShiftDaySnapshot[];
      };
      for (const day of raw.days ?? []) {
        if (day?.date && day.zones) this.byDate.set(day.date, day);
      }
      logInfo("zone_shift_cache_loaded", {
        path: this.diskPath,
        dayCount: this.byDate.size,
      });
    } catch {
      // no cache yet
    }
  }

  setDay(snapshot: ShiftDaySnapshot): void {
    this.byDate.set(snapshot.date, snapshot);
    void this.persist();
  }

  getDay(date: string): ShiftDaySnapshot | null {
    return this.byDate.get(date) ?? null;
  }

  getShiftSeats(
    date: string,
    zone: string,
    shift: Shift,
  ): SafariVehicleSeats | number | null | undefined {
    const day = this.byDate.get(date);
    if (!day) return undefined;
    const row = day.zones[zone];
    if (!row) return undefined;
    return row[shift];
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(path.dirname(this.diskPath), { recursive: true });
      const days = [...this.byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      await writeFile(this.diskPath, JSON.stringify({ days }, null, 2), "utf8");
      logInfo("zone_shift_cache_saved", { path: this.diskPath, dayCount: days.length });
    } catch (error) {
      logInfo("zone_shift_cache_save_failed", {
        path: this.diskPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
