import fs from "node:fs";
import path from "node:path";
import { buildConfigInstructionContext } from "./config.js";
import { detectProjectCommands } from "./detectCommands.js";
import { readInstructions, readLatestInstruction } from "./instructions.js";
import { runCommand, runCommandList, runProcess, summarizeCommandResult } from "./shell.js";

function truncate(value, maxChars = 4_000) {
  const text = String(value || "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 20)} ...[truncated]`;
}

function compactCommandResult(result) {
  if (!result) {
    return null;
  }
  return {
    command: result.command || "",
    exitCode: result.exitCode ?? null,
    timedOut: Boolean(result.timedOut),
    aborted: Boolean(result.aborted),
    stdout: truncate(result.stdout || "", 2_000),
    stderr: truncate(result.stderr || "", 2_000)
  };
}

function readLatestCycleFailure(config) {
  try {
    if (!fs.existsSync(config.logDir)) {
      return null;
    }
    const latestFile = fs
      .readdirSync(config.logDir)
      .filter((file) => file.endsWith("-cycle.json"))
      .sort()
      .at(-1);
    if (!latestFile) {
      return null;
    }

    const log = JSON.parse(fs.readFileSync(path.join(config.logDir, latestFile), "utf8"));
    if (!log?.outcome || ["verified", "no_change_requested"].includes(log.outcome)) {
      return null;
    }

    return {
      outcome: log.outcome,
      finishedAt: log.finishedAt || "",
      planSummary: log.plan?.cycleSummary || "",
      failureSummary: truncate(log.failureSummary || "", 6_000),
      push: compactCommandResult(log.push),
      ciCheck: compactCommandResult(log.ciCheck),
      deploy: compactCommandResult(log.deploy)
    };
  } catch {
    return null;
  }
}

export async function getWorkspaceContext(config, options = {}) {
  const configInstructionContext = buildConfigInstructionContext(config);
  const statusResults = await runCommandList(config.commands.status, {
    cwd: config.workspace,
    timeoutMs: 60_000,
    signal: options.signal
  });

  const tracked = await runCommand("git ls-files", {
    cwd: config.workspace,
    timeoutMs: 60_000,
    signal: options.signal
  });

  const untracked = await runCommand("git ls-files --others --exclude-standard", {
    cwd: config.workspace,
    timeoutMs: 60_000,
    signal: options.signal
  });

  const packageJsonPath = path.join(config.workspace, "package.json");
  const packageJson = fs.existsSync(packageJsonPath)
    ? fs.readFileSync(packageJsonPath, "utf8")
    : "";

  return {
    workspace: config.workspace,
    mission: configInstructionContext.mission,
    goals: configInstructionContext.goals,
    rules: configInstructionContext.rules,
    configInstructionText: configInstructionContext.text,
    operatorInstruction: config.operatorInstruction || "",
    runState: options.runState || null,
    latestCycleFailure: readLatestCycleFailure(config),
    sessionInstructions: readInstructions(config),
    latestSessionInstruction: readLatestInstruction(config),
    detectedCommands: config.commandDiscovery.enabled
      ? detectProjectCommands(config.workspace)
      : { test: [], verify: [], reasons: [] },
    status: statusResults.map((result) => summarizeCommandResult(result, 8_000)).join("\n\n"),
    trackedFiles: tracked.stdout.trim().split(/\r?\n/).filter(Boolean).slice(0, 300),
    untrackedFiles: untracked.stdout.trim().split(/\r?\n/).filter(Boolean).slice(0, 300),
    packageJson
  };
}

export async function isGitClean(workspace, options = {}) {
  const result = await runCommand("git status --short", {
    cwd: workspace,
    timeoutMs: 60_000,
    signal: options.signal
  });
  return result.exitCode === 0 && result.stdout.trim() === "";
}

export async function commitAll(workspace, message, options = {}) {
  const add = await runProcess("git", ["add", "-A"], {
    cwd: workspace,
    timeoutMs: 60_000,
    signal: options.signal
  });
  if (add.exitCode !== 0) {
    return [add];
  }

  const commit = await runProcess("git", ["commit", "-m", message], {
    cwd: workspace,
    timeoutMs: 120_000,
    signal: options.signal
  });
  return [add, commit];
}
