import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexPlannerPrompt,
  buildInstructionFulfillmentPrompt,
  extractJsonObject,
  normalizeCyclePlan,
  normalizeInstructionFulfillment
} from "../src/planner.js";

const validPlan = {
  cycleSummary: "Improve an existing low-scoring fixture.",
  discussion: [
    {
      role: "architect",
      position: "Target the existing golden benchmark before adding more infrastructure.",
      risk: "A narrow algorithm change may regress another fixture."
    }
  ],
  shouldModify: true,
  codexPrompt: "Inspect benchmark results, capture before metrics, improve v2 transcription behavior, then report after metrics.",
  testIntent: {
    mode: "use-existing",
    rationale: "Existing golden benchmark already measures the behavior.",
    expectedTestAreas: ["v2 keyboard transcription", "golden benchmark"]
  },
  testCommands: ["npm --prefix functions run benchmark:keyboard:golden"],
  verifyCommands: ["npm --prefix functions test", "git diff --check"],
  commitMessage: "fix(functions): improve v2 keyboard transcription",
  deployRecommendation: "Do not deploy."
};

test("extractJsonObject reads fenced or noisy planner output", () => {
  assert.deepEqual(extractJsonObject(JSON.stringify(validPlan)), validPlan);
  assert.deepEqual(extractJsonObject(`\`\`\`json\n${JSON.stringify(validPlan)}\n\`\`\``), validPlan);
  assert.deepEqual(extractJsonObject(`progress...\n${JSON.stringify(validPlan)}\nDone.`), validPlan);
  assert.deepEqual(extractJsonObject(`reading {not json}\n${JSON.stringify(validPlan)}`), validPlan);
});

test("normalizeCyclePlan validates the required planner shape", () => {
  assert.deepEqual(normalizeCyclePlan(validPlan), validPlan);
  assert.throws(
    () => normalizeCyclePlan({ ...validPlan, verifyCommands: "npm test" }),
    /verifyCommands/
  );
  assert.throws(
    () => normalizeCyclePlan({ ...validPlan, shouldModify: "true" }),
    /shouldModify/
  );
});

test("codex planner prompt makes the latest session instruction highest priority", () => {
  const prompt = buildCodexPlannerPrompt(
    { workspace: "/tmp/project", commands: { test: [], verify: [] } },
    {
      mission: "Improve the project continuously.",
      operatorInstruction: "",
      runState: null,
      latestSessionInstruction: "Check /v2 routing and deploy pending changes.",
      sessionInstructions: "Older instruction\n\nCheck /v2 routing and deploy pending changes.",
      detectedCommands: { test: [], verify: [], reasons: [] },
      status: "clean",
      trackedFiles: [],
      untrackedFiles: [],
      packageJson: ""
    }
  );

  assert.match(prompt, /latestSessionInstruction is the highest-priority live operator instruction/);
  assert.match(prompt, /Check \/v2 routing and deploy pending changes/);
});

test("instruction fulfillment planner prompt asks for a strict post-cycle verdict", () => {
  const prompt = buildInstructionFulfillmentPrompt(
    { workspace: "/tmp/project" },
    {
      outcome: "verified",
      latestSessionInstructionAtPlan: "Check /v2 routing.",
      sessionInstructionsAtPlan: "Check /v2 routing.",
      plan: { cycleSummary: "Verified /v2 routing.", codexPrompt: "Check route." },
      codex: [{ exitCode: 0, stdout: "Confirmed /v2 routes to v2 UI.", stderr: "" }],
      verification: [[{ command: "npm test", exitCode: 0 }]]
    }
  );

  assert.match(prompt, /post-cycle planner\/verifier/);
  assert.match(prompt, /fulfilled=true only if/);
  assert.match(prompt, /Check \/v2 routing/);
});

test("normalizeInstructionFulfillment validates the verifier shape", () => {
  assert.deepEqual(normalizeInstructionFulfillment({
    fulfilled: true,
    reason: "The cycle verified /v2 routing."
  }), {
    fulfilled: true,
    reason: "The cycle verified /v2 routing."
  });
  assert.throws(
    () => normalizeInstructionFulfillment({ fulfilled: "yes", reason: "ok" }),
    /fulfilled/
  );
});
