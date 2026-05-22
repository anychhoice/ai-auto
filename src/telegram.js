import fs from "node:fs";
import path from "node:path";
import { appendInstruction, clearInstructions, readInstructions } from "./instructions.js";
import { formatRunProgress, readRunProgress } from "./progress.js";
import { buildWhatNowSummary } from "./statusSummary.js";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 3900;
const MAX_REPORT_FIELD_LENGTH = 900;

function getTelegramToken(config) {
  return config.telegram?.botToken || process.env[config.telegram?.botTokenEnv || "TELEGRAM_BOT_TOKEN"];
}

function getDefaultChatId(config) {
  return config.telegram?.chatId || process.env[config.telegram?.chatIdEnv || "TELEGRAM_CHAT_ID"];
}

function splitMessage(text) {
  const chunks = [];
  for (let index = 0; index < text.length; index += MAX_MESSAGE_LENGTH) {
    chunks.push(text.slice(index, index + MAX_MESSAGE_LENGTH));
  }
  return chunks.length ? chunks : [text];
}

function truncate(value, maxChars = MAX_REPORT_FIELD_LENGTH) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 20)} ...[줄임]`;
}

function compactLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function classifyTelegramPollingError(error) {
  const message = `${error?.message || ""} ${error?.cause?.code || ""} ${error?.cause?.message || ""}`;
  if (/terminated by other getUpdates request|Conflict/i.test(message)) {
    return "중복 polling";
  }
  if (/webhook/i.test(message)) {
    return "webhook 충돌";
  }
  if (/Unauthorized|Not Found/i.test(message)) {
    return "봇 토큰 오류";
  }
  if (/fetch failed|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|ENOTFOUND|network/i.test(message)) {
    return "네트워크 오류";
  }
  return "polling 오류";
}

function outcomeLabel(outcome) {
  const labels = {
    verified: "완료",
    no_change_requested: "변경 없음",
    verification_failed: "검증 실패",
    test_setup_missing: "테스트 필요",
    force_shutdown: "강제 종료"
  };
  return labels[outcome] || "종료";
}

function cleanSummary(value) {
  return compactLine(value)
    .replace(/^Latest operator instruction:\s*/i, "지시: ")
    .replace(/^최신 지시:\s*/, "지시: ");
}

function isCleanlinessSummary(value) {
  return /^(workspace|repo|repository|working tree)\s+is\s+clean\b|working tree clean\b|nothing to commit\b|clean working tree\b/i.test(value);
}

function extractCommitSubject(log) {
  const commitResults = Array.isArray(log?.commit) ? log.commit : [];
  const commit = commitResults.at(-1);
  const output = `${commit?.stdout || ""}\n${commit?.stderr || ""}`.trim();
  return compactLine(output.match(/\[[^\s]+ [0-9a-f]{7,40}\]\s+(.+)/i)?.[1] || "");
}

function extractCodexWorkSummary(log) {
  const latest = Array.isArray(log?.codex) ? log.codex.at(-1) : null;
  const output = compactLine(`${latest?.stdout || ""}\n${latest?.stderr || ""}`);
  if (!output) {
    return "";
  }

  const match = output.match(/(?:구현|수정|개선|추가|변경|확인|검증|Implemented|Added|Fixed|Updated|Improved)[^.。!?\n]{0,180}/i);
  return compactLine(match?.[0] || output.slice(0, 180));
}

function formatDevelopmentSummary(log, plan) {
  const candidates = [
    plan.cycleSummary,
    extractCodexWorkSummary(log),
    extractCommitSubject(log),
    plan.codexPrompt
  ]
    .map(cleanSummary)
    .filter(Boolean)
    .filter((item) => !isCleanlinessSummary(item));

  return `개발: ${truncate(candidates[0] || "이번 cycle의 개발 요약 없음", 100)}`;
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function telegramRequest(config, method, body) {
  const token = getTelegramToken(config);
  if (!token) {
    throw new Error("Telegram bot token is not configured.");
  }

  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.description || response.statusText);
  }
  return payload.result;
}

export function telegramReportsEnabled(config) {
  return Boolean(config.telegram?.enabled && getTelegramToken(config) && getDefaultChatId(config));
}

export function telegramCommandsEnabled(config) {
  return Boolean(config.telegram?.enabled && config.telegram?.commands?.enabled);
}

export async function sendTelegramMessage(config, text, chatId = getDefaultChatId(config)) {
  if (!chatId) {
    throw new Error("Telegram chat id is not configured.");
  }

  const results = [];
  for (const chunk of splitMessage(text)) {
    results.push(
      await telegramRequest(config, "sendMessage", {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true
      })
    );
  }
  return results;
}

export async function sendTelegramCycleReport(config, result) {
  if (!telegramReportsEnabled(config) || config.telegram.reportCycles === false) {
    return;
  }

  await sendTelegramMessage(config, formatTelegramCycleReport(result));
}

function formatVerificationOneLine(log) {
  const latest = Array.isArray(log?.verification) ? log.verification.at(-1) : null;
  if (!latest?.length) {
    return "";
  }
  const failed = latest.find((result) => result.exitCode !== 0 || result.timedOut || result.aborted);
  return failed ? `검증 실패: ${truncate(compactLine(failed.command), 80)}` : "검증 통과";
}

function formatCommitOneLine(log) {
  const commitResults = Array.isArray(log?.commit) ? log.commit : [];
  if (!commitResults.length) {
    return "";
  }

  const commit = commitResults.at(-1);
  const output = `${commit?.stdout || ""}\n${commit?.stderr || ""}`.trim();
  if (commit?.exitCode === 0) {
    const hash = output.match(/\[[^\s]+ ([0-9a-f]{7,40})\]/i)?.[1];
    return hash ? `커밋 ${hash}` : "커밋 완료";
  }
  return `커밋 실패: ${truncate(compactLine(output || commit?.command || "unknown"), 120)}`;
}

export function formatTelegramCycleReport(result) {
  const log = readJsonIfExists(result.logPath);
  const plan = log?.plan || result.plan || {};
  const summary = formatDevelopmentSummary(log, plan);
  const failure = log?.failureSummary ? `실패: ${truncate(compactLine(log.failureSummary), 90)}` : "";
  const instructionsCleared = log?.instructionsCleared?.cleared ? "지시 정리" : "";

  return [
    outcomeLabel(result.outcome),
    summary,
    formatVerificationOneLine(log),
    formatCommitOneLine(log),
    instructionsCleared,
    failure
  ].filter(Boolean).join(" · ");
}

function stateFilePath(config) {
  const stateFile = config.telegram?.commands?.stateFile || ".ai-auto/telegram-offset.json";
  return path.isAbsolute(stateFile) ? stateFile : path.resolve(config.workspace, stateFile);
}

function readOffset(config) {
  const filePath = stateFilePath(config);
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Number(parsed.offset || 0);
  } catch {
    return 0;
  }
}

function writeOffset(config, offset) {
  const filePath = stateFilePath(config);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ offset }, null, 2)}\n`);
}

function allowedChatIds(config) {
  const explicit = config.telegram?.commands?.allowedChatIds || [];
  const defaultChatId = getDefaultChatId(config);
  return new Set([...explicit, defaultChatId].filter(Boolean).map(String));
}

export function parseTelegramCommand(text) {
  const match = text.trim().match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!match) {
    return { command: "", args: "" };
  }
  return {
    command: match[1].toLowerCase(),
    args: (match[2] || "").trim()
  };
}

async function getUpdates(config, offset, signal) {
  const token = getTelegramToken(config);
  if (!token) {
    throw new Error("Telegram bot token is not configured.");
  }

  const params = new URLSearchParams({
    timeout: String(config.telegram?.commands?.pollTimeoutSeconds || 25),
    offset: String(offset),
    allowed_updates: JSON.stringify(["message"])
  });
  const response = await fetch(`${TELEGRAM_API}/bot${token}/getUpdates?${params}`, { signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.description || response.statusText);
  }
  return payload.result || [];
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

async function handleTelegramCommand(config, update) {
  const message = update.message;
  const text = message?.text?.trim() || "";
  const chatId = message?.chat?.id;
  if (!chatId || !text) {
    return;
  }

  if (!allowedChatIds(config).has(String(chatId))) {
    return;
  }

  const { command, args } = parseTelegramCommand(text);

  if (command === "whatnow") {
    try {
      await sendTelegramMessage(
        config,
        ["요약 생성 중입니다...", formatRunProgress(readRunProgress(config))].join("\n"),
        chatId
      );
      const summary = await buildWhatNowSummary(config, process.cwd(), { timeoutMs: 120_000 });
      await sendTelegramMessage(config, summary, chatId);
    } catch (error) {
      await sendTelegramMessage(config, `요약 실패: ${error.message}`, chatId);
    }
    return;
  }

  if (command === "status" || command === "now") {
    await sendTelegramMessage(config, formatRunProgress(readRunProgress(config)), chatId);
    return;
  }

  if (command === "instruct") {
    if (!args) {
      await sendTelegramMessage(config, "사용법: /instruct 자연어 지시", chatId);
      return;
    }
    const result = appendInstruction(config, args);
    await sendTelegramMessage(
      config,
      ["지시 추가 완료", "", result.text, "", `파일: ${result.filePath}`].join("\n"),
      chatId
    );
    return;
  }

  if (command === "show") {
    const instructions = readInstructions(config);
    await sendTelegramMessage(config, instructions || "활성 지시가 없습니다.", chatId);
    return;
  }

  if (command === "clear") {
    const result = clearInstructions(config);
    await sendTelegramMessage(
      config,
      result.cleared
        ? `활성 지시를 정리했습니다.\narchive: ${result.archivePath}`
        : "활성 지시 파일이 없습니다.",
      chatId
    );
    return;
  }

  if (command === "help" || command === "start") {
    await sendTelegramMessage(
      config,
      [
        "사용 가능 명령:",
        "/whatnow - 현재 실행 요약",
        "/status 또는 /now - 진행 중인 cycle 상태 즉시 확인",
        "/instruct 자연어 지시 - 실행 중인 세션에 지시 추가",
        "/show - 활성 지시 확인",
        "/clear - 활성 지시 정리"
      ].join("\n"),
      chatId
    );
  }
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

export async function runTelegramCommandLoop(config, logger = console, options = {}) {
  if (!telegramCommandsEnabled(config)) {
    throw new Error("Telegram commands are disabled. Set telegram.enabled and telegram.commands.enabled to true.");
  }

  const signal = options.signal;
  if (signal?.aborted) {
    return;
  }

  let offset = readOffset(config);
  let retryDelayMs = 1_000;
  const getUpdatesFn = options.getUpdates || getUpdates;
  const sleepFn = options.sleep || sleep;
  logger.log("[ai-auto] Telegram command loop started. Send /whatnow or /instruct to the bot.");

  while (!signal?.aborted) {
    let updates;
    try {
      updates = await getUpdatesFn(config, offset, signal);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return;
      }
      const kind = classifyTelegramPollingError(error);
      logger.error(
        `[ai-auto] Telegram polling failed (${kind}): ${error.message}. Retrying in ${Math.round(retryDelayMs / 1000)}s.`
      );
      await sleepFn(retryDelayMs, signal);
      retryDelayMs = Math.min(retryDelayMs * 2, 60_000);
      continue;
    }
    retryDelayMs = 1_000;

    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      writeOffset(config, offset);
      try {
        await handleTelegramCommand(config, update);
      } catch (error) {
        logger.error(`[ai-auto] Telegram command failed: ${error.message}`);
      }
    }
  }
}
