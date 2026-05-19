import fs from "node:fs";
import path from "node:path";
import { consultCodex } from "./consultation.js";
import { runCodex } from "./codex.js";
import { detectProjectCommands, resolveVerificationCommands } from "./detectCommands.js";
import { getInstructionRevision, readInstructions } from "./instructions.js";
import { createCyclePlan } from "./openai.js";
import { runCommand, runCommandList, summarizeCommandResult } from "./shell.js";
import { sendTelegramCycleReport } from "./telegram.js";
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
  return results.length > 0 && results.every((result) => result.exitCode === 0 && !result.timedOut);
}

function summarizeResults(results) {
  return results.map((result) => summarizeCommandResult(result)).join("\n\n");
}

function buildImplementationPrompt(
  config,
  plan,
  attemptNumber,
  previousFailure,
  sessionInstructions,
  testPolicy
) {
  return [
    "You are Codex running inside an unattended local automation loop.",
    `Workspace: ${config.workspace}`,
    "",
    "Implement the plan below with small, focused changes.",
    "Treat plan.codexPrompt as the primary task.",
    "Run or update tests when useful. Do not deploy. Do not modify secrets.",
    testPolicy,
    "In normal cycles, make a concrete reviewable file change. Only make no code changes if the task is already fully satisfied or a safety issue blocks changes, and explain that clearly.",
    "",
    `Attempt: ${attemptNumber}`,
    sessionInstructions ? `Active natural-language session instructions:\n${sessionInstructions}` : "",
    previousFailure ? `Previous failure:\n${previousFailure}` : "",
    "",
    "Plan:",
    JSON.stringify(plan, null, 2)
  ]
    .filter(Boolean)
    .join("\n");
}

function buildRepairPrompt(config, plan, failureSummary, attemptNumber, sessionInstructions, testPolicy) {
  return [
    "The previous implementation failed verification.",
    `Workspace: ${config.workspace}`,
    "Fix the failing tests or checks with the smallest reasonable change.",
    testPolicy,
    "Do not deploy. Do not modify secrets.",
    "",
    `Attempt: ${attemptNumber}`,
    sessionInstructions ? `Active natural-language session instructions:\n${sessionInstructions}` : "",
    "",
    "Original plan:",
    JSON.stringify(plan, null, 2),
    "",
    "Failure output:",
    failureSummary
  ].join("\n");
}

export async function runCycle(config, logger = console) {
  const context = await getWorkspaceContext(config);
  logger.log("[ai-auto] consulting Codex in read-only mode");
  context.codexConsultation = await consultCodex(config, context);
  logger.log(
    `[ai-auto] Codex consultation: ${context.codexConsultation.ok ? "ok" : "failed"}`
  );
  logger.log("[ai-auto] planning implementation with OpenAI");
  const plan = await createCyclePlan(config, context);
  logger.log(`[ai-auto] plan: ${plan.shouldModify ? "modify workspace" : "no change"}`);
  const initialCommands = config.commandDiscovery.enabled
    ? resolveVerificationCommands(config, plan, context.detectedCommands)
    : {
        test: config.commands.test,
        verify: config.commands.verify,
        detected: { test: [], verify: [], reasons: [] },
        requireTests: false,
        hasRunnableTests: Boolean(config.commands.test.length),
        needsTestCreation: false,
        source: { test: "config", verify: "config" }
      };
  const initialTestPolicy = initialCommands.needsTestCreation
    ? "No runnable test command is currently detected. Before unrelated feature work, add the smallest useful test setup and a standard runnable test command for this project."
    : "Keep the existing test setup runnable, and update tests for behavior you change.";

  if (!plan.shouldModify && initialCommands.needsTestCreation) {
    plan.shouldModify = true;
    plan.cycleSummary = `${plan.cycleSummary} No runnable tests were detected, so this cycle must add a minimal test setup.`;
    plan.codexPrompt = [
      plan.codexPrompt,
      "",
      "No runnable tests were detected. First add minimal characterization or regression tests and a standard test command for this project. Keep the change small and verify it runs."
    ].join("\n");
  }

  const cycleLog = {
    startedAt: new Date().toISOString(),
    sessionInstructionsAtPlan: context.sessionInstructions,
    codexConsultation: context.codexConsultation,
    plan,
    detectedCommands: context.detectedCommands,
    executedCommands: [],
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
    const sessionInstructions = readInstructions(config);
    const prompt =
      attempt === 1
        ? buildImplementationPrompt(
            config,
            plan,
            attempt,
            failureSummary,
            sessionInstructions,
            initialTestPolicy
          )
        : buildRepairPrompt(
            config,
            plan,
            failureSummary,
            attempt,
            sessionInstructions,
            initialTestPolicy
          );

    logger.log(`[ai-auto] running Codex implementation attempt ${attempt} in ${config.codex.sandbox}`);
    const codexResult = await runCodex(config, prompt);
    cycleLog.codex.push(codexResult);

    const detectedCommands = config.commandDiscovery.enabled
      ? detectProjectCommands(config.workspace)
      : context.detectedCommands;
    const resolvedCommands = config.commandDiscovery.enabled
      ? resolveVerificationCommands(config, plan, detectedCommands)
      : {
          test: config.commands.test,
          verify: config.commands.verify,
          detected: { test: [], verify: [], reasons: [] },
          requireTests: false,
          hasRunnableTests: Boolean(config.commands.test.length),
          needsTestCreation: false,
          source: { test: "config", verify: "config" }
        };
    const commands = [...resolvedCommands.test, ...resolvedCommands.verify];
    cycleLog.executedCommands.push(resolvedCommands);

    logger.log(`[ai-auto] running ${commands.length} verification command(s)`);
    verificationResults = await runCommandList(commands, {
      cwd: config.workspace,
      timeoutMs: 30 * 60_000
    });
    cycleLog.verification.push(verificationResults);

    if (
      codexResult.exitCode === 0 &&
      resultsPassed(verificationResults) &&
      !resolvedCommands.needsTestCreation
    ) {
      failureSummary = "";
      break;
    }

    failureSummary = [
      codexResult.exitCode === 0 ? "" : summarizeCommandResult(codexResult),
      resolvedCommands.needsTestCreation
        ? "No runnable test command was detected after the Codex attempt. Add a minimal test setup and a standard test command before continuing with other improvements."
        : "",
      summarizeResults(verificationResults)
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const lastExecutedCommands = cycleLog.executedCommands.at(-1);
  if (!resultsPassed(verificationResults) || lastExecutedCommands?.needsTestCreation) {
    cycleLog.finishedAt = new Date().toISOString();
    cycleLog.outcome = lastExecutedCommands?.needsTestCreation
      ? "test_setup_missing"
      : "verification_failed";
    cycleLog.failureSummary =
      failureSummary ||
      "No runnable test command was detected. Codex must add a minimal test setup before this cycle can pass.";
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

async function sleepUntilNextCycle(config, sleepMs, logger) {
  const deadline = Date.now() + sleepMs;
  const initialInstructionRevision = getInstructionRevision(config);

  while (Date.now() < deadline) {
    const waitMs = Math.min(2_000, deadline - Date.now());
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    if (getInstructionRevision(config) !== initialInstructionRevision) {
      logger.log("[ai-auto] new instructions detected; starting next cycle");
      return;
    }
  }
}

export async function runLoop(config, logger = console) {
  const startedAt = Date.now();
  const deadline = startedAt + config.maxRuntimeMs;
  let cycleNumber = 0;

  while (Date.now() < deadline) {
    cycleNumber += 1;
    logger.log(`[ai-auto] starting cycle ${cycleNumber}`);
    const result = await runCycle(config, logger);
    logger.log(`[ai-auto] cycle ${cycleNumber}: ${result.outcome}`);
    logger.log(`[ai-auto] log: ${result.logPath}`);
    try {
      await sendTelegramCycleReport(config, result);
    } catch (error) {
      logger.error(`[ai-auto] Telegram report failed: ${error.message}`);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }

    const sleepMs = Math.min(config.cycleIntervalMs, remaining);
    logger.log(`[ai-auto] sleeping ${Math.round(sleepMs / 1000)}s`);
    await sleepUntilNextCycle(config, sleepMs, logger);
  }

  logger.log("[ai-auto] run window complete");
}
