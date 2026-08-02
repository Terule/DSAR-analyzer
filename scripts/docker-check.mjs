import fs from "node:fs";

const required = ["POSTGRES_URL", "STAGING_PATH", "EXTRACTED_PATH"];

const missing = required.filter((name) => {
  const value = process.env[name];
  return !value || String(value).trim().length === 0;
});

if (missing.length > 0) {
  console.error(
    `[Docker Check] Missing required env vars: ${missing.join(", ")}.`,
  );
  process.exit(1);
}

const ensureDir = (target) => {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
};

const stagingPath = process.env.STAGING_PATH;
const extractedPath = process.env.EXTRACTED_PATH;

const checks = [
  ["STAGING_PATH", stagingPath, false],
  ["EXTRACTED_PATH", extractedPath, false],
];

for (const [label, value, mustExist] of checks) {
  if (!value) {
    console.error(`[Docker Check] ${label} is not set.`);
    process.exit(1);
  }

  if (mustExist) {
    if (!fs.existsSync(value)) {
      console.error(
        `[Docker Check] ${label} does not exist or is not mounted: ${value}`,
      );
      process.exit(1);
    }
    continue;
  }

  ensureDir(value);
}

console.log("[Docker Check] Runtime paths and env look good.");
