import { defineConfig } from "../../../src/config.ts";
import { crashWorkflow, slowWorkflow } from "./workflows.ts";

export default defineConfig({
  dbPath: process.env.MINI_RESTATE_DB ?? ".mini-restate/crash-app.sqlite",
  workflows: [crashWorkflow, slowWorkflow],
  runner: {
    leaseTtlMs: Number(process.env.MINI_RESTATE_LEASE_TTL_MS ?? 300),
  },
  logLevel: "error",
});
