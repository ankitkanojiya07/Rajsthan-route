# RajsthanRoutes — Ranthambore Safari Availability Dashboard

Personal dashboard + backend that checks Ranthambore safari zone availability through your own API, with caching.

> **Important:** No publicly documented official Forest Department availability API was identified. Live server-side fetches of `booking.forestrajasthan.com` are blocked by Cloudflare. See `docs/rajasthan-forest-api.md`.

## Stack

- Backend: Node.js + Express + TypeScript
- Frontend: Vite + React + TypeScript
- Cache: in-memory abstraction (Redis-ready interface)

## Quick start

```bash
# Backend
cd backend
cp .env.example .env
# For local demo without live upstream access:
# set FOREST_USE_FIXTURE_ONLY=true
# set FOREST_HTML_FIXTURE_PATH=./src/__tests__/fixtures/booking-page.html
npm install
npm test
npm run dev

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

Open http://127.0.0.1:5173

### Why plain fetch fails (and the fix)

`booking.forestrajasthan.com` returns **403** to Node.js — Cloudflare only trusts a **real browser**.

1. One-time setup (backend folder):

```bash
npx playwright install chromium
npm run forest:login
```

Complete Cloudflare in the Chromium window that opens.

2. Restart backend (`npm start`), open dashboard, click **Fetch latest** (or it auto-tries once).

Day-level availability for all dates is read from the official page’s `bookingStats` chart. When you select a date, the dashboard fetches that date’s separate Morning/Afternoon Canter and Gypsy counts if they are not already cached. **Fetch latest** manually refreshes both sources for the selected date.

## API

`GET /api/safari/availability?park=ranthambore&date=2026-10-10&shift=morning`

## Environment

See `backend/.env.example`.
