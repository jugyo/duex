import { defineConfig } from "./src/config.ts";
import { fishingAdvisor } from "./src/workflows/fishing-advisor.ts";
import { helloWorkflow } from "./src/workflows/hello.ts";

export default defineConfig({
  dbPath: ".mini-restate/state.sqlite",
  workflows: [helloWorkflow, fishingAdvisor],
  http: {
    host: "127.0.0.1",
    port: 8080,
    pollIntervalMs: 1000,
  },
  runner: {
    leaseTtlMs: 60_000,
    maxRuns: 20,
  },
  logLevel: "info",
});
