import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// AIDA is a coordinated Docker stack: application containers always use the
// Compose service DNS name, never operator-provided connection strings.
const connectionString = "postgres://pst:pst@postgres:5432/pst_analyser";

const adapter = new PrismaPg({ connectionString });

export const prisma =
  globalThis.__prisma ||
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}
