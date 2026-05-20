import assert from "node:assert/strict";
import test from "node:test";
import { prioritizeLatestInstruction } from "../src/orchestrator.js";

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
