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

function cycleLogFiles(logDir) {
  if (!fs.existsSync(logDir)) {
    return [];
  }
  return fs
    .readdirSync(logDir)
    .filter((file) => file.endsWith("-cycle.json"))
    .map((file) => path.join(logDir, file))
    .sort();
}

function isFailureOutcome(outcome) {
  return Boolean(outcome && !["verified", "no_change_requested"].includes(outcome));
}

function latestFailedVerification(log) {
  const latestVerification = Array.isArray(log?.verification) ? log.verification.at(-1) : [];
  return (latestVerification || []).find(
    (result) => result.exitCode !== 0 || result.timedOut || result.aborted
  );
}

function normalizeFailureText(value) {
  return String(value || "")
    .replace(/[0-9a-f]{7,40}/gi, "<hash>")
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z/g, "<timestamp>")
    .replace(/\/Users\/[^\s'"]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}

function failureEssence(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) =>
      /FAIL:|ERROR:|AssertionError|command not found|Operation not permitted|Unable to create|fetch failed|ENOTFOUND|ETIMEDOUT|Unauthorized/i.test(
        line
      )
    );
  return lines.length ? lines.slice(0, 20).join("\n") : "";
}

export function failureSignatureFromCycleLog(log) {
  const failedVerification = latestFailedVerification(log);
  const source = failedVerification || log?.ciCheck || log?.deploy || log?.push || null;
  const sourceOutput = `${source?.stderr || ""}\n${source?.stdout || ""}`;
  const essence = failureEssence(sourceOutput) || failureEssence(log?.failureSummary || "");
  const text = [
    log?.outcome || "",
    essence || sourceOutput || log?.failureSummary || source?.command || ""
  ].join("\n");
  return normalizeFailureText(text);
}

function compactFailureCycle(filePath, log) {
  const failedVerification = latestFailedVerification(log);
  return {
    file: path.basename(filePath),
    outcome: log.outcome || "",
    finishedAt: log.finishedAt || "",
    planSummary: truncate(log.plan?.cycleSummary || "", 1_000),
    failureSummary: truncate(log.failureSummary || "", 6_000),
    failedCommand: failedVerification?.command || log.ciCheck?.command || log.deploy?.command || log.push?.command || "",
    failedOutput: truncate(
      failedVerification?.stderr ||
        failedVerification?.stdout ||
        log.ciCheck?.stderr ||
        log.ciCheck?.stdout ||
        "",
      3_000
    ),
    signature: failureSignatureFromCycleLog(log)
  };
}

export function readFailureLoop(config) {
  try {
    const lookback = Math.max(1, Number(config.failureLoop?.lookbackCycles || 6));
    const entries = cycleLogFiles(config.logDir)
      .slice(-lookback)
      .map((filePath) => {
        try {
          return { filePath, log: JSON.parse(fs.readFileSync(filePath, "utf8")) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const latestEntry = entries.at(-1) || null;
    const failures = entries
      .filter((entry) => isFailureOutcome(entry.log?.outcome))
      .map((entry) => compactFailureCycle(entry.filePath, entry.log))
      .filter((entry) => entry.signature);

    const latest = failures.at(-1) || null;
    let repeatedCount = 0;
    if (latest) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (!isFailureOutcome(entries[index].log?.outcome)) {
          break;
        }
        const failure = compactFailureCycle(entries[index].filePath, entries[index].log);
        if (failure.signature !== latest.signature) {
          break;
        }
        repeatedCount += 1;
      }
    }

    const threshold = Math.max(2, Number(config.failureLoop?.maxRepeatedFailures || 3));
    return {
      enabled: config.failureLoop?.enabled !== false,
      action: config.failureLoop?.action || "stop",
      threshold,
      lookbackCycles: lookback,
      repeatedCount,
      detected:
        config.failureLoop?.enabled !== false &&
        isFailureOutcome(latestEntry?.log?.outcome) &&
        repeatedCount >= threshold,
      latest,
      recentFailures: failures
    };
  } catch {
    return {
      enabled: config.failureLoop?.enabled !== false,
      action: config.failureLoop?.action || "stop",
      threshold: Math.max(2, Number(config.failureLoop?.maxRepeatedFailures || 3)),
      lookbackCycles: Math.max(1, Number(config.failureLoop?.lookbackCycles || 6)),
      repeatedCount: 0,
      detected: false,
      latest: null,
      recentFailures: []
    };
  }
}

function readLatestCycleFailure(config) {
  try {
    const latestFile = cycleLogFiles(config.logDir).at(-1);
    if (!latestFile) {
      return null;
    }

    const log = JSON.parse(fs.readFileSync(latestFile, "utf8"));
    if (!isFailureOutcome(log?.outcome)) {
      return null;
    }

    const compact = compactFailureCycle(latestFile, log);
    return {
      ...compact,
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
    failureLoop: readFailureLoop(config),
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
