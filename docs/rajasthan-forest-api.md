# Rajasthan Forest Safari Availability — Source Research

## 1. Official source discovered

Primary citizen-facing booking site for Ranthambore:

- https://booking.forestrajasthan.com/

Related government portals:

- https://aaranyak.forest.rajasthan.gov.in/ (Aaranyak / Wildlife Tourism)
- https://fmdss.forest.rajasthan.gov.in/ (FMDSS)
- https://apiaaranyak.forest.rajasthan.gov.in/ (API host / Swagger UI shell)
- https://forest.rajasthan.gov.in/content/raj/forest/en/citizen-services/safari-zoo-ticket-booking.html

## 2. Whether an official API exists

**No publicly documented official availability API was identified.**

Swagger UI is present at:

- https://apiaaranyak.forest.rajasthan.gov.in/swagger/ui/index

However, the discovery document:

- `http://apiaaranyak.forest.rajasthan.gov.in/swagger/docs/v1`

returns HTTP 500 (`{"Message":"An error has occurred."}`). No usable OpenAPI specification was retrieved.

## 3. Exact endpoint(s), if publicly documented

None publicly documented for zone/permit availability.

### Observed (undocumented) browser/network behaviour — not an official API

These paths appear in publicly served frontend JavaScript on `booking.forestrajasthan.com` and respond in a PostgREST-like style. They are **undocumented internal booking-app endpoints**, not a published government API contract:

| Path | Method | Notes |
|------|--------|-------|
| `/sch/fetch-schedule/` | POST | Related to schedule/inventory; parameter schema incomplete without browser session |
| `/sch/fetch-metadata/` | POST | Schedule metadata; appears to require `advancedays`, `p_brand_id`, `portal_type`, `salt` |
| `/seats/get-reserved-seats/` | POST | Reserved seats; hint mentions `p_infra_id`, `p_schedule_id`, `visit_date` |

Separately, the availability **chart** on the booking homepage embeds a JavaScript variable:

```js
const bookingStats = [
  {
    "visit_date": "2026-10-10",
    "zones": {
      "Zone 1": 24,
      "Zone 2": 0,
      "Zone 3": 0,
      // ...
    }
  }
]
```

This provider implementation reads `bookingStats` from the official page HTML when the page is reachable.

## 4. HTTP method

- Documented official availability API: **N/A**
- Embedded chart payload: delivered via **GET** HTML page load of `/`
- Undocumented schedule XHRs: **POST** (observed)

## 5. Required parameters

For the embedded chart (`bookingStats`):

- No query parameters — data for many future dates is included in the page HTML.

For undocumented schedule endpoints (observed hints only):

- `get_schedule_data_fcfs(a_event_id, duration, end_time, p_hour_diff, start_time, visit_date)`
- `get_all_schedules(advancedays, p_brand_id, portal_type, salt)`
- `get_reserved_seats(p_infra_id, p_schedule_id, visit_date)`

Exact required auth/salt/brand values are not publicly documented.

## 6. Authentication requirements

| Surface | Requirement |
|---------|-------------|
| Booking page HTML | Cloudflare bot protection / browser verification |
| Booking actions | Cloudflare Turnstile (`#cf-turnstile`) observed |
| FMDSS / Aaranyak booking | Rajasthan SSO login + CAPTCHA (per official user manual) |
| Aaranyak “Check Permit Availability” modal | Captcha image + date |
| Undocumented XHRs | Not fully characterized; automated calls are rate-limited / challenged |

This project does **not** store or bypass session cookies, CAPTCHA solutions, or Turnstile tokens.

## 7. Example request

Our backend (not government):

```http
GET /api/safari/availability?park=ranthambore&date=2026-10-10&shift=morning
```

Upstream attempt (when configured):

```http
GET https://booking.forestrajasthan.com/
Accept: text/html
```

## 8. Example response

Normalized backend response (from captured `bookingStats` fixture / browser-visible chart data):

```json
{
  "success": true,
  "source": "fixture",
  "officialApi": false,
  "park": "ranthambore",
  "date": "2026-10-10",
  "shift": "morning",
  "zones": [
    { "zone": "Zone 1", "available": true, "availability": 24, "status": "available" },
    { "zone": "Zone 2", "available": false, "availability": 0, "status": "full" },
    { "zone": "Zone 6", "available": true, "availability": 18, "status": "available" }
  ],
  "lastUpdated": "2026-10-05T08:30:00.000Z",
  "dataScope": "day"
}
```

Meaning of chart values:

- `number > 0`: available seat count (exact quantity from source)
- `0`: full / no seats
- `null`: unavailable/closed for that date (e.g. weekly zone closure pattern)

## 9. Availability fields

From `bookingStats.zones`:

- `Zone 1` … `Zone 10`
- Additional keys such as `Zone 6-Current` … `Zone 10-Current` appear for some dates (not used as primary morning/afternoon columns)

**Morning vs afternoon, vehicle type, and ticket category:** the embedded `bookingStats` chart is day-scoped and does not separate shifts or vehicle types. When the dashboard fetches a selected date’s zone ticket pages, the API includes separate Canter/Gypsy seat counts for each shift, plus `canterCategories` and `gypsyCategories` arrays containing available ticket categories (`tatkal`, `advance`, `current`, `premium`) and their seat counts. The dashboard shows these as colored category tags beside each available vehicle/shift count. Those counts are cached by date; selecting another date fetches its counts if not already cached. The original chart count is preserved separately as `dayAvailability` and shown in the Day seats column. Dates not yet scraped show the Day seats figure while shift counts are fetched; unavailable shift values remain unknown rather than being inferred from day totals.

## 10. Rate limits, if known

- Cloudflare returns **429** / challenge pages under repeated automated requests.
- No published official API rate limit document was found.
- Our backend defaults to caching (`AVAILABILITY_CACHE_TTL=300`) and rate-limits `/api/safari/availability` (30 req/min/IP).

## 11. Whether third-party use appears permitted

No public license or developer terms authorizing third-party automated inventory harvesting were found.

The official booking UX is intended for human visitors. Automated bulk access is actively hindered by Cloudflare and CAPTCHA/Turnstile.

Recommended approach: seek written permission / partnership from Rajasthan Forest Department / RTR booking operators before production-scale automation.

## 12. Limitations

1. **No official documented API.**
2. **Cloudflare blocks server-side page fetches** (verified: HTTP 403 “Verifying your connection”).
3. **CAPTCHA / Turnstile** protect interactive booking flows.
4. **Shift granularity** is not available in the public chart payload.
5. FMDSS `InventoryReport` URL referenced in portal copy currently errors (view missing).
6. Live automated integration is **not claimed as working** until an upstream path is reachable without bypassing protections (e.g. official API access or an approved integration).

### Supported workaround (does not bypass CAPTCHA)

Use **browser sync**:

1. Open https://booking.forestrajasthan.com/ in your browser and complete Cloudflare verification normally.
2. Use the dashboard bookmarklet (“Copy Ranthambore availability”) on that tab, or paste `bookingStats` JSON.
3. `POST /api/safari/ingest` stores the chart data in the backend ingest cache.
4. `GET /api/safari/availability` then serves from the browser-synced snapshot.

This uses data your browser already received after human verification. It does **not** solve or circumvent Cloudflare/Turnstile.

## 13. Recommended production approach

1. Request an official availability API / data feed from Rajasthan Forest Department / booking operator.
2. Keep `ForestAvailabilityProvider` as the isolation layer so the rest of the app can switch to an official contract later.
3. Until then, run the dashboard against:
   - mocked/fixture data for development and CI, or
   - a manually approved integration path that does not bypass CAPTCHA/Cloudflare.
4. Continue caching aggressively and never call upstream from browsers with secrets.
