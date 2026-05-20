import fs from "node:fs";
import path from "node:path";

const DEFAULT_PROGRESS_FILE = ".ai-auto/current-status.json";

function progressFilePath(config) {
  const stateFile = config.progress?.stateFile || DEFAULT_PROGRESS_FILE;
  return path.isAbsolute(stateFile) ? stateFile : path.resolve(config.workspace, stateFile);
}

function compactWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value, maxChars = 220) {
  const text = compactWhitespace(value);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 10)} ...[줄임]`;
}

export function readRunProgress(config) {
  const filePath = progressFilePath(config);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function writeRunProgress(config, patch) {
  const filePath = progressFilePath(config);
  const previous = readRunProgress(config) || {};
  const next = {
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return { filePath, progress: next };
}

export function formatRunProgress(progress) {
  if (!progress) {
    return "현재 진행 상태 기록이 없습니다.";
  }

  const state = progress.running ? "진행 중" : "대기/완료";
  const cycle = progress.cycleNumber ? `cycle ${progress.cycleNumber}` : "cycle ?";
  const phase = progress.phaseLabel || progress.phase || "상태 확인 중";
  const detail = truncate(progress.detail || progress.planSummary || "");
  const started = progress.cycleStartedAt || progress.runStartedAt || "";
  const outcome = progress.outcome ? `결과: ${progress.outcome}` : "";
  const log = progress.logPath ? `로그: ${path.basename(progress.logPath)}` : "";

  return [`현재: ${state} | ${cycle} | ${phase}`, detail, started ? `시작: ${started}` : "", outcome, log]
    .filter(Boolean)
    .join(" | ");
}
