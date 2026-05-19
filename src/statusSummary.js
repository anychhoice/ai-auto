import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_FIELD_CHARS = 900;

function truncate(value, maxChars = MAX_FIELD_CHARS) {
  if (!value || value.length <= maxChars) {
    return value || "";
  }
  return `${value.slice(0, maxChars - 20)} ...[줄임]`;
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

function findCycleLogs(logDir) {
  if (!fs.existsSync(logDir)) {
    return [];
  }

  return fs
    .readdirSync(logDir)
    .filter((file) => file.endsWith("-cycle.json"))
    .map((file) => path.join(logDir, file))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

function compactCycleLog(filePath) {
  const log = readJsonIfExists(filePath);
  if (!log) {
    return null;
  }

  const commitOutput = (log.commit || [])
    .map((result) => result.stdout || result.stderr || "")
    .join("\n")
    .trim();

  return {
    file: path.basename(filePath),
    startedAt: log.startedAt || "",
    finishedAt: log.finishedAt || "",
    outcome: log.outcome || "",
    summary: truncate(log.plan?.cycleSummary || ""),
    testIntent: log.plan?.testIntent || null,
    commit: truncate(commitOutput),
    failure: truncate(log.failureSummary || "", 500),
    changed: Boolean(commitOutput)
  };
}

export function commitHashesOnly(logOutput) {
  return logOutput
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean)
    .join(", ");
}

export function collectStatusSummaryInput(config, root = process.cwd()) {
  const workspace = fs.realpathSync(resolveFrom(root, config.workspace, "."));
  const logDir = resolveFrom(workspace, config.logDir, ".ai-auto");
  const cycleLogs = findCycleLogs(logDir);
  const cycles = cycleLogs.map(compactCycleLog).filter(Boolean);
  const latest = cycles.at(-1) || null;
  const firstCycleStartedAt = cycles[0]?.startedAt;
  const gitStatus = run("git", ["status", "--short"], workspace);
  const branch = run("git", ["branch", "--show-current"], workspace);
  const commitsDuringRun = firstCycleStartedAt
    ? run("git", ["log", "--oneline", "--since", firstCycleStartedAt], workspace)
    : run("git", ["log", "--oneline", "-5"], workspace);

  return {
    workspace,
    branch: branch.stdout || "확인 불가",
    logDir,
    cycles,
    gitStatus: gitStatus.stdout || "변경 없음",
    commitsDuringRun: commitsDuringRun.stdout || "커밋 없음",
    summaryInput: {
      cycleCount: cycles.length,
      range: {
        startedAt: cycles[0]?.startedAt || "",
        finishedAt: latest?.finishedAt || ""
      },
      latestOutcome: latest?.outcome || "no-log",
      cycles,
      changedFiles: gitStatus.stdout || "변경 없음",
      commitsDuringRun: commitsDuringRun.stdout || "커밋 없음"
    }
  };
}

export async function summarizeInKorean(summaryInput, model, options = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY가 필요합니다.");
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 120_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromOptions = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromOptions, { once: true });

  try {
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
                  "너는 ai-auto 실행 결과를 한국어로 요약한다. 사용자는 최신 cycle 하나가 아니라 이번 실행 동안 누적된 최종 변경사항 전체가 궁금하다. 영어 원문을 번역하지 말고 의미만 자연스럽게 묶어서 5줄 이내로 요약해라. 실패/미완료가 있으면 마지막 줄에 짧게 말해라."
              }
            ]
          },
          {
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify(summaryInput, null, 2) }]
          }
        ]
      }),
      signal: controller.signal
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
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`OpenAI 요약 요청이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromOptions);
  }
}

export function formatStatusSummary(status, koreanSummary) {
  const lines = [
    "ai-auto 최종 변경사항",
    "",
    `프로젝트: ${status.workspace}`,
    `브랜치: ${status.branch}`,
    ""
  ];

  if (status.cycles.length) {
    lines.push(
      `요약 대상: ${status.cycles.length}개 cycle (${status.cycles[0].startedAt || "시작 알 수 없음"} ~ ${status.cycles.at(-1).finishedAt || "진행 중"})`
    );
    lines.push("");
    lines.push(koreanSummary);
  } else {
    lines.push("요약 대상: 아직 cycle 로그가 없습니다.");
  }

  lines.push("");
  lines.push("Git 변경 파일");
  lines.push(status.gitStatus || "변경 없음");
  lines.push("");
  lines.push("이번 실행 커밋");
  lines.push(commitHashesOnly(status.commitsDuringRun) || "커밋 없음");

  return lines.filter((line) => line !== undefined).join("\n");
}

export async function buildWhatNowSummary(config, root = process.cwd(), options = {}) {
  const status = collectStatusSummaryInput(config, root);
  const koreanSummary = await summarizeInKorean(status.summaryInput, config.model || "gpt-5.5", options);
  return formatStatusSummary(status, koreanSummary);
}
