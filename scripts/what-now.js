#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();

function loadDotEnv(envPath = path.join(ROOT, ".env")) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

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

function collectSummaryInput({ latestLog, gitStatus, recentCommits }) {
  return {
    cycleOutcome: latestLog?.outcome || "no-log",
    cycleSummary: latestLog?.plan?.cycleSummary || "",
    testIntent: latestLog?.plan?.testIntent || null,
    failureSummary: latestLog?.failureSummary || "",
    changedFiles: gitStatus.stdout || "변경 없음",
    recentCommits: recentCommits.stdout || "커밋 없음"
  };
}

async function summarizeInKorean(summaryInput, model) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY가 필요합니다.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "너는 ai-auto 실행 결과를 한국어로 아주 짧게 요약한다. 사용자는 최종 변경사항만 궁금해한다. 3줄 이내로, 영어 원문을 번역하지 말고 의미만 자연스럽게 요약해라."
            }
          ]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: JSON.stringify(summaryInput, null, 2) }]
        }
      ]
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || response.statusText);
  }

  if (payload.output_text) {
    return payload.output_text.trim();
  }

  return (payload.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .join("\n")
    .trim();
}

function commitHashesOnly(logOutput) {
  return logOutput
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean)
    .join(", ");
}

async function main() {
  loadDotEnv();
  const configPath = path.join(ROOT, "config", "ai-auto.json");
  const exampleConfigPath = path.join(ROOT, "config", "ai-auto.example.json");
  const config = readJsonIfExists(configPath) || readJsonIfExists(exampleConfigPath) || {};
  const workspace = fs.realpathSync(resolveFrom(ROOT, config.workspace, "."));
  const logDir = resolveFrom(workspace, config.logDir, ".ai-auto");
  const latestLogPath = findLatestCycleLog(logDir);
  const latestLog = latestLogPath ? readJsonIfExists(latestLogPath) : null;
  const gitStatus = run("git", ["status", "--short"], workspace);
  const branch = run("git", ["branch", "--show-current"], workspace);
  const recentCommits = run("git", ["log", "--oneline", "-3"], workspace);
  const summaryInput = collectSummaryInput({ latestLog, gitStatus, recentCommits });
  const koreanSummary = await summarizeInKorean(summaryInput, config.model || "gpt-5.5");

  console.log("ai-auto 최종 변경사항");
  console.log("");
  console.log(`프로젝트: ${workspace}`);
  console.log(`브랜치: ${branch.stdout || "확인 불가"}`);
  console.log("");

  if (latestLog) {
    console.log(`최근 cycle 결과: ${latestLog.outcome || "알 수 없음"}`);
    console.log(`최근 cycle 종료: ${latestLog.finishedAt || "진행 중이거나 기록 없음"}`);
    if (koreanSummary) {
      console.log("");
      console.log(koreanSummary);
    }
    if (latestLog.failureSummary) {
      console.log(`최근 실패: ${latestLog.failureSummary.split(/\r?\n/)[0].slice(0, 180)}`);
    }
  } else {
    console.log("최근 cycle 결과: 아직 로그가 없습니다.");
  }

  console.log("");
  console.log("Git 변경 파일");
  console.log(gitStatus.stdout || "변경 없음");
  console.log("");
  console.log("최근 커밋");
  console.log(commitHashesOnly(recentCommits.stdout) || "커밋 없음");
}

main().catch((error) => {
  console.error(`요약 실패: ${error.message}`);
  process.exitCode = 1;
});
