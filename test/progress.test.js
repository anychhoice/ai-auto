import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatRunProgress, readRunProgress, writeRunProgress } from "../src/progress.js";

function tempConfig() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ai-auto-progress-"));
  return {
    workspace,
    progress: { stateFile: ".ai-auto/current-status.json" }
  };
}

test("writeRunProgress stores and merges current cycle state", () => {
  const config = tempConfig();

  writeRunProgress(config, {
    running: true,
    cycleNumber: 2,
    phaseLabel: "계획 수립 중",
    detail: "planner is choosing work"
  });
  writeRunProgress(config, { phaseLabel: "검증 실행 중" });

  const progress = readRunProgress(config);
  assert.equal(progress.running, true);
  assert.equal(progress.cycleNumber, 2);
  assert.equal(progress.phaseLabel, "검증 실행 중");
  assert.equal(progress.detail, "planner is choosing work");
  assert.ok(progress.updatedAt);
});

test("formatRunProgress creates a compact human-readable status line", () => {
  const text = formatRunProgress({
    running: true,
    cycleNumber: 3,
    phaseLabel: "Codex 구현 중",
    detail: "Updating v2 routing and deployment checks.",
    cycleStartedAt: "2026-05-20T00:00:00.000Z",
    outcome: "verified"
  });

  assert.match(text, /현재: 진행 중/);
  assert.match(text, /cycle 3/);
  assert.match(text, /Codex 구현 중/);
  assert.match(text, /결과: 완료/);
});
