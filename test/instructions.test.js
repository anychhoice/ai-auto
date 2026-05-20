import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendInstruction,
  clearInstructions,
  getInstructionRevision,
  readInstructions,
  readLatestInstruction
} from "../src/instructions.js";

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-auto-instructions-"));
  return {
    instructionFile: path.join(dir, ".ai-auto", "instructions.md")
  };
}

test("appendInstruction stores natural-language instructions", () => {
  const config = tempConfig();

  appendInstruction(config, "Prioritize the login bug first.");
  const content = readInstructions(config);

  assert.match(content, /Prioritize the login bug first/);
});

test("readLatestInstruction returns the newest active instruction", () => {
  const config = tempConfig();

  appendInstruction(config, "First instruction");
  appendInstruction(config, "Second instruction\nwith detail");

  assert.equal(readLatestInstruction(config), "Second instruction\nwith detail");
});

test("getInstructionRevision changes when instructions change", () => {
  const config = tempConfig();

  const before = getInstructionRevision(config);
  appendInstruction(config, "First instruction");
  const after = getInstructionRevision(config);

  assert.notEqual(before, after);
});

test("clearInstructions archives active instructions", () => {
  const config = tempConfig();

  appendInstruction(config, "Instruction to archive");
  const result = clearInstructions(config);

  assert.equal(result.cleared, true);
  assert.equal(readInstructions(config), "");
  assert.equal(fs.existsSync(result.archivePath), true);
});
