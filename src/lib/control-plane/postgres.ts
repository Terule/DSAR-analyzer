import { Pool } from "pg";

let pool: Pool | null = null;

function parseBoolean(
  value: string | undefined,
  defaultValue = false,
): boolean {
  if (!value) return defaultValue;
  return /^(1|true|yes|on)$/i.test(value);
}

export function isControlPlaneEnabled(): boolean {
  const explicit = process.env.CONTROL_PLANE_ENABLED;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return parseBoolean(explicit, false);
  }

  return Boolean(process.env.POSTGRES_URL || process.env.POSTGRES_URL_DOCKER);
}

function getPostgresUrl(): string {
  const url =
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_URL_DOCKER ||
    "postgres://pst:pst@localhost:5432/pst_analyser";
  return url;
}

export function getControlPlanePool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getPostgresUrl(),
      max: Number.parseInt(process.env.CONTROL_PLANE_POOL_MAX || "10", 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
  }
  return pool;
}

export async function pingControlPlaneDb(): Promise<void> {
  const db = getControlPlanePool();
  await db.query("SELECT 1");
}

export async function closeControlPlanePool(): Promise<void> {
  if (!pool) return;
  const ref = pool;
  pool = null;
  await ref.end();
}
