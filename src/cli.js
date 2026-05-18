#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadDotEnv } from "./config.js";
import { runCycle, runLoop } from "./orchestrator.js";
import { runCommand } from "./shell.js";

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || "once";
  const options = {
    configPath: "config/ai-auto.json"
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config" || arg === "-c") {
      options.configPath = args[index + 1];
      index += 1;
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

async function main() {
  loadDotEnv();
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === "init") {
    process.exitCode = initConfig();
    return;
  }

  const config = loadConfig(options.configPath);

  if (command === "doctor") {
    process.exitCode = await doctor(config);
    return;
  }

  if (command === "once") {
    const result = await runCycle(config);
    console.log(`[ai-auto] ${result.outcome}`);
    console.log(`[ai-auto] log: ${result.logPath}`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "run") {
    await runLoop(config);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Usage: ai-auto [init|doctor|once|run] [--config config/ai-auto.json]");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
