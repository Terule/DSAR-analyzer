/**
 * Standalone Cron Worker for Local/VPS deployments.
 * This script runs completely independently of the Next.js UI and pings the sweeper API.
 */

// Configure how often to check OpenAI (in milliseconds)
// 2 minutes = 120,000 ms
const POLL_INTERVAL_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

// The URL of your Next.js local server
const NEXT_SERVER_URL = "http://localhost:3000/api/cron";

async function runCronSweep() {
  console.log(
    `[Cron Trigger] Pinging Next.js at ${new Date().toLocaleTimeString()}...`,
  );

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const res = await fetch(NEXT_SERVER_URL, {
      method: "GET",
      // Add Authorization header here if you set a CRON_SECRET in the API route
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

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
const interval = setInterval(runCronSweep, POLL_INTERVAL_MS);

function shutdown(signal: string) {
  console.log(`[Cron Trigger] Received ${signal}. Shutting down cleanly...`);
  clearInterval(interval);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(
  `[Cron Trigger] Started successfully. Checking OpenAI batches every ${POLL_INTERVAL_MS / 60000} minutes.`,
);
