import { defineConfig } from "../../../src/config.ts";
import { crashWorkflow, slowWorkflow } from "./workflows.ts";

export default defineConfig({
  dbPath: process.env.DUEX_DB ?? ".duex/crash-app.sqlite",
  workflows: [crashWorkflow, slowWorkflow],
  runner: {
    leaseTtlMs: Number(process.env.DUEX_LEASE_TTL_MS ?? 300),
  },
  logLevel: "error",
});
