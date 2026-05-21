import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatTelegramCycleReport,
  parseTelegramCommand,
  telegramCommandsEnabled,
  telegramReportsEnabled
} from "../src/telegram.js";

test("telegramCommandsEnabled requires global and command flags", () => {
  assert.equal(telegramCommandsEnabled({ telegram: { enabled: false, commands: { enabled: true } } }), false);
  assert.equal(telegramCommandsEnabled({ telegram: { enabled: true, commands: { enabled: false } } }), false);
  assert.equal(telegramCommandsEnabled({ telegram: { enabled: true, commands: { enabled: true } } }), true);
});

test("telegramReportsEnabled requires enabled config, token, and chat id", () => {
  assert.equal(telegramReportsEnabled({ telegram: { enabled: false, botToken: "token", chatId: "1" } }), false);
  assert.equal(telegramReportsEnabled({ telegram: { enabled: true, botToken: "token", chatId: "" } }), false);
  assert.equal(telegramReportsEnabled({ telegram: { enabled: true, botToken: "token", chatId: "1" } }), true);
});

test("parseTelegramCommand supports bot suffix and multiline args", () => {
  assert.deepEqual(parseTelegramCommand("/whatnow"), { command: "whatnow", args: "" });
  assert.deepEqual(parseTelegramCommand("/instruct@AiAutoBot fix tests"), {
    command: "instruct",
    args: "fix tests"
  });
  assert.deepEqual(parseTelegramCommand("/instruct first line\nsecond line"), {
    command: "instruct",
    args: "first line\nsecond line"
  });
  assert.deepEqual(parseTelegramCommand("plain text"), { command: "", args: "" });
});

test("formatTelegramCycleReport reads cycle log details", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-auto-telegram-"));
  const logPath = path.join(dir, "cycle.json");
  fs.writeFileSync(
    logPath,
    `${JSON.stringify(
      {
        outcome: "verified",
        plan: { cycleSummary: "MusicXML 변환 회귀 테스트를 추가했습니다." },
        codex: [{ stdout: "Implemented MusicXML conversion regression coverage.", stderr: "" }],
        verification: [[{ command: "npm test", exitCode: 0, timedOut: false }]],
        commit: [
          { command: "git add -A", exitCode: 0, stdout: "", stderr: "" },
          { command: "git commit -m test", exitCode: 0, stdout: "[main abc1234] Add test\n", stderr: "" }
        ],
        instructionsCleared: { cleared: true }
      },
      null,
      2
    )}\n`
  );

  const report = formatTelegramCycleReport({ outcome: "verified", logPath });

  assert.equal(report.split(/\r?\n/).length, 1);
  assert.match(report, /^완료 ·/);
  assert.doesNotMatch(report, /verified/);
  assert.match(report, /개발: MusicXML 변환 회귀 테스트/);
  assert.match(report, /검증 통과/);
  assert.match(report, /커밋 abc1234/);
  assert.match(report, /지시 정리/);
});

test("formatTelegramCycleReport ignores clean-workspace summaries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-auto-telegram-"));
  const logPath = path.join(dir, "cycle.json");
  fs.writeFileSync(
    logPath,
    `${JSON.stringify(
      {
        outcome: "verified",
        plan: { cycleSummary: "Workspace is clean, Repo is clean." },
        codex: [{ stdout: "Workspace is clean. Repository is clean.", stderr: "" }],
        verification: [[{ command: "npm test", exitCode: 0, timedOut: false }]],
        commit: [
          {
            command: "git commit -m test",
            exitCode: 0,
            stdout: "[main def5678] fix(functions): improve v2 route reporting\n",
            stderr: ""
          }
        ]
      },
      null,
      2
    )}\n`
  );

  const report = formatTelegramCycleReport({ outcome: "verified", logPath });

  assert.doesNotMatch(report, /Workspace is clean/i);
  assert.match(report, /개발: fix\(functions\): improve v2 route reporting/);
});
