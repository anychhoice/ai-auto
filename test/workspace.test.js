import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { failureSignatureFromCycleLog, readFailureLoop } from "../src/workspace.js";

function writeCycle(logDir, name, log) {
  fs.writeFileSync(path.join(logDir, `${name}-cycle.json`), `${JSON.stringify(log, null, 2)}\n`);
}

test("failureSignatureFromCycleLog focuses on the failed verification command", () => {
  const signature = failureSignatureFromCycleLog({
    outcome: "verification_failed",
    verification: [
      [
        { command: "npm test", exitCode: 0, stdout: "ok", stderr: "" },
        {
          command: "python3 -m unittest tests.test_repository_hygiene -v",
          exitCode: 1,
          stdout: "",
          stderr: "FAIL: local secret/config files must stay untracked"
        }
      ]
    ],
    failureSummary: "long fallback text"
  });

  assert.match(signature, /verification_failed/);
  assert.match(signature, /local secret\/config files/);
});

test("readFailureLoop detects repeated consecutive failures", () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-auto-loop-"));
  const repeatedFailure = {
    outcome: "verification_failed",
    verification: [
      [
        {
          command: "python3 -m unittest tests.test_repository_hygiene -v",
          exitCode: 1,
          stdout: "",
          stderr: "FAIL: .env and client_secret.json are still tracked"
        }
      ]
    ],
    plan: { cycleSummary: "Remove tracked local credentials." },
    failureSummary: "local credential files are still tracked"
  };

  writeCycle(logDir, "2026-05-26T00-00-00-000Z", repeatedFailure);
  writeCycle(logDir, "2026-05-26T00-01-00-000Z", repeatedFailure);
  writeCycle(logDir, "2026-05-26T00-02-00-000Z", repeatedFailure);

  const loop = readFailureLoop({
    logDir,
    failureLoop: { enabled: true, maxRepeatedFailures: 3, lookbackCycles: 6, action: "stop" }
  });

  assert.equal(loop.detected, true);
  assert.equal(loop.repeatedCount, 3);
  assert.equal(loop.latest.failedCommand, "python3 -m unittest tests.test_repository_hygiene -v");
});

test("readFailureLoop includes archived cycle logs", () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-auto-archive-loop-"));
  const archiveDir = path.join(logDir, "archive", "2026-05-26T00-03-00-000Z");
  fs.mkdirSync(archiveDir, { recursive: true });
  const repeatedFailure = {
    outcome: "verification_failed",
    verification: [
      [
        {
          command: "npm test",
          exitCode: 1,
          stdout: "",
          stderr: "AssertionError: upload manifest is missing"
        }
      ]
    ],
    plan: { cycleSummary: "Fix upload manifest." },
    failureSummary: "upload manifest is missing"
  };

  for (const name of [
    "2026-05-26T00-00-00-000Z",
    "2026-05-26T00-01-00-000Z",
    "2026-05-26T00-02-00-000Z"
  ]) {
    fs.writeFileSync(path.join(archiveDir, `${name}-cycle.json`), `${JSON.stringify(repeatedFailure)}\n`);
  }

  const loop = readFailureLoop({
    logDir,
    failureLoop: { enabled: true, maxRepeatedFailures: 3, lookbackCycles: 6, action: "stop" }
  });

  assert.equal(loop.detected, true);
  assert.equal(loop.repeatedCount, 3);
});
