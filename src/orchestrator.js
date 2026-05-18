import fs from "node:fs";
import path from "node:path";
import { runCodex } from "./codex.js";
import { createCyclePlan } from "./openai.js";
import { runCommand, runCommandList, summarizeCommandResult } from "./shell.js";
import { commitAll, getWorkspaceContext, isGitClean } from "./workspace.js";

function ensureLogDir(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeJsonLog(config, name, data) {
  ensureLogDir(config.logDir);
  const filePath = path.join(config.logDir, `${timestamp()}-${name}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
  return filePath;
}

function resultsPassed(results) {
  return results.every((result) => result.exitCode === 0 && !result.timedOut);
}

function summarizeResults(results) {
  return results.map((result) => summarizeCommandResult(result)).join("\n\n");
}

function buildImplementationPrompt(config, plan, attemptNumber, previousFailure) {
  return [
    "You are Codex running inside an unattended local automation loop.",
    `Workspace: ${config.workspace}`,
    "",
    "Implement the plan below with small, focused changes.",
    "Run or update tests when useful. Do not deploy. Do not modify secrets.",
    "If the plan is already satisfied, make no code changes and explain briefly.",
    "",
    `Attempt: ${attemptNumber}`,
    previousFailure ? `Previous failure:\n${previousFailure}` : "",
    "",
    "Plan:",
    JSON.stringify(plan, null, 2)
  ]
    .filter(Boolean)
    .join("\n");
}

function buildRepairPrompt(config, plan, failureSummary, attemptNumber) {
  return [
    "The previous implementation failed verification.",
    `Workspace: ${config.workspace}`,
    "Fix the failing tests or checks with the smallest reasonable change.",
    "Do not deploy. Do not modify secrets.",
    "",
    `Attempt: ${attemptNumber}`,
    "",
    "Original plan:",
    JSON.stringify(plan, null, 2),
    "",
    "Failure output:",
    failureSummary
  ].join("\n");
}

export async function runCycle(config) {
  const context = await getWorkspaceContext(config);
  const plan = await createCyclePlan(config, context);
  const cycleLog = {
    startedAt: new Date().toISOString(),
    plan,
    codex: [],
    verification: [],
    deploy: null,
    commit: null
  };

  if (!plan.shouldModify) {
    cycleLog.finishedAt = new Date().toISOString();
    cycleLog.outcome = "no_change_requested";
    const logPath = writeJsonLog(config, "cycle", cycleLog);
    return { ok: true, outcome: cycleLog.outcome, logPath, plan };
  }

  let failureSummary = "";
  let verificationResults = [];

  for (let attempt = 1; attempt <= config.maxIterationsPerCycle; attempt += 1) {
    const prompt =
      attempt === 1
        ? buildImplementationPrompt(config, plan, attempt, failureSummary)
        : buildRepairPrompt(config, plan, failureSummary, attempt);

    const codexResult = await runCodex(config, prompt);
    cycleLog.codex.push(codexResult);

    const commands = config.allowPlannerCommandOverride
      ? [
          ...(plan.testCommands.length ? plan.testCommands : config.commands.test),
          ...(plan.verifyCommands.length ? plan.verifyCommands : config.commands.verify)
        ]
      : [...config.commands.test, ...config.commands.verify];

    verificationResults = await runCommandList(commands, {
      cwd: config.workspace,
      timeoutMs: 30 * 60_000
    });
    cycleLog.verification.push(verificationResults);

    if (codexResult.exitCode === 0 && resultsPassed(verificationResults)) {
      failureSummary = "";
      break;
    }

    failureSummary = [
      codexResult.exitCode === 0 ? "" : summarizeCommandResult(codexResult),
      summarizeResults(verificationResults)
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (!resultsPassed(verificationResults)) {
    cycleLog.finishedAt = new Date().toISOString();
    cycleLog.outcome = "verification_failed";
    cycleLog.failureSummary = failureSummary;
    const logPath = writeJsonLog(config, "cycle", cycleLog);
    return { ok: false, outcome: cycleLog.outcome, logPath, plan };
  }

  if (config.autoCommit) {
    cycleLog.commit = await commitAll(config.workspace, plan.commitMessage);
  }

  if (config.deploy.enabled) {
    if (!config.deploy.command) {
      cycleLog.deploy = {
        skipped: true,
        reason: "deploy.enabled is true, but deploy.command is empty"
      };
    } else if (config.deploy.requireCleanGit && !(await isGitClean(config.workspace))) {
      cycleLog.deploy = {
        skipped: true,
        reason: "deploy.requireCleanGit is true, but the workspace has uncommitted changes"
      };
    } else {
      cycleLog.deploy = await runCommand(config.deploy.command, {
        cwd: config.workspace,
        timeoutMs: 60 * 60_000
      });
    }
  }

  cycleLog.finishedAt = new Date().toISOString();
  cycleLog.outcome = "verified";
  const logPath = writeJsonLog(config, "cycle", cycleLog);
  return { ok: true, outcome: cycleLog.outcome, logPath, plan };
}

export async function runLoop(config, logger = console) {
  const startedAt = Date.now();
  const deadline = startedAt + config.maxRuntimeMs;
  let cycleNumber = 0;

  while (Date.now() < deadline) {
    cycleNumber += 1;
    logger.log(`[ai-auto] starting cycle ${cycleNumber}`);
    const result = await runCycle(config);
    logger.log(`[ai-auto] cycle ${cycleNumber}: ${result.outcome}`);
    logger.log(`[ai-auto] log: ${result.logPath}`);

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }

    const sleepMs = Math.min(config.cycleIntervalMs, remaining);
    logger.log(`[ai-auto] sleeping ${Math.round(sleepMs / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  logger.log("[ai-auto] run window complete");
}
