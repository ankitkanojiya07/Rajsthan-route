export type ZoneStatus = "available" | "full" | "unavailable" | "unknown";
export type SafariTicketCategory = "tatkal" | "advance" | "current" | "premium";

export type SafariTicketCategorySeats = {
  category: SafariTicketCategory;
  seats: number;
};

export type ZoneAvailability = {
  zone: string;
  available: boolean;
  availability: number | null;
  status: ZoneStatus;
  dayAvailability?: {
    availability: number | null;
    status: ZoneStatus;
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
  source: string;
  officialApi: boolean;
  park: string;
  date: string;
  shift: string;
  zones: ZoneAvailability[];
  lastUpdated: string;
  dataScope: "day" | "shift";
  notes: string[];
  cache: {
    hit: boolean;
    key: string;
    ttlSeconds: number;
  };
};

export type AvailabilityError = {
  success: false;
  error: string;
  message: string;
  details?: string;
};

export type AvailabilityResponse = AvailabilitySuccess | AvailabilityError;

export type AppConfig = {
  refreshIntervalSeconds: number;
  cacheTtlSeconds: number;
  ingestTtlSeconds?: number;
  parks: Array<{ id: string; name: string }>;
  shifts: string[];
  sourceDisclaimer: string;
  fetchMode?: string;
  fetchLiveHint?: string;
  officialBookingUrl?: string;
  ingest?: {
    present: boolean;
    fresh: boolean;
    ingestedAt: string | null;
    dayCount: number;
    expiresInSeconds: number | null;
  };
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export async function fetchConfig(): Promise<AppConfig> {
  const res = await fetch(`${API_BASE}/api/config`);
  if (!res.ok) {
    throw new Error("Failed to load dashboard config");
  }
  return res.json();
}

export async function fetchAvailability(params: {
  park: string;
  date: string;
  shift: string;
}): Promise<AvailabilityResponse> {
  const query = new URLSearchParams(params);
  const res = await fetch(`${API_BASE}/api/safari/availability?${query.toString()}`);
  return res.json();
}

export async function ingestAvailability(raw: string): Promise<{
  success: boolean;
  message?: string;
  dayCount?: number;
  ingestedAt?: string;
  error?: string;
}> {
  const trimmed = raw.trim();
  const body = trimmed.startsWith("[") || trimmed.includes("bookingStats")
    ? JSON.stringify({ raw: trimmed })
    : JSON.stringify({ raw: trimmed });

  const res = await fetch(`${API_BASE}/api/safari/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return res.json();
}

export async function fetchLiveFromOfficialSite(opts?: {
  date?: string;
  includeShifts?: boolean;
}): Promise<{
  success: boolean;
  message?: string;
  dayCount?: number;
  ingestedAt?: string;
  error?: string;
  hint?: string;
  shifts?: {
    ok: boolean;
    date?: string;
    zoneCount?: number;
    message?: string;
  };
}> {
  const res = await fetch(`${API_BASE}/api/safari/fetch-live`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date: opts?.date,
      includeShifts: opts?.includeShifts ?? true,
    }),
  });
  return res.json();
}

export async function fetchIngestStatus(): Promise<{
  success: boolean;
  ingest: AppConfig["ingest"];
  officialBookingUrl: string;
}> {
  const res = await fetch(`${API_BASE}/api/safari/ingest/status`);
  return res.json();
}

/** Bookmarklet: copies bookingStats from the official booking page to the clipboard. */
export function buildCopyBookmarklet(): string {
  const code = `(() => {
  try {
    const scripts = [...document.scripts].map(s => s.textContent || '').join('\\n');
    const m = scripts.match(/bookingStats\\s*=\\s*(\\[[\\s\\S]*?\\]);/);
    if (!m) { alert('bookingStats not found. Wait for the page to finish loading after Cloudflare verification.'); return; }
    const json = m[1];
    JSON.parse(json);
    navigator.clipboard.writeText(json).then(() => {
      alert('Copied ' + JSON.parse(json).length + ' days of availability. Return to Rajasthan Routes and click Paste & sync.');
    }).catch(() => {
      prompt('Copy this bookingStats JSON:', json);
    });
  } catch (e) {
    alert('Failed to read bookingStats: ' + e);
  }
})();`;
  return `javascript:${encodeURIComponent(code)}`;
}
