#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveFrom(base, value, fallback) {
  const target = value || fallback;
  return path.isAbsolute(target) ? target : path.resolve(base, target);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  return {
    ok: result.status === 0,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim()
  };
}

function findLatestCycleLog(logDir) {
  if (!fs.existsSync(logDir)) {
    return null;
  }

  const files = fs
    .readdirSync(logDir)
    .filter((file) => file.endsWith("-cycle.json"))
    .map((file) => path.join(logDir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  return files[0] || null;
}

function readInstructions(instructionFile) {
  if (!fs.existsSync(instructionFile)) {
    return "";
  }

  const content = fs.readFileSync(instructionFile, "utf8").trim();
  if (content.length <= 1800) {
    return content;
  }
  return `${content.slice(0, 700)}\n\n...[중략]...\n\n${content.slice(-900)}`;
}

function summarizeCommandGroup(group) {
  if (!group) {
    return "아직 실행 기록이 없습니다.";
  }

  const test = group.test?.length ? group.test.join(", ") : "감지 안 됨";
  const verify = group.verify?.length ? group.verify.join(", ") : "감지 안 됨";
  const need = group.needsTestCreation ? "테스트 셋업 필요" : "테스트 실행 가능";
  return `테스트: ${test}\n검증: ${verify}\n상태: ${need}`;
}

function main() {
  const configPath = path.join(ROOT, "config", "ai-auto.json");
  const exampleConfigPath = path.join(ROOT, "config", "ai-auto.example.json");
  const config = readJsonIfExists(configPath) || readJsonIfExists(exampleConfigPath) || {};
  const workspace = fs.realpathSync(resolveFrom(ROOT, config.workspace, "."));
  const logDir = resolveFrom(workspace, config.logDir, ".ai-auto");
  const instructionFile = resolveFrom(workspace, config.instructionFile, ".ai-auto/instructions.md");
  const latestLogPath = findLatestCycleLog(logDir);
  const latestLog = latestLogPath ? readJsonIfExists(latestLogPath) : null;
  const gitStatus = run("git", ["status", "--short"], workspace);
  const branch = run("git", ["branch", "--show-current"], workspace);
  const instructions = readInstructions(instructionFile);

  console.log("ai-auto 현재 상황 요약");
  console.log("");
  console.log(`대상 프로젝트: ${workspace}`);
  console.log(`브랜치: ${branch.stdout || "확인 불가"}`);
  console.log(`로그 위치: ${logDir}`);
  console.log("");

  if (latestLog) {
    console.log("최근 cycle");
    console.log(`- 시작: ${latestLog.startedAt || "알 수 없음"}`);
    console.log(`- 종료: ${latestLog.finishedAt || "진행 중이거나 기록 없음"}`);
    console.log(`- 결과: ${latestLog.outcome || "아직 결과 없음"}`);
    console.log(`- 요약: ${latestLog.plan?.cycleSummary || "요약 없음"}`);
    if (latestLog.plan?.testIntent) {
      console.log(`- 테스트 의도: ${latestLog.plan.testIntent.mode}`);
      console.log(`- 이유: ${latestLog.plan.testIntent.rationale}`);
    }
    console.log("");
    console.log("최근 실행/탐지된 명령");
    console.log(summarizeCommandGroup(latestLog.executedCommands?.at(-1)));
    if (latestLog.failureSummary) {
      console.log("");
      console.log("최근 실패 요약");
      console.log(latestLog.failureSummary.slice(0, 1800));
    }
  } else {
    console.log("최근 cycle");
    console.log("- 아직 cycle 로그가 없습니다.");
  }

  console.log("");
  console.log("활성 자연어 지시");
  console.log(instructions || "활성 지시가 없습니다.");
  console.log("");
  console.log("Git 변경 상태");
  console.log(gitStatus.stdout || "변경 없음");
}

main();
