import fs from "node:fs";
import path from "node:path";
import { consultCodex } from "./consultation.js";
import { runCodex } from "./codex.js";
import { detectProjectCommands, resolveVerificationCommands } from "./detectCommands.js";
import { getInstructionRevision, readInstructions, readLatestInstruction } from "./instructions.js";
import { createCyclePlan } from "./planner.js";
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
  latestSessionInstruction,
  testPolicy
) {
  return [
    "You are Codex running inside an unattended local automation loop.",
    `Workspace: ${config.workspace}`,
    "",
    "Implement the plan below with small, focused changes.",
    "Treat plan.codexPrompt as the primary task.",
    latestSessionInstruction
      ? "The latest live operator instruction below overrides older mission/backlog work and any conflicting planner details. Satisfy it first, or verify with concrete evidence that it is already satisfied or blocked."
      : "",
    "Run or update tests when useful. Do not deploy. Do not modify secrets.",
    testPolicy,
    "In normal cycles, make a concrete reviewable file change. Only make no code changes if the task is already fully satisfied or a safety issue blocks changes, and explain that clearly.",
    "",
    `Attempt: ${attemptNumber}`,
    latestSessionInstruction ? `Latest live operator instruction:\n${latestSessionInstruction}` : "",
    sessionInstructions ? `Active natural-language session instructions:\n${sessionInstructions}` : "",
    previousFailure ? `Previous failure:\n${previousFailure}` : "",
    "",
    "Plan:",
    JSON.stringify(plan, null, 2)
  ]
    .filter(Boolean)
    .join("\n");
}

function buildRepairPrompt(
  config,
  plan,
  failureSummary,
  attemptNumber,
  sessionInstructions,
  latestSessionInstruction,
  testPolicy
) {
  return [
    "The previous implementation failed verification.",
    `Workspace: ${config.workspace}`,
    "Fix the failing tests or checks with the smallest reasonable change.",
    latestSessionInstruction
      ? "Keep the latest live operator instruction as the highest-priority acceptance target while repairing the failure."
      : "",
    testPolicy,
    "Do not deploy. Do not modify secrets.",
    "",
    `Attempt: ${attemptNumber}`,
    latestSessionInstruction ? `Latest live operator instruction:\n${latestSessionInstruction}` : "",
    sessionInstructions ? `Active natural-language session instructions:\n${sessionInstructions}` : "",
    "",
    "Original plan:",
    JSON.stringify(plan, null, 2),
    "",
    "Failure output:",
    failureSummary
  ].join("\n");
}

function getForceSignal(options) {
  return options.shutdown?.forceSignal || options.signal;
}

function isForceShutdown(options) {
  return Boolean(options.shutdown?.forceRequested || getForceSignal(options)?.aborted);
}

function writeForceShutdownLog(config, cycleLog, plan) {
  cycleLog.finishedAt = new Date().toISOString();
  cycleLog.outcome = "force_shutdown";
  cycleLog.failureSummary = "Forced shutdown requested by operator.";
  const logPath = writeJsonLog(config, "cycle", cycleLog);
  return { ok: false, outcome: cycleLog.outcome, logPath, plan };
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function plannerMode(config) {
  return config.planner?.mode || "codex";
}

export function prioritizeLatestInstruction(plan, latestSessionInstruction) {
  const instruction = String(latestSessionInstruction || "").trim();
  if (!instruction) {
    return plan;
  }

  return {
    ...plan,
    shouldModify: true,
    cycleSummary: [
      `Latest operator instruction: ${instruction}`,
      "",
      plan.cycleSummary
    ].join("\n"),
    codexPrompt: [
      "Highest-priority live operator instruction:",
      instruction,
      "",
      "Work on this instruction first. Do not substitute backlog, benchmark, or general mission work unless it is necessary to satisfy this instruction. If it is already complete or blocked, verify that with concrete evidence and report it before doing unrelated work.",
      "",
      "Planner task:",
      plan.codexPrompt
    ].join("\n")
  };
}

export async function runCycle(config, logger = console, options = {}) {
  const forceSignal = getForceSignal(options);
  const context = await getWorkspaceContext(config, {
    signal: forceSignal,
    runState: options.runState || null
  });
  if (plannerMode(config) === "codex") {
    context.codexConsultation = {
      enabled: false,
      ok: true,
      stdout: "",
      stderr: "",
      command: "",
      skippedReason: "codex planner inspects the repository directly"
    };
    logger.log("[ai-auto] skipping separate Codex consultation; Codex planner will inspect read-only");
  } else {
    logger.log("[ai-auto] consulting Codex in read-only mode");
    context.codexConsultation = await consultCodex(config, context, { signal: forceSignal });
    logger.log(
      `[ai-auto] Codex consultation: ${context.codexConsultation.ok ? "ok" : "failed"}`
    );
  }
  logger.log(`[ai-auto] planning implementation with ${plannerMode(config)}`);
  const planning = await createCyclePlan(config, context, "", { signal: forceSignal });
  const plan = prioritizeLatestInstruction(planning.plan, context.latestSessionInstruction);
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
    latestSessionInstructionAtPlan: context.latestSessionInstruction,
    codexConsultation: context.codexConsultation,
    planner: planning.planner,
    plan,
    detectedCommands: context.detectedCommands,
    executedCommands: [],
    codex: [],
    verification: [],
    deploy: null,
    commit: null
  };

  if (isForceShutdown(options)) {
    return writeForceShutdownLog(config, cycleLog, plan);
  }

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
    const latestSessionInstruction = readLatestInstruction(config);
    const prompt =
      attempt === 1
        ? buildImplementationPrompt(
            config,
            plan,
            attempt,
            failureSummary,
            sessionInstructions,
            latestSessionInstruction,
            initialTestPolicy
          )
        : buildRepairPrompt(
            config,
            plan,
            failureSummary,
            attempt,
            sessionInstructions,
            latestSessionInstruction,
            initialTestPolicy
          );

    logger.log(`[ai-auto] running Codex implementation attempt ${attempt} in ${config.codex.sandbox}`);
    const codexResult = await runCodex(config, prompt, { signal: forceSignal });
    cycleLog.codex.push(codexResult);

    if (isForceShutdown(options)) {
      return writeForceShutdownLog(config, cycleLog, plan);
    }

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
      timeoutMs: 30 * 60_000,
      signal: forceSignal
    });
    cycleLog.verification.push(verificationResults);

    if (isForceShutdown(options)) {
      return writeForceShutdownLog(config, cycleLog, plan);
    }

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
    cycleLog.commit = await commitAll(config.workspace, plan.commitMessage, { signal: forceSignal });
    if (isForceShutdown(options)) {
      return writeForceShutdownLog(config, cycleLog, plan);
    }
  }

  if (config.deploy.enabled) {
    if (!config.deploy.command) {
      cycleLog.deploy = {
        skipped: true,
        reason: "deploy.enabled is true, but deploy.command is empty"
      };
    } else if (
      config.deploy.requireCleanGit &&
      !(await isGitClean(config.workspace, { signal: forceSignal }))
    ) {
      cycleLog.deploy = {
        skipped: true,
        reason: "deploy.requireCleanGit is true, but the workspace has uncommitted changes"
      };
    } else {
      cycleLog.deploy = await runCommand(config.deploy.command, {
        cwd: config.workspace,
        timeoutMs: 60 * 60_000,
        signal: forceSignal
      });
    }

    if (isForceShutdown(options)) {
      return writeForceShutdownLog(config, cycleLog, plan);
    }
  }

  cycleLog.finishedAt = new Date().toISOString();
  cycleLog.outcome = "verified";
  const logPath = writeJsonLog(config, "cycle", cycleLog);
  return { ok: true, outcome: cycleLog.outcome, logPath, plan };
}

async function sleepUntilNextCycle(config, sleepMs, logger, options = {}) {
  const deadline = Date.now() + sleepMs;
  const initialInstructionRevision = getInstructionRevision(config);

  while (
    Date.now() < deadline &&
    !options.shutdown?.gracefulRequested &&
    !isForceShutdown(options)
  ) {
    const waitMs = Math.min(2_000, deadline - Date.now());
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    if (options.shutdown?.gracefulRequested) {
      logger.log("[ai-auto] graceful shutdown requested; stopping before next cycle");
      return;
    }

    if (getInstructionRevision(config) !== initialInstructionRevision) {
      logger.log("[ai-auto] new instructions detected; starting next cycle");
      return;
    }
  }
}

export async function runLoop(config, logger = console, options = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + config.maxRuntimeMs;
  let cycleNumber = 0;

  while (
    Date.now() < deadline &&
    !options.shutdown?.gracefulRequested &&
    !isForceShutdown(options)
  ) {
    cycleNumber += 1;
    const instructionRevisionAtCycleStart = getInstructionRevision(config);
    logger.log(`[ai-auto] starting cycle ${cycleNumber}`);
    let result;
    try {
      result = await runCycle(config, logger, options);
    } catch (error) {
      if (isForceShutdown(options) || isAbortError(error)) {
        logger.log("[ai-auto] forced shutdown interrupted the active cycle");
        break;
      }
      throw error;
    }
    logger.log(`[ai-auto] cycle ${cycleNumber}: ${result.outcome}`);
    logger.log(`[ai-auto] log: ${result.logPath}`);
    try {
      await sendTelegramCycleReport(config, result);
    } catch (error) {
      logger.error(`[ai-auto] Telegram report failed: ${error.message}`);
    }

    if (options.shutdown?.gracefulRequested || result.outcome === "force_shutdown") {
      break;
    }

    if (getInstructionRevision(config) !== instructionRevisionAtCycleStart) {
      logger.log("[ai-auto] instructions changed during the cycle; starting next cycle immediately");
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }

    const sleepMs = Math.min(config.cycleIntervalMs, remaining);
    logger.log(`[ai-auto] sleeping ${Math.round(sleepMs / 1000)}s`);
    await sleepUntilNextCycle(config, sleepMs, logger, options);
  }

  logger.log("[ai-auto] run window complete");
}
