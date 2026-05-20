import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendInstruction, getInstructionRevision, readInstructions } from "../src/instructions.js";
import { clearCompletedSessionInstructions, prioritizeLatestInstruction } from "../src/orchestrator.js";

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-auto-orchestrator-"));
  return {
    instructionFile: path.join(dir, ".ai-auto", "instructions.md")
  };
}

test("prioritizeLatestInstruction forces the worker to address the newest instruction", () => {
  const plan = {
    cycleSummary: "Improve a benchmark fixture.",
    shouldModify: false,
    codexPrompt: "Work on the next benchmark improvement."
  };

  const prioritized = prioritizeLatestInstruction(plan, "Check /v2 routing before benchmark work.");

  assert.equal(prioritized.shouldModify, true);
  assert.match(prioritized.cycleSummary, /Check \/v2 routing/);
  assert.match(prioritized.codexPrompt, /Highest-priority live operator instruction/);
  assert.match(prioritized.codexPrompt, /Work on this instruction first/);
});

test("clearCompletedSessionInstructions clears only after planner fulfillment", () => {
  const config = tempConfig();
  appendInstruction(config, "Check /v2 routing.");
  const cycleLog = {
    outcome: "verified",
    sessionInstructionsAtPlan: readInstructions(config),
    instructionRevisionAtPlan: getInstructionRevision(config),
    instructionFulfillment: {
      fulfilled: true,
      reason: "Planner verified the route check."
    }
  };

  const result = clearCompletedSessionInstructions(config, cycleLog, { log: () => {} });

  assert.equal(result.cleared, true);
  assert.equal(readInstructions(config), "");
  assert.equal(fs.existsSync(result.archivePath), true);
});

test("clearCompletedSessionInstructions keeps instructions without planner fulfillment", () => {
  const config = tempConfig();
  appendInstruction(config, "Check /v2 routing.");
  const cycleLog = {
    outcome: "verified",
    sessionInstructionsAtPlan: readInstructions(config),
    instructionRevisionAtPlan: getInstructionRevision(config),
    instructionFulfillment: {
      fulfilled: false,
      reason: "Only unrelated benchmark work was done."
    }
  };

  const result = clearCompletedSessionInstructions(config, cycleLog, { log: () => {} });

  assert.equal(result.cleared, false);
  assert.equal(result.skippedReason, "instruction_not_verified_as_fulfilled");
  assert.match(readInstructions(config), /Check \/v2 routing/);
});

test("clearCompletedSessionInstructions keeps newer instructions added during the cycle", () => {
  const config = tempConfig();
  appendInstruction(config, "Check /v2 routing.");
  const cycleLog = {
    outcome: "verified",
    sessionInstructionsAtPlan: readInstructions(config),
    instructionRevisionAtPlan: getInstructionRevision(config),
    instructionFulfillment: {
      fulfilled: true,
      reason: "Planner verified the route check."
    }
  };
  appendInstruction(config, "New instruction after cycle start.");

  const result = clearCompletedSessionInstructions(config, cycleLog, { log: () => {} });

  assert.equal(result.cleared, false);
  assert.equal(result.skippedReason, "instructions_changed_during_cycle");
  assert.match(readInstructions(config), /New instruction after cycle start/);
});
