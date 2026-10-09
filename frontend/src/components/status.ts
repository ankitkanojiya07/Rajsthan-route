import type { ZoneAvailability, ZoneStatus } from "../api/client";

const LABELS: Record<ZoneStatus, string> = {
  available: "Available",
  full: "Full",
  unavailable: "Unavailable",
  unknown: "Unknown",
};

export function statusLabel(status: ZoneStatus): string {
  return LABELS[status];
}

export function formatCount(zone: ZoneAvailability): string {
  if (zone.availability === null) return "—";
  return String(zone.availability);
}

export function formatUpdated(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
