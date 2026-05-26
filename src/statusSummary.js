import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { formatRunProgress, readRunProgress } from "./progress.js";
import { readFailureLoop } from "./workspace.js";

const MAX_FIELD_CHARS = 900;

function truncate(value, maxChars = MAX_FIELD_CHARS) {
  if (!value || value.length <= maxChars) {
    return value || "";
  }
  return `${value.slice(0, maxChars - 20)} ...[줄임]`;
}

function trimForModel(value, maxChars = 8_000) {
  const text = String(value || "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.floor(maxChars * 0.55))}\n\n...[중간 생략]...\n\n${text.slice(-Math.floor(maxChars * 0.35))}`;
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/(OPENAI_API_KEY|SLACK_[A-Z_]*TOKEN|TELEGRAM_[A-Z_]*TOKEN|GITHUB_TOKEN|GH_TOKEN|CLIENT_SECRET|PLAYLIST_ID)\s*=\s*["']?[^"'\s]+/gi, "$1=<redacted>")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "<redacted-slack-token>")
    .replace(/sk-[A-Za-z0-9_-]+/g, "<redacted-openai-key>");
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

function compactLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sentenceSafe(value, maxChars = 1_200) {
  const text = compactLine(value);
  if (text.length <= maxChars) {
    return text;
  }
  const slice = text.slice(0, maxChars);
  const matches = [...slice.matchAll(/[.!?。](?:\s|$)|(?:다|요)\.\s/g)];
  const lastMatch = matches.at(-1);
  const boundary = lastMatch ? lastMatch.index + lastMatch[0].trimEnd().length : -1;
  if (boundary > Math.floor(maxChars * 0.55)) {
    return slice.slice(0, boundary).trim();
  }
  const space = slice.lastIndexOf(" ");
  return `${slice.slice(0, space > Math.floor(maxChars * 0.55) ? space : maxChars).trim()} ...`;
}

function commandFailed(result) {
  return Boolean(result && (result.exitCode !== 0 || result.timedOut || result.aborted));
}

function compactCommandResult(result, maxChars = 2_000) {
  if (!result) {
    return null;
  }
  return {
    command: result.command || "",
    exitCode: result.exitCode ?? null,
    timedOut: Boolean(result.timedOut),
    aborted: Boolean(result.aborted),
    stdout: trimForModel(redactSensitiveText(result.stdout || ""), maxChars),
    stderr: trimForModel(redactSensitiveText(result.stderr || ""), maxChars)
  };
}

function extractCommitSubject(log) {
  const output = (log.commit || [])
    .map((result) => `${result.stdout || ""}\n${result.stderr || ""}`)
    .join("\n");
  return compactLine(output.match(/\[[^\s]+ [0-9a-f]{7,40}\]\s+(.+)/i)?.[1] || "");
}

function compactLatestVerification(log) {
  const latest = Array.isArray(log?.verification) ? log.verification.at(-1) : [];
  return (latest || []).map((result) => compactCommandResult(result, 1_500));
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
    summary: truncate(log.plan?.cycleSummary || "", 1_500),
    testIntent: log.plan?.testIntent || null,
    codexPrompt: truncate(log.plan?.codexPrompt || "", 1_500),
    commit: truncate(commitOutput, 1_500),
    commitSubject: extractCommitSubject(log),
    verification: compactLatestVerification(log),
    push: compactCommandResult(log.push, 1_200),
    ciCheck: compactCommandResult(log.ciCheck, 1_200),
    deploy: compactCommandResult(log.deploy, 1_200),
    failure: truncate(redactSensitiveText(log.failureSummary || ""), 2_500),
    failureLoop: log.failureLoop || null,
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
  const progress = readRunProgress({ ...config, workspace });
  const firstCycleStartedAt = cycles[0]?.startedAt;
  const gitStatus = run("git", ["status", "--short"], workspace);
  const branch = run("git", ["branch", "--show-current"], workspace);
  const commitsDuringRun = firstCycleStartedAt
    ? run("git", ["log", "--oneline", "--since", firstCycleStartedAt], workspace)
    : run("git", ["log", "--oneline", "-5"], workspace);
  const failureLoop = readFailureLoop({ ...config, workspace, logDir });

  return {
    workspace,
    branch: branch.stdout || "확인 불가",
    logDir,
    cycles,
    gitStatus: gitStatus.stdout || "변경 없음",
    commitsDuringRun: commitsDuringRun.stdout || "커밋 없음",
    progress,
    failureLoop,
    summaryInput: {
      currentProgress: progress,
      failureLoop,
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
    const systemPrompt =
      options.systemPrompt ||
      "너는 ai-auto 실행 결과를 한국어로 요약한다. 사용자는 최신 cycle 하나가 아니라 이번 실행 동안 누적된 최종 변경사항 전체가 궁금하다. 영어 원문을 번역하지 말고 의미만 자연스럽게 묶어서 5줄 이내로 요약해라. 실패/미완료가 있으면 마지막 줄에 짧게 말해라.";
    const userText =
      typeof summaryInput === "string"
        ? redactSensitiveText(summaryInput)
        : JSON.stringify(JSON.parse(redactSensitiveText(JSON.stringify(summaryInput))), null, 2);
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
                text: systemPrompt
              }
            ]
          },
          {
            role: "user",
            content: [{ type: "input_text", text: trimForModel(userText, options.maxInputChars || 60_000) }]
          }
        ],
        reasoning: options.reasoningEffort ? { effort: options.reasoningEffort } : undefined
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

function formatCycleFallback(input) {
  const lines = [
    `결과: ${input.outcome}`,
    input.planSummary ? `계획: ${sentenceSafe(input.planSummary, 600)}` : "",
    input.workSummary ? `작업: ${sentenceSafe(input.workSummary, 1_200)}` : "",
    input.verificationSummary ? `검증: ${input.verificationSummary}` : "",
    input.commitSubject ? `커밋: ${input.commitSubject}` : "",
    input.pushSummary ? `푸시: ${input.pushSummary}` : "",
    input.ciSummary ? `CI/CD: ${input.ciSummary}` : "",
    input.failureSummary ? `실패/차단: ${sentenceSafe(input.failureSummary, 1_200)}` : ""
  ];
  return lines.filter(Boolean).join("\n");
}

function commandSummary(result) {
  if (!result) {
    return "";
  }
  if (result.skipped) {
    return `건너뜀: ${result.reason || ""}`.trim();
  }
  const status = commandFailed(result) ? "실패" : "통과";
  return `${status}: ${result.command || "command"}${result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ""}`;
}

function buildCycleReportInput(result) {
  const log = readJsonIfExists(result.logPath) || {};
  const latestCodex = Array.isArray(log.codex) ? log.codex.at(-1) : null;
  const verification = Array.isArray(log.verification) ? log.verification.at(-1) || [] : [];
  const failedVerification = verification.find(commandFailed);
  const workOutput = trimForModel(
    redactSensitiveText(`${latestCodex?.stdout || ""}\n${latestCodex?.stderr || ""}`),
    8_000
  );
  const failureSummary = trimForModel(redactSensitiveText(log.failureSummary || ""), 5_000);

  return {
    outcome: result.outcome || log.outcome || "",
    startedAt: log.startedAt || "",
    finishedAt: log.finishedAt || "",
    planSummary: log.plan?.cycleSummary || result.plan?.cycleSummary || "",
    codexPrompt: log.plan?.codexPrompt || result.plan?.codexPrompt || "",
    workSummary: workOutput,
    verification: verification.map((item) => compactCommandResult(item, 1_500)),
    verificationSummary: failedVerification
      ? commandSummary(failedVerification)
      : verification.length
        ? "검증 명령이 통과했습니다."
        : "실행한 검증 명령이 없습니다.",
    commitSubject: extractCommitSubject(log),
    pushSummary: commandSummary(log.push),
    ciSummary: commandSummary(log.ciCheck),
    deploySummary: commandSummary(log.deploy),
    instructionsCleared: Boolean(log.instructionsCleared?.cleared),
    failureLoop: log.failureLoop || null,
    failureSummary
  };
}

export async function buildCycleReportSummary(config, result, options = {}) {
  const input = buildCycleReportInput(result);
  try {
    return await summarizeInKorean(input, config.model || "gpt-5.5", {
      ...options,
      reasoningEffort: config.reasoningEffort,
      systemPrompt: [
        "너는 ai-auto cycle 종료 보고를 한국어로 작성한다.",
        "사용자는 짧은 라벨보다 실제로 무엇을 개발/수정/검증했는지 알고 싶다.",
        "로그에 근거한 사실만 4~7문장으로 쓰고, 문장을 중간에서 끊지 마라.",
        "작업이 실패했으면 실패 원인, 차단된 환경 제약, 다음에 해야 할 일을 분명히 말해라.",
        "반복 실패가 감지되면 같은 작업을 반복하지 않도록 멈췄다는 점을 명확히 알려라.",
        "secret 값은 절대 포함하지 말고 파일명이나 설정명만 언급해라."
      ].join("\n")
    });
  } catch {
    return formatCycleFallback(input);
  }
}

export async function buildNowStatusSummary(config, root = process.cwd(), options = {}) {
  const status = collectStatusSummaryInput(config, root);
  try {
    return await summarizeInKorean(status.summaryInput, config.model || "gpt-5.5", {
      ...options,
      reasoningEffort: config.reasoningEffort,
      systemPrompt: [
        "너는 ai-auto의 /now 또는 /status 응답을 한국어로 작성한다.",
        "현재 진행 단계, 수립 중인 계획이나 구현 중인 작업, 최근 cycle에서 실제로 한 일, 실패/차단 원인을 5~8문장으로 요약해라.",
        "문장을 중간에서 끊지 말고, 'workspace clean' 같은 상태 문구로 대체하지 마라.",
        "반복 실패나 같은 실패가 보이면 그것을 명확히 말하고 다음 조치를 제안해라.",
        "secret 값은 절대 포함하지 말고 파일명이나 설정명만 언급해라."
      ].join("\n")
    });
  } catch (error) {
    return [formatRunProgress(status.progress), `요약 API 실패: ${error.message}`].filter(Boolean).join("\n");
  }
}

export function formatStatusSummary(status, koreanSummary) {
  const lines = [
    "ai-auto 최종 변경사항",
    "",
    `프로젝트: ${status.workspace}`,
    `브랜치: ${status.branch}`,
    "",
    "현재 상태",
    formatRunProgress(status.progress),
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
