#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { loadConfig, loadDotEnv } from "./config.js";
import { appendInstruction, clearInstructions, readInstructions } from "./instructions.js";
import { runCycle, runLoop } from "./orchestrator.js";
import { runCommand } from "./shell.js";
import { createShutdownController } from "./shutdown.js";
import { runTelegramCommandLoop, telegramCommandsEnabled } from "./telegram.js";

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || "once";
  const options = {
    configPath: "config/ai-auto.json",
    positionals: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      options.positionals.push(...args.slice(index + 1));
      break;
    } else if (arg === "--config" || arg === "-c") {
      options.configPath = args[index + 1];
      index += 1;
    } else {
      options.positionals.push(arg);
    }
  }

  return { command, options };
}

async function doctor(config) {
  const checks = [];

  checks.push({
    name: "OPENAI_API_KEY",
    ok: Boolean(process.env.OPENAI_API_KEY),
    detail: process.env.OPENAI_API_KEY ? "configured" : "missing"
  });

  const codex = await runCommand(`${config.codex.command} --version`, {
    cwd: config.workspace,
    timeoutMs: 60_000
  });
  checks.push({
    name: "Codex CLI",
    ok: codex.exitCode === 0,
    detail: (codex.stdout || codex.stderr).trim()
  });

  const git = await runCommand("git status --short", {
    cwd: config.workspace,
    timeoutMs: 60_000
  });
  checks.push({
    name: "Git workspace",
    ok: git.exitCode === 0,
    detail: git.stdout.trim() || "clean"
  });

  checks.push({
    name: "Config",
    ok: true,
    detail: `workspace=${config.workspace}, maxRuntime=${config.maxRuntime}, interval=${config.cycleInterval}`
  });

  for (const check of checks) {
    const mark = check.ok ? "OK" : "FAIL";
    console.log(`[${mark}] ${check.name}: ${check.detail}`);
  }

  return checks.every((check) => check.ok) ? 0 : 1;
}

function initConfig() {
  const target = path.resolve(process.cwd(), "config/ai-auto.json");
  const source = path.resolve(process.cwd(), "config/ai-auto.example.json");

  if (fs.existsSync(target)) {
    console.log(`Config already exists: ${target}`);
    return 0;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  console.log(`Created ${target}`);
  return 0;
}

async function readPipedStdin() {
  if (process.stdin.isTTY) {
    return "";
  }

  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
  }
  return input;
}

function startInteractiveInstructionInput(config) {
  if (!process.stdin.isTTY) {
    return null;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  console.log("[ai-auto] running. Type a natural-language instruction and press Enter.");
  console.log("[ai-auto] commands: /show, /clear, /help. Stop with Ctrl+C.");
  rl.setPrompt("[instruction] ");
  rl.prompt();

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }

    try {
      if (text === "/help") {
        console.log("[ai-auto] Type any sentence to add it as a session instruction.");
        console.log("[ai-auto] /show prints active instructions. /clear archives and clears them.");
      } else if (text === "/show") {
        const instructions = readInstructions(config);
        console.log(instructions || "[ai-auto] no active instructions");
      } else if (text === "/clear") {
        const result = clearInstructions(config);
        console.log(
          result.cleared
            ? `[ai-auto] instructions archived: ${result.archivePath}`
            : `[ai-auto] no instruction file found: ${result.filePath}`
        );
      } else {
        const result = appendInstruction(config, text);
        console.log(`[ai-auto] instruction added: ${result.filePath}`);
      }
    } catch (error) {
      console.error(`[ai-auto] failed to handle instruction: ${error.message}`);
    }

    rl.prompt();
  });

  return rl;
}

function startEmbeddedTelegramCommands(config, logger = console) {
  if (!telegramCommandsEnabled(config)) {
    return { stop: async () => {} };
  }

  const controller = new AbortController();
  const loop = runTelegramCommandLoop(config, logger, { signal: controller.signal }).catch(
    (error) => {
      if (!controller.signal.aborted) {
        logger.error(`[ai-auto] Telegram command loop stopped: ${error.message}`);
      }
    }
  );

  return {
    stop: async () => {
      controller.abort();
      await loop;
    }
  };
}

async function main() {
  loadDotEnv();
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === "init") {
    process.exitCode = initConfig();
    return;
  }

  const config = loadConfig(options.configPath);

  if (command === "instruct") {
    const instruction = options.positionals.join(" ") || (await readPipedStdin());
    const result = appendInstruction(config, instruction);
    console.log(`[ai-auto] instruction added: ${result.filePath}`);
    return;
  }

  if (command === "instructions") {
    const instructions = readInstructions(config);
    if (!instructions) {
      console.log("[ai-auto] no active instructions");
      return;
    }
    console.log(instructions);
    return;
  }

  if (command === "clear-instructions") {
    const result = clearInstructions(config);
    if (result.cleared) {
      console.log(`[ai-auto] instructions archived: ${result.archivePath}`);
    } else {
      console.log(`[ai-auto] no instruction file found: ${result.filePath}`);
    }
    return;
  }

  if (command === "doctor") {
    process.exitCode = await doctor(config);
    return;
  }

  if (command === "once") {
    const shutdown = createShutdownController();
    try {
      const result = await runCycle(config, console, { shutdown });
      console.log(`[ai-auto] ${result.outcome}`);
      console.log(`[ai-auto] log: ${result.logPath}`);
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      shutdown.dispose();
    }
    return;
  }

  if (command === "run") {
    const shutdown = createShutdownController();
    const instructionInput = startInteractiveInstructionInput(config);
    const telegramCommands = startEmbeddedTelegramCommands(config);
    try {
      await runLoop(config, console, { shutdown });
    } finally {
      await telegramCommands.stop();
      instructionInput?.close();
      shutdown.dispose();
    }
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error(
    "Usage: ai-auto [init|doctor|instruct|instructions|clear-instructions|once|run] [--config config/ai-auto.json]"
  );
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
