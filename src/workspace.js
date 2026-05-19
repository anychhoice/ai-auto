import fs from "node:fs";
import path from "node:path";
import { detectProjectCommands } from "./detectCommands.js";
import { readInstructions } from "./instructions.js";
import { runCommand, runCommandList, runProcess, summarizeCommandResult } from "./shell.js";

export async function getWorkspaceContext(config, options = {}) {
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
    mission: config.mission,
    sessionInstructions: readInstructions(config),
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
