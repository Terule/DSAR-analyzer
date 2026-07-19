import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

const connectionString =
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_URL_DOCKER ||
  "postgres://pst:pst@localhost:5432/pst_analyser";

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
