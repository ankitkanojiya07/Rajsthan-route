/**
 * One-time setup: opens Google Chrome and WAITS while you complete Cloudflare.
 * Saves bookingStats to .forest-cache for the dashboard.
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchBookingPageViaBrowser } from "../src/providers/browserFetcher.js";
import { parseBookingStats } from "../src/providers/parseBookingStats.js";

const baseUrl = process.env.FOREST_API_BASE_URL ?? "https://booking.forestrajasthan.com";
const profileDir = process.env.FOREST_BROWSER_PROFILE_DIR ?? "./.forest-browser-profile";
const timeoutMs = Number(process.env.FOREST_BROWSER_LOGIN_TIMEOUT ?? 300000);

console.log("══════════════════════════════════════════════════");
console.log("  Forest browser login (one-time)");
console.log("══════════════════════════════════════════════════");
console.log("Profile:", profileDir);
console.log("URL:", baseUrl);
console.log("");
console.log("A Google Chrome window will open (not Playwright Chromium).");
console.log("1. Location permission is auto-allowed for the booking site");
console.log("2. If Cloudflare Verify appears — click it (only this part is manual)");
console.log("3. OK / Okay / Close notice popups are clicked AUTOMATICALLY");
console.log("4. Wait until Availability Chart is visible — script finishes itself");
console.log("5. Do NOT close the window early");
console.log("Max wait:", Math.round(timeoutMs / 1000), "seconds");
console.log("══════════════════════════════════════════════════");

const result = await fetchBookingPageViaBrowser({
  baseUrl,
  profileDir,
  timeoutMs,
  headless: false,
  waitForHuman: true,
  channel: "chrome",
});

if (!result.ok) {
  console.error("");
  console.error("FAILED:", result.code);
  console.error(result.message);
  console.error("");
  console.error("Tips:");
  console.error("- Install Google Chrome if you don't have it");
  console.error("- Run again and click the Cloudflare checkbox quickly");
  console.error("- Make sure the Availability Chart is visible before the timeout");
  process.exit(1);
}

const days = parseBookingStats(result.html);
const cacheDir = path.resolve("./.forest-cache");
await mkdir(cacheDir, { recursive: true });
const cacheFile = path.join(cacheDir, "bookingStats.json");
await writeFile(cacheFile, JSON.stringify(days));
await writeFile(
  `${cacheFile}.meta.json`,
  JSON.stringify({ ingestedAt: new Date().toISOString(), dayCount: days.length }),
);

console.log("");
console.log(`SUCCESS — saved session with ${days.length} days of availability.`);
console.log(`Disk cache: ${cacheFile}`);
console.log("Next:");
console.log("  1. Restart backend: npm start");
console.log("  2. Open dashboard — data loads from cache");
console.log("");
