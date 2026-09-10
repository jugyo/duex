import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PluginManifest } from "../../src/plugins/manifest.ts";

const base = {
  id: "example",
  entry: "./index.ts",
  config: null,
  env: {},
} as const;

const validManifests = [
  { ...base, kind: "source", trigger: { type: "poll", everyMs: 60_000 } },
  {
    ...base,
    kind: "consumer",
    trigger: { type: "events", eventTypes: ["example.changed"] },
  },
  {
    ...base,
    kind: "consumer",
    trigger: { type: "daily", at: "09:00", timezone: "Asia/Tokyo" },
  },
] satisfies PluginManifest[];

if (false) {
  const sourceWithEvents: PluginManifest = {
    ...base,
    kind: "source",
    // @ts-expect-error Source は event subscription を宣言できない。
    trigger: { type: "events", eventTypes: ["example.changed"] },
  };
  // @ts-expect-error Consumer は polling を宣言できない。
  const consumerWithPolling: PluginManifest = {
    ...base,
    kind: "consumer",
    trigger: { type: "poll", everyMs: 60_000 },
  };
  void sourceWithEvents;
  void consumerWithPolling;
}

describe("plugin manifest type contract", () => {
  it("represents the three supported kind and trigger combinations", () => {
    assert.equal(validManifests.length, 3);
  });
});
