import { Pool } from "pg";

let pool: Pool | null = null;

export function isControlPlaneEnabled(): boolean {
  return true;
}

function getPostgresUrl(): string {
  return "postgres://pst:pst@postgres:5432/pst_analyser";
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
