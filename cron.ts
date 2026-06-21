/**
 * Standalone Cron Worker for Local/VPS deployments.
 * This script runs completely independently of the Next.js UI and pings the sweeper API.
 */

// Configure how often to check OpenAI (in milliseconds)
// 2 minutes = 120,000 ms
const POLL_INTERVAL_MS = 2 * 60 * 1000;

// The URL of your Next.js local server
const NEXT_SERVER_URL = "http://localhost:3000/api/cron";

async function runCronSweep() {
  console.log(
    `[Cron Trigger] Pinging Next.js at ${new Date().toLocaleTimeString()}...`,
  );

  try {
    const res = await fetch(NEXT_SERVER_URL, {
      method: "GET",
      // Add Authorization header here if you set a CRON_SECRET in the API route
      headers: {
        "Content-Type": "application/json",
      },
    });

    const data = await res.json();
    console.log(`[Cron Trigger] Result:`, data.message);
  } catch (_error) {
    console.error(
      `[Cron Trigger] Failed to reach Next.js server. Is it running?`,
    );
  }
}

// 1. Run it immediately on startup
runCronSweep();

// 2. Schedule it to run endlessly
setInterval(runCronSweep, POLL_INTERVAL_MS);

console.log(
  `[Cron Trigger] Started successfully. Checking OpenAI batches every ${POLL_INTERVAL_MS / 60000} minutes.`,
);
