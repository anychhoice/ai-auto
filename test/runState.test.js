import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  extractCommitHashFromOutput,
  findCycleLogFiles,
  prepareRunSession,
  readRunState
} from "../src/runState.js";

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("extractCommitHashFromOutput reads git commit stdout", () => {
  assert.equal(
    extractCommitHashFromOutput("[main 0d3033a] Add MusicXML golden benchmark"),
    "0d3033a"
  );
});

test("prepareRunSession clears active cycle logs and records matching final commit", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ai-auto-run-state-"));
  const logDir = path.join(workspace, ".ai-auto");
  fs.mkdirSync(logDir, { recursive: true });

  git(workspace, ["init"]);
  git(workspace, ["config", "user.email", "test@example.com"]);
  git(workspace, ["config", "user.name", "ai-auto test"]);
  fs.writeFileSync(path.join(workspace, "file.txt"), "hello\n");
  git(workspace, ["add", "file.txt"]);
  git(workspace, ["commit", "-m", "Initial commit"]);
  const head = git(workspace, ["rev-parse", "HEAD"]);
  const shortHead = git(workspace, ["rev-parse", "--short", "HEAD"]);

  const cycleLogPath = path.join(logDir, "2026-05-19T00-00-00-000Z-cycle.json");
  fs.writeFileSync(
    cycleLogPath,
    `${JSON.stringify(
      {
        outcome: "verified",
        finishedAt: "2026-05-19T00:00:00.000Z",
        commit: [
          { command: "git add -A", exitCode: 0, stdout: "", stderr: "" },
          {
            command: "git commit -m Initial commit",
            exitCode: 0,
            stdout: `[main ${shortHead}] Initial commit\n`,
            stderr: ""
          }
        ]
      },
      null,
      2
    )}\n`
  );

  const logs = [];
  const config = {
    workspace,
    logDir,
    mission: "new instruction",
    operatorInstruction: "",
    restart: {
      cleanCycleLogs: true,
      archiveCycleLogs: true,
      stateFile: ".ai-auto/run-state.json"
    }
  };

  const state = prepareRunSession(config, {
    log: (message) => logs.push(message),
    warn: (message) => logs.push(message)
  });

  assert.deepEqual(findCycleLogFiles(config), []);
  assert.equal(state.resumedFromCommit.hash, head);
  assert.equal(state.resumedFromCommit.shortHash, shortHead);
  assert.equal(state.newConfigInstruction.text, "new instruction");
  assert.equal(readRunState(config).currentHead, head);
  assert.equal(fs.existsSync(path.join(state.archiveDir, path.basename(cycleLogPath))), true);
  assert.equal(logs.some((message) => message.includes("cleared 1 previous cycle log")), true);
});
