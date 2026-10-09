import { z } from "zod";
import type { SafariTicketCategorySeats } from "../cache/shiftStore.js";

export const ParkSchema = z.enum(["ranthambore"]);
export type Park = z.infer<typeof ParkSchema>;

export const ShiftSchema = z.enum(["morning", "afternoon"]);
export type Shift = z.infer<typeof ShiftSchema>;

export const AvailabilityQuerySchema = z.object({
  park: ParkSchema,
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .refine((value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
    }, "invalid date"),
  shift: ShiftSchema.default("morning"),
  safariType: z.string().optional(),
});

export type AvailabilityQuery = z.infer<typeof AvailabilityQuerySchema>;

export type ZoneAvailability = {
  zone: string;
  available: boolean;
  availability: number | null;
  status: "available" | "full" | "unavailable" | "unknown";
  dayAvailability?: {
    availability: number | null;
    status: "available" | "full" | "unavailable" | "unknown";
  };
  safariAvailability?: {
    canter: number | null;
    gypsy: number | null;
    canterCategories?: SafariTicketCategorySeats[];
    gypsyCategories?: SafariTicketCategorySeats[];
  } | null;
};

export type AvailabilitySuccess = {
  success: true;
  source: "undocumented_public_page" | "fixture" | "browser_ingest" | "browser_session";
  officialApi: false;
  park: Park;
  date: string;
  shift: Shift;
  safariType: string | null;
  zones: ZoneAvailability[];
  lastUpdated: string;
  /** day = bookingStats chart only; shift = zone ticket page Morning/Afternoon */
  dataScope: "day" | "shift";
  notes: string[];
  cache: {
    hit: boolean;
    key: string;
    ttlSeconds: number;
  };
};

export type AvailabilityErrorCode =
  | "INVALID_PARK"
  | "INVALID_DATE"
  | "INVALID_QUERY"
  | "AVAILABILITY_SOURCE_UNAVAILABLE"
  | "API_TIMEOUT"
  | "CAPTCHA_REQUIRED"
  | "AUTHENTICATION_REQUIRED"
  | "SOURCE_FORMAT_CHANGED"
  | "AVAILABILITY_TEMPORARILY_UNAVAILABLE"
  | "RATE_LIMITED";

export type AvailabilityError = {
  success: false;
  error: AvailabilityErrorCode;
  message: string;
  park?: string;
  date?: string;
  shift?: string;
  details?: string;
};

export type AvailabilityResult = AvailabilitySuccess | AvailabilityError;

export interface AvailabilityProvider {
  getAvailability(params: {
    park: Park;
    date: string;
    shift: Shift;
    safariType?: string;
  }): Promise<AvailabilityResult>;
}

export type BookingStatsDay = {
  visit_date: string;
  zones: Record<string, number | null>;
};
