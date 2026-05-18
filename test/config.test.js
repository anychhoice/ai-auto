import assert from "node:assert/strict";
import test from "node:test";
import { deepMerge, parseDuration } from "../src/config.js";

test("parseDuration supports common units", () => {
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("2s"), 2_000);
  assert.equal(parseDuration("3m"), 180_000);
  assert.equal(parseDuration("4h"), 14_400_000);
  assert.equal(parseDuration("1d"), 86_400_000);
});

test("parseDuration rejects invalid strings", () => {
  assert.throws(() => parseDuration("24 hours"), /Invalid duration/);
});

test("deepMerge preserves nested defaults", () => {
  const merged = deepMerge(
    {
      deploy: { enabled: false, command: "", requireCleanGit: true },
      commands: { test: ["npm test"], verify: ["npm run check"] }
    },
    {
      deploy: { enabled: true },
      commands: { test: ["pnpm test"] }
    }
  );

  assert.deepEqual(merged, {
    deploy: { enabled: true, command: "", requireCleanGit: true },
    commands: { test: ["pnpm test"], verify: ["npm run check"] }
  });
});
