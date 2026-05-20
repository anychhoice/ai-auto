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
    return "검증 없음";
  }
  const failed = latest.find((result) => result.exitCode !== 0 || result.timedOut || result.aborted);
  return failed ? `검증 실패: ${compactLine(failed.command)}` : `검증 OK ${latest.length}개`;
}

function formatCommitOneLine(log) {
  const commitResults = Array.isArray(log?.commit) ? log.commit : [];
  if (!commitResults.length) {
    return "커밋 없음";
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
  const summary = truncate(compactLine(plan.cycleSummary || plan.codexPrompt || "cycle 요약 없음"), 180);
  const failure = log?.failureSummary ? ` | 실패: ${truncate(compactLine(log.failureSummary), 140)}` : "";
  const logName = result.logPath ? path.basename(result.logPath) : "로그 없음";

  return [
    `cycle 종료: ${result.outcome}`,
    summary,
    formatVerificationOneLine(log),
    formatCommitOneLine(log),
    `로그 ${logName}${failure}`
  ].join(" | ");
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
  logger.log("[ai-auto] Telegram command loop started. Send /whatnow or /instruct to the bot.");

  while (!signal?.aborted) {
    let updates;
    try {
      updates = await getUpdates(config, offset, signal);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return;
      }
      logger.error(`[ai-auto] Telegram polling failed: ${error.message}. Retrying in ${Math.round(retryDelayMs / 1000)}s.`);
      await sleep(retryDelayMs, signal);
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
