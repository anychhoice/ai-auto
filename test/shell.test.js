import assert from "node:assert/strict";
import test from "node:test";
import { runCommand, runProcess, summarizeCommandResult } from "../src/shell.js";

test("runCommand returns aborted result when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await runCommand("echo unreachable", { signal: controller.signal });

  assert.equal(result.exitCode, 130);
  assert.equal(result.aborted, true);
  assert.match(summarizeCommandResult(result), /\(aborted\)/);
});

test("runProcess terminates a running child on abort", async () => {
  const controller = new AbortController();
  const resultPromise = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    signal: controller.signal,
    killGraceMs: 100
  });

  setTimeout(() => controller.abort(), 25);
  const result = await resultPromise;

  assert.equal(result.exitCode, 130);
  assert.equal(result.aborted, true);
});
