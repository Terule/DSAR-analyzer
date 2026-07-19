import { defineConfig } from "prisma/config";

const url =
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_URL_DOCKER ||
  "postgres://pst:pst@localhost:5432/pst_analyser";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url,
  },
});
