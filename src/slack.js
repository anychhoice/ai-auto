import { appendInstruction, clearInstructions, readInstructions } from "./instructions.js";
import { formatRunProgress, readRunProgress } from "./progress.js";
import { buildCycleReportSummary, buildNowStatusSummary, buildWhatNowSummary } from "./statusSummary.js";

const SLACK_API = "https://slack.com/api";
const MAX_MESSAGE_LENGTH = 3500;
const KNOWN_COMMANDS = new Set(["whatnow", "status", "now", "instruct", "show", "clear", "help", "start"]);

function getSlackBotToken(config) {
  return config.slack?.botToken || process.env[config.slack?.botTokenEnv || "SLACK_BOT_TOKEN"];
}

function getSlackAppToken(config) {
  return config.slack?.appToken || process.env[config.slack?.appTokenEnv || "SLACK_APP_TOKEN"];
}

function getDefaultChannelId(config) {
  return config.slack?.channelId || "";
}

function splitMessage(text) {
  const chunks = [];
  for (let index = 0; index < text.length; index += MAX_MESSAGE_LENGTH) {
    chunks.push(text.slice(index, index + MAX_MESSAGE_LENGTH));
  }
  return chunks.length ? chunks : [text];
}

async function slackApiRequest(token, method, body) {
  if (!token) {
    throw new Error("Slack token is not configured.");
  }

  const response = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || response.statusText);
  }
  return payload;
}

export function slackReportsEnabled(config) {
  return Boolean(config.slack?.enabled && getSlackBotToken(config) && getDefaultChannelId(config));
}

export function slackCommandsEnabled(config) {
  return Boolean(
    config.slack?.enabled &&
      config.slack?.commands?.enabled &&
      getSlackBotToken(config) &&
      getSlackAppToken(config) &&
      getDefaultChannelId(config)
  );
}

export async function sendSlackMessage(config, text, channelId = getDefaultChannelId(config)) {
  if (!channelId) {
    throw new Error("Slack channel id is not configured.");
  }

  const token = getSlackBotToken(config);
  const results = [];
  for (const chunk of splitMessage(text)) {
    results.push(
      await slackApiRequest(token, "chat.postMessage", {
        channel: channelId,
        text: chunk,
        unfurl_links: false,
        unfurl_media: false
      })
    );
  }
  return results;
}

export async function sendSlackCycleReport(config, result) {
  if (!slackReportsEnabled(config) || config.slack.reportCycles === false) {
    return;
  }

  await sendSlackMessage(config, await buildCycleReportSummary(config, result, { timeoutMs: 120_000 }));
}

function stripBotMention(text) {
  return String(text || "").replace(/^<@[A-Z0-9]+>\s*/i, "").trim();
}

function normalizeCommandName(value) {
  return String(value || "").replace(/^\//, "").toLowerCase();
}

export function parseSlackCommand(text) {
  const trimmed = stripBotMention(text);
  if (!trimmed) {
    return { command: "", args: "" };
  }

  const slashMatch = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (slashMatch) {
    const command = normalizeCommandName(slashMatch[1]);
    return {
      command: KNOWN_COMMANDS.has(command) ? command : "",
      args: (slashMatch[2] || "").trim()
    };
  }

  const commandMatch = trimmed.match(/^([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!commandMatch) {
    return { command: "", args: "" };
  }

  const command = normalizeCommandName(commandMatch[1]);
  if (!KNOWN_COMMANDS.has(command)) {
    return { command: "", args: "" };
  }
  return {
    command,
    args: (commandMatch[2] || "").trim()
  };
}

export function parseSlackSlashCommand(payload) {
  const command = normalizeCommandName(payload.command);
  const text = String(payload.text || "").trim();
  if (command === "ai-auto" || command === "aiauto") {
    return parseSlackCommand(text || "help");
  }
  if (KNOWN_COMMANDS.has(command)) {
    return { command, args: text };
  }
  return parseSlackCommand(`${command} ${text}`.trim());
}

export function slackCommandAllowed(config, payload) {
  const channelId = getDefaultChannelId(config);
  if (!channelId || String(payload.channelId || "") !== String(channelId)) {
    return false;
  }

  const allowedUserIds = new Set((config.slack?.commands?.allowedUserIds || []).filter(Boolean).map(String));
  if (allowedUserIds.size && !allowedUserIds.has(String(payload.userId || ""))) {
    return false;
  }

  return true;
}

function helpText() {
  return [
    "사용 가능 명령:",
    "/whatnow 또는 /ai-auto whatnow - 현재 실행 요약",
    "/ai-auto status 또는 /now - 진행 중인 cycle 상태와 최근 작업 요약",
    "/instruct 자연어 지시 - 실행 중인 세션에 지시 추가",
    "/show - 활성 지시 확인",
    "/clear - 활성 지시 정리",
    "/ai-auto help - 명령 목록 표시"
  ].join("\n");
}

async function handleSlackCommand(config, payload, logger = console) {
  if (!slackCommandAllowed(config, payload)) {
    return;
  }

  const respond = async (text) => {
    await sendSlackMessage(config, text, payload.channelId);
  };

  if (payload.command === "whatnow") {
    try {
      await respond(["요약 생성 중입니다...", formatRunProgress(readRunProgress(config))].join("\n"));
      const summary = await buildWhatNowSummary(config, process.cwd(), { timeoutMs: 120_000 });
      await respond(summary);
    } catch (error) {
      await respond(`요약 실패: ${error.message}`);
    }
    return;
  }

  if (payload.command === "status" || payload.command === "now") {
    await respond(["상태 요약 생성 중입니다...", formatRunProgress(readRunProgress(config))].join("\n"));
    await respond(await buildNowStatusSummary(config, process.cwd(), { timeoutMs: 120_000 }));
    return;
  }

  if (payload.command === "instruct") {
    if (!payload.args) {
      await respond("사용법: instruct 자연어 지시");
      return;
    }
    const result = appendInstruction(config, payload.args);
    await respond(["지시 추가 완료", "", result.text, "", `파일: ${result.filePath}`].join("\n"));
    return;
  }

  if (payload.command === "show") {
    const instructions = readInstructions(config);
    await respond(instructions || "활성 지시가 없습니다.");
    return;
  }

  if (payload.command === "clear") {
    const result = clearInstructions(config);
    await respond(
      result.cleared
        ? `활성 지시를 정리했습니다.\narchive: ${result.archivePath}`
        : "활성 지시 파일이 없습니다."
    );
    return;
  }

  if (payload.command === "help" || payload.command === "start") {
    await respond(helpText());
    return;
  }

  logger.warn?.(`[ai-auto] ignored unknown Slack command: ${payload.command}`);
}

async function openSocketModeConnection(config) {
  const token = getSlackAppToken(config);
  const payload = await slackApiRequest(token, "apps.connections.open", {});
  if (!payload.url) {
    throw new Error("Slack Socket Mode URL was not returned.");
  }
  return payload.url;
}

function decodeSocketMessage(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return String(data || "");
}

function ackEnvelope(ws, envelopeId) {
  if (!envelopeId || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify({ envelope_id: envelopeId }));
}

function waitForSocketOpen(ws, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Slack Socket Mode connection failed."));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Slack Socket Mode closed before opening."));
    };
    const onAbort = () => {
      cleanup();
      ws.close(1000, "ai-auto stopped");
      resolve();
    };

    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
    ws.addEventListener("close", onClose, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForSocketClose(ws, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Slack Socket Mode connection errored."));
    };
    const onAbort = () => {
      cleanup();
      ws.close(1000, "ai-auto stopped");
      resolve();
    };

    ws.addEventListener("close", onClose, { once: true });
    ws.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function handleSlackEnvelope(config, ws, envelope, logger) {
  ackEnvelope(ws, envelope.envelope_id);

  if (envelope.type === "disconnect") {
    logger.warn?.(`[ai-auto] Slack Socket Mode disconnect requested: ${envelope.reason || "unknown"}`);
    ws.close(1000, "slack disconnect requested");
    return;
  }

  if (envelope.type === "events_api") {
    const event = envelope.payload?.event || {};
    if (event.bot_id || event.subtype === "bot_message") {
      return;
    }
    if (event.type !== "message" && event.type !== "app_mention") {
      return;
    }

    const parsed = parseSlackCommand(event.text || "");
    if (!parsed.command) {
      return;
    }
    await handleSlackCommand(
      config,
      {
        command: parsed.command,
        args: parsed.args,
        channelId: event.channel,
        userId: event.user
      },
      logger
    );
    return;
  }

  if (envelope.type === "slash_commands") {
    const payload = envelope.payload || {};
    const parsed = parseSlackSlashCommand(payload);
    if (!parsed.command) {
      return;
    }
    await handleSlackCommand(
      config,
      {
        command: parsed.command,
        args: parsed.args,
        channelId: payload.channel_id,
        userId: payload.user_id
      },
      logger
    );
  }
}

async function runSlackSocket(config, socketUrl, logger, signal) {
  if (typeof WebSocket !== "function") {
    throw new Error("Slack command loop requires a Node.js runtime with global WebSocket support.");
  }

  const ws = new WebSocket(socketUrl);
  const pending = new Set();
  await waitForSocketOpen(ws, signal);
  if (signal?.aborted) {
    ws.close(1000, "ai-auto stopped");
    return;
  }

  ws.addEventListener("message", (event) => {
    const task = (async () => {
      let envelope;
      try {
        envelope = JSON.parse(decodeSocketMessage(event.data));
      } catch (error) {
        logger.error(`[ai-auto] Slack socket message parse failed: ${error.message}`);
        return;
      }
      try {
        await handleSlackEnvelope(config, ws, envelope, logger);
      } catch (error) {
        logger.error(`[ai-auto] Slack command failed: ${error.message}`);
      }
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  });

  await waitForSocketClose(ws, signal);
  await Promise.allSettled([...pending]);
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

function isAbortError(error) {
  return error?.name === "AbortError";
}

export async function runSlackCommandLoop(config, logger = console, options = {}) {
  if (!slackCommandsEnabled(config)) {
    throw new Error(
      "Slack commands are disabled. Set slack.enabled, slack.commands.enabled, slack.channelId, SLACK_BOT_TOKEN, and SLACK_APP_TOKEN."
    );
  }

  const signal = options.signal;
  if (signal?.aborted) {
    return;
  }

  const reconnectDelayMs = (config.slack?.commands?.reconnectDelaySeconds || 5) * 1000;
  logger.log("[ai-auto] Slack command loop started. Send whatnow or instruct to the Slack app.");

  while (!signal?.aborted) {
    try {
      const socketUrl = await openSocketModeConnection(config);
      await runSlackSocket(config, socketUrl, logger, signal);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return;
      }
      logger.error(
        `[ai-auto] Slack command loop failed: ${error.message}. Reconnecting in ${Math.round(
          reconnectDelayMs / 1000
        )}s.`
      );
      await sleep(reconnectDelayMs, signal);
    }
  }
}
