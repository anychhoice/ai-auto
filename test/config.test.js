import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConfigInstructionContext,
  buildConfigInstructionSnapshot,
  deepMerge,
  normalizeInstructionList,
  parseDuration
} from "../src/config.js";

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

test("deepMerge preserves codex planner defaults", () => {
  const merged = deepMerge(
    {
      planner: {
        mode: "codex",
        fallbackToOpenAI: true,
        sandbox: "read-only",
        approvalPolicy: "never",
        timeoutMs: 1_200_000
      }
    },
    {
      planner: { fallbackToOpenAI: false }
    }
  );

  assert.deepEqual(merged, {
    planner: {
      mode: "codex",
      fallbackToOpenAI: false,
      sandbox: "read-only",
      approvalPolicy: "never",
      timeoutMs: 1_200_000
    }
  });
});

test("normalizeInstructionList accepts arrays and legacy strings", () => {
  assert.deepEqual(normalizeInstructionList([" one ", "", "two"]), ["one", "two"]);
  assert.deepEqual(normalizeInstructionList("legacy mission"), ["legacy mission"]);
  assert.deepEqual(normalizeInstructionList(null), []);
});

test("buildConfigInstructionContext separates goals, mission, and rules", () => {
  const context = buildConfigInstructionContext({
    goals: ["Improve v2 accuracy"],
    mission: "Legacy fallback mission.",
    rules: ["Never edit secrets"]
  });

  assert.deepEqual(context.goals, ["Improve v2 accuracy"]);
  assert.deepEqual(context.rules, ["Never edit secrets"]);
  assert.match(context.text, /Goals:\n1\. Improve v2 accuracy/);
  assert.match(context.text, /Legacy mission:\nLegacy fallback mission/);
  assert.match(context.text, /Must-follow rules:\n1\. Never edit secrets/);
});

test("buildConfigInstructionSnapshot gives operatorInstruction priority", () => {
  assert.deepEqual(
    buildConfigInstructionSnapshot({
      operatorInstruction: "Fix MusicXML first.",
      goals: ["Improve v2"],
      rules: ["Do not edit secrets"],
      mission: ""
    }),
    { field: "operatorInstruction", text: "Fix MusicXML first." }
  );

  const snapshot = buildConfigInstructionSnapshot({
    operatorInstruction: "",
    goals: ["Improve v2"],
    rules: ["Do not edit secrets"],
    mission: ""
  });
  assert.equal(snapshot.field, "goals+rules");
  assert.match(snapshot.text, /Improve v2/);
  assert.match(snapshot.text, /Do not edit secrets/);

  assert.deepEqual(
    buildConfigInstructionSnapshot({
      operatorInstruction: "",
      goals: [],
      rules: [],
      mission: "Legacy only"
    }),
    { field: "mission", text: "Legacy only" }
  );
});
