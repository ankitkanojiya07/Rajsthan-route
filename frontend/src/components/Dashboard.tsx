import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAvailability,
  fetchConfig,
  fetchLiveFromOfficialSite,
  type AppConfig,
  type AvailabilitySuccess,
  type SafariTicketCategorySeats,
  type ZoneAvailability,
} from "../api/client";
import { formatCount, formatUpdated, statusLabel } from "./status";

function todayISO(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatDisplayDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(`${iso}T12:00:00`));
  } catch {
    return iso;
  }
}

function summarizeShifts(
  morning: ZoneAvailability[],
  afternoon: ZoneAvailability[],
  dataScope: "day" | "shift",
): { available: number; full: number; seats: number } {
  const names = new Set<string>();
  for (const z of morning) names.add(z.zone);
  for (const z of afternoon) names.add(z.zone);

  const mMap = new Map(morning.map((z) => [z.zone, z]));
  const aMap = new Map(afternoon.map((z) => [z.zone, z]));

  let available = 0;
  let full = 0;
  let seats = 0;

  for (const name of names) {
    const m = mMap.get(name);
    const a = aMap.get(name);
    if (dataScope === "day") {
      // Day chart: count once from morning payload (same as afternoon until shifts scraped)
      const z = m ?? a;
      if (!z) continue;
      if (z.status === "available") {
        available += 1;
        seats += z.availability ?? 0;
      } else if (z.status === "full") {
        full += 1;
      }
      continue;
    }

    const open = m?.status === "available" || a?.status === "available";
    const mFull = m?.status === "full" || m?.availability === 0;
    const aFull = a?.status === "full" || a?.availability === 0;
    if (open) {
      available += 1;
      seats += (m?.status === "available" ? m.availability ?? 0 : 0) +
        (a?.status === "available" ? a.availability ?? 0 : 0);
    } else if (mFull && aFull) {
      full += 1;
    }
  }

  return { available, full, seats };
}

export function Dashboard() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [park, setPark] = useState("ranthambore");
  const [date, setDate] = useState(todayISO());
  const [morningData, setMorningData] = useState<AvailabilitySuccess | null>(null);
  const [afternoonData, setAfternoonData] = useState<AvailabilitySuccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [fetchingLive, setFetchingLive] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const autoShiftFetchKey = useRef<string | null>(null);

  useEffect(() => {
    fetchConfig()
      .then((cfg) => {
        setConfig(cfg);
        if (cfg.parks[0]) setPark(cfg.parks[0].id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function fetchLiveAndReload() {
    setFetchingLive(true);
    setStatusMessage(null);
    try {
      const live = await fetchLiveFromOfficialSite({ date, includeShifts: true });
      if (!live.success) {
        setStatusMessage(live.message ?? "Could not fetch availability.");
        return { success: false, shiftsOk: false, message: live.message ?? null };
      }
      if (live.shifts?.ok) {
        setStatusMessage(
          live.shifts.message ?? "Canter/Gypsy availability updated for Morning/Afternoon.",
        );
      } else if (live.shifts?.message) {
        setStatusMessage(`${live.message ?? "Chart updated."} ${live.shifts.message}`);
      } else {
        setStatusMessage(live.message ?? null);
      }
      return {
        success: true,
        shiftsOk: live.shifts?.ok ?? false,
        message: live.shifts?.message ?? live.message ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatusMessage(message);
      return { success: false, shiftsOk: false, message };
    } finally {
      setFetchingLive(false);
    }
  }

  async function load(tryAutoFetch = false) {
    setLoading(true);
    setError(null);
    try {
      const [morning, afternoon] = await Promise.all([
        fetchAvailability({ park, date, shift: "morning" }),
        fetchAvailability({ park, date, shift: "afternoon" }),
      ]);

      if (!morning.success) {
        const needsLiveRefresh = morning.error === "CAPTCHA_REQUIRED" ||
          (morning.error === "AVAILABILITY_TEMPORARILY_UNAVAILABLE" &&
            morning.message.includes("No availability chart data"));
        if (tryAutoFetch && needsLiveRefresh) {
          const fetchKey = `${park}:${date}`;
          if (autoShiftFetchKey.current === fetchKey) {
            setError(morning.message);
            return;
          }
          autoShiftFetchKey.current = fetchKey;
          const fetched = await fetchLiveAndReload();
          if (fetched.success) {
            await load(false);
            if (!fetched.shiftsOk) {
              setStatusMessage(`Day chart refreshed. ${fetched.message ?? "Shift counts were not available."}`);
            }
            return;
          }
        }
        setMorningData(null);
        setAfternoonData(null);
        setError(morning.message);
        return;
      }

      setMorningData(morning);
      setAfternoonData(afternoon.success ? afternoon : null);
      setLastUpdated(morning.lastUpdated);
      setError(null);

      if (tryAutoFetch && morning.dataScope !== "shift") {
        const fetchKey = `${park}:${date}`;
        if (autoShiftFetchKey.current !== fetchKey) {
          autoShiftFetchKey.current = fetchKey;
          setStatusMessage(
            "Day-chart seats are ready. Fetching this date’s Morning/Afternoon Canter and Gypsy availability…",
          );
          const fetched = await fetchLiveAndReload();
          if (fetched.success) {
            await load(false);
            if (!fetched.shiftsOk) {
              setStatusMessage(`Day chart refreshed. ${fetched.message ?? "Shift counts were not available."}`);
            }
          }
        }
      } else if (morning.dataScope !== "shift") {
        setStatusMessage(
          "Day-chart seats are shown alongside Canter/Gypsy counts. Select a date to fetch its Morning/Afternoon availability.",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [park, date]);

  useEffect(() => {
    if (!autoRefresh || !config) return;
    const ms = Math.max(60, config.refreshIntervalSeconds) * 1000;
    const id = window.setInterval(() => {
      void load();
    }, ms);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, config, park, date]);

  const morningZones = morningData?.zones ?? [];
  const afternoonZones = afternoonData?.zones ?? [];
  const dataScope = morningData?.dataScope ?? "day";

  const zoneNames = useMemo(() => {
    const names = new Set<string>();
    for (const z of morningZones) names.add(z.zone);
    for (const z of afternoonZones) names.add(z.zone);
    return [...names].sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));
  }, [morningZones, afternoonZones]);

  const morningByZone = useMemo(() => {
    const map = new Map<string, ZoneAvailability>();
    for (const z of morningZones) map.set(z.zone, z);
    return map;
  }, [morningZones]);

  const afternoonByZone = useMemo(() => {
    const map = new Map<string, ZoneAvailability>();
    for (const z of afternoonZones) map.set(z.zone, z);
    return map;
  }, [afternoonZones]);

  const summary = useMemo(
    () => summarizeShifts(morningZones, afternoonZones, dataScope),
    [morningZones, afternoonZones, dataScope],
  );
  const refreshMinutes = Math.round((config?.refreshIntervalSeconds ?? 300) / 60);

  return (
    <div className="shell">
      <div className="atmosphere" aria-hidden="true" />
      <div className="page">
        <header className="hero">
          <h1 className="brand">Ranthambore</h1>
          <p className="lede">Safari zone availability</p>
          <div className="hero-actions">
            <button
              type="button"
              className="btn btn-gold"
              onClick={async () => {
                const fetched = await fetchLiveAndReload();
                if (fetched.success) {
                  await load(false);
                  if (!fetched.shiftsOk) {
                    setStatusMessage(`Day chart refreshed. ${fetched.message ?? "Shift counts were not available."}`);
                  }
                }
              }}
              disabled={loading || fetchingLive}
            >
              {fetchingLive ? "Fetching…" : "Fetch latest"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void load(false)}
              disabled={loading || fetchingLive}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </header>

        <section className="toolbar" aria-label="Availability filters">
          <label className="field">
            <span>Park</span>
            <select value={park} onChange={(e) => setPark(e.target.value)}>
              {(config?.parks ?? [{ id: "ranthambore", name: "Ranthambore National Park" }]).map(
                (item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="field">
            <span>Safari date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <span>Auto refresh · {refreshMinutes}m</span>
          </label>
        </section>

        <section className="pulse" aria-label="Status summary">
          <div className="pulse-item">
            <span className="pulse-label">Date</span>
            <strong>{formatDisplayDate(date)}</strong>
          </div>
          <div className="pulse-item">
            <span className="pulse-label">Open</span>
            <strong className="tone-ok">{summary.available}</strong>
          </div>
          <div className="pulse-item">
            <span className="pulse-label">Full</span>
            <strong className="tone-full">{summary.full}</strong>
          </div>
          <div className="pulse-item">
            <span className="pulse-label">Seats</span>
            <strong>{summary.seats}</strong>
          </div>
          <div className="pulse-item pulse-wide">
            <span className="pulse-label">Updated</span>
            <strong>{formatUpdated(lastUpdated)}</strong>
          </div>
        </section>

        {error ? (
          <div className="banner error" role="alert">
            {error}
          </div>
        ) : null}

        {statusMessage ? <div className="banner note">{statusMessage}</div> : null}

        <section className="table-panel" aria-label="Zone availability">
          <div className="table-head">
            <h2>Safari seat availability by zone</h2>
            <span className={`scope-pill ${dataScope}`}>
              {dataScope === "shift" ? "From zone ticket pages" : "Day chart"}
            </span>
            {loading || fetchingLive ? <span className="spinner" aria-label="Loading" /> : null}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Zone</th>
                  <th colSpan={2}>Morning</th>
                  <th colSpan={2}>Afternoon</th>
                  <th>Day seats</th>
                </tr>
                <tr>
                  <th />
                  <th>Canter</th>
                  <th>Gypsy</th>
                  <th>Canter</th>
                  <th>Gypsy</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {zoneNames.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="empty">
                      {loading ? "Loading…" : "No data yet"}
                    </td>
                  </tr>
                ) : (
                  zoneNames.map((name, index) => {
                    const morning = morningByZone.get(name) ?? null;
                    const afternoon = afternoonByZone.get(name) ?? null;
                    const dayRef = morning ?? afternoon;
                    const dayZone = dayRef?.dayAvailability
                      ? {
                          ...dayRef,
                          availability: dayRef.dayAvailability.availability,
                          status: dayRef.dayAvailability.status,
                        }
                      : dayRef;
                    const dayCategories = [
                      ...(dayZone?.safariAvailability?.canterCategories ?? []),
                      ...(dayZone?.safariAvailability?.gypsyCategories ?? []),
                    ]
                      .filter((category) => category.seats > 0)
                      .filter(
                        (category, categoryIndex, allCategories) =>
                          allCategories.findIndex(
                            (candidate) => candidate.category === category.category,
                          ) === categoryIndex,
                      );
                    return (
                      <tr key={name} style={{ animationDelay: `${index * 40}ms` }}>
                        <td className="zone-cell">{name}</td>
                        <td className="safari-seat-cell">
                          {dataScope === "shift" ? (
                            <SafariSeatCell
                              seats={morning?.safariAvailability?.canter ?? null}
                              categories={morning?.safariAvailability?.canterCategories}
                            />
                          ) : (
                            <span className="badge unknown">
                              <i />
                              —
                            </span>
                          )}
                        </td>
                        <td className="safari-seat-cell">
                          {dataScope === "shift" ? (
                            <SafariSeatCell
                              seats={morning?.safariAvailability?.gypsy ?? null}
                              categories={morning?.safariAvailability?.gypsyCategories}
                            />
                          ) : (
                            <span className="badge unknown">
                              <i />
                              —
                            </span>
                          )}
                        </td>
                        <td className="safari-seat-cell">
                          {dataScope === "shift" ? (
                            <SafariSeatCell
                              seats={afternoon?.safariAvailability?.canter ?? null}
                              categories={afternoon?.safariAvailability?.canterCategories}
                            />
                          ) : (
                            <span className="badge unknown">
                              <i />
                              —
                            </span>
                          )}
                        </td>
                        <td className="safari-seat-cell">
                          {dataScope === "shift" ? (
                            <SafariSeatCell
                              seats={afternoon?.safariAvailability?.gypsy ?? null}
                              categories={afternoon?.safariAvailability?.gypsyCategories}
                            />
                          ) : (
                            <span className="badge unknown">
                              <i />
                              —
                            </span>
                          )}
                        </td>
                        <td>
                          <ShiftCell zone={dayZone} categories={dayCategories} />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function ShiftCell({
  zone,
  categories = [],
}: {
  zone: ZoneAvailability | null;
  categories?: SafariTicketCategorySeats[];
}) {
  if (!zone) {
    return (
      <span className="badge unknown">
        <i />
        Unknown
      </span>
    );
  }
  return (
    <div className="safari-seat-value">
      {categories.length > 0 ? (
        <span className="ticket-category-list" aria-label="Available ticket categories">
          {categories.map(({ category }) => (
            <span className={`ticket-category ${category}`} key={category}>
              <span className="ticket-category-label">{category}</span>
            </span>
          ))}
        </span>
      ) : null}
      <span className={`badge ${zone.status}`}>
        <i />
        <span className="badge-text">{statusLabel(zone.status)}</span>
        {zone.availability !== null ? (
          <span className="badge-count">{formatCount(zone)}</span>
        ) : null}
      </span>
    </div>
  );
}

function SafariSeatCell({
  seats,
  categories = [],
}: {
  seats: number | null;
  categories?: SafariTicketCategorySeats[];
}) {
  if (seats === null) {
    return (
      <span className="badge unknown">
        <i />
        Unknown
      </span>
    );
  }
  const status = seats > 0 ? "available" : "full";
  const availableCategories = categories.filter((category) => category.seats > 0);
  return (
    <div className="safari-seat-value">
      {availableCategories.length > 0 ? (
        <span className="ticket-category-list" aria-label="Available ticket categories">
          {availableCategories.map(({ category, seats: categorySeats }) => (
            <span className={`ticket-category ${category}`} key={category}>
              <span className="ticket-category-label">{category}</span>
              <span className="ticket-category-count">{categorySeats}</span>
            </span>
          ))}
        </span>
      ) : null}
      <span className={`badge ${status}`}>
        <i />
        <span className="badge-text">{seats > 0 ? "Available" : "Full"}</span>
        <span className="badge-count">{seats}</span>
      </span>
    </div>
  );
}
