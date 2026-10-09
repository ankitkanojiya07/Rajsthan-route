import type { BookingStatsDay } from "../types/availability.js";

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

function assertBookingStats(value: unknown): asserts value is BookingStatsDay[] {
  if (!Array.isArray(value)) {
    throw new FormatError("bookingStats is not an array");
  }
  for (const day of value) {
    if (!day || typeof day !== "object") {
      throw new FormatError("bookingStats day entry is invalid");
    }
    const record = day as Record<string, unknown>;
    if (typeof record.visit_date !== "string" || typeof record.zones !== "object" || !record.zones) {
      throw new FormatError("bookingStats day missing visit_date/zones");
    }
  }
}

export function parseBookingStats(htmlOrJson: string): BookingStatsDay[] {
  const trimmed = htmlOrJson.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as BookingStatsDay[];
    assertBookingStats(parsed);
    return parsed;
  }

  // Accept a pasted JS assignment or full HTML page source.
  const match = htmlOrJson.match(/bookingStats\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) {
    throw new FormatError("bookingStats assignment not found in source HTML");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    throw new FormatError("bookingStats JSON could not be parsed");
  }

  assertBookingStats(parsed);
  return parsed;
}

export function isCloudflareChallenge(status: number, body: string): boolean {
  if (status === 403 || status === 503 || status === 429) {
    const lower = body.toLowerCase();
    return (
      lower.includes("verifying your connection") ||
      lower.includes("just a moment") ||
      lower.includes("cf-browser-verification") ||
      lower.includes("cloudflare") ||
      lower.includes("turnstile") ||
      lower.includes("please wait")
    );
  }
  return false;
}
