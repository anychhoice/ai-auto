import fs from "node:fs";
import path from "node:path";
import { buildWhatNowSummary } from "./statusSummary.js";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 3900;

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

  const message = [
    "ai-auto cycle 종료",
    "",
    `결과: ${result.outcome}`,
    `로그: ${result.logPath}`,
    "",
    "자세한 누적 요약은 Telegram에서 /whatnow 를 보내거나 로컬에서 ./scripts/what-now.js 를 실행하세요."
  ].join("\n");

  await sendTelegramMessage(config, message);
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
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Number(parsed.offset || 0);
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

async function getUpdates(config, offset) {
  const token = getTelegramToken(config);
  if (!token) {
    throw new Error("Telegram bot token is not configured.");
  }

  const params = new URLSearchParams({
    timeout: String(config.telegram?.commands?.pollTimeoutSeconds || 25),
    offset: String(offset),
    allowed_updates: JSON.stringify(["message"])
  });
  const response = await fetch(`${TELEGRAM_API}/bot${token}/getUpdates?${params}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.description || response.statusText);
  }
  return payload.result || [];
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

  if (text === "/whatnow" || text.startsWith("/whatnow@")) {
    try {
      const summary = await buildWhatNowSummary(config);
      await sendTelegramMessage(config, summary, chatId);
    } catch (error) {
      await sendTelegramMessage(config, `요약 실패: ${error.message}`, chatId);
    }
    return;
  }

  if (text === "/help" || text.startsWith("/help@")) {
    await sendTelegramMessage(config, "사용 가능 명령: /whatnow", chatId);
  }
}

export async function runTelegramCommandLoop(config, logger = console) {
  if (!config.telegram?.enabled || !config.telegram?.commands?.enabled) {
    throw new Error("Telegram commands are disabled. Set telegram.enabled and telegram.commands.enabled to true.");
  }

  let offset = readOffset(config);
  logger.log("[ai-auto] Telegram command loop started. Send /whatnow to the bot.");

  while (true) {
    const updates = await getUpdates(config, offset);
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
