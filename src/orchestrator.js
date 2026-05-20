import fs from "node:fs";
import path from "node:path";
import { consultCodex } from "./consultation.js";
import { runCodex } from "./codex.js";
import { detectProjectCommands, resolveVerificationCommands } from "./detectCommands.js";
import { getInstructionRevision, readInstructions, readLatestInstruction } from "./instructions.js";
import { createCyclePlan } from "./planner.js";
import { writeRunProgress } from "./progress.js";
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

function recordProgress(config, logger, patch) {
  try {
    writeRunProgress(config, patch);
  } catch (error) {
    logger.warn?.(`[ai-auto] failed to write progress status: ${error.message}`);
  }
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
  const cycleNumber = options.cycleNumber || null;
  const cycleStartedAt = new Date().toISOString();
  recordProgress(config, logger, {
    running: true,
    cycleNumber,
    cycleStartedAt,
    phase: "context",
    phaseLabel: "프로젝트 상태 확인 중",
    detail: "git 상태, 파일 목록, 지시사항, 테스트 명령을 읽는 중입니다.",
    outcome: "",
    logPath: ""
  });
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
    recordProgress(config, logger, {
      phase: "consultation",
      phaseLabel: "Codex read-only 상담 중",
      detail: "대상 프로젝트를 읽고 다음 작업 후보를 묻는 중입니다."
    });
    context.codexConsultation = await consultCodex(config, context, { signal: forceSignal });
    logger.log(
      `[ai-auto] Codex consultation: ${context.codexConsultation.ok ? "ok" : "failed"}`
    );
  }
  logger.log(`[ai-auto] planning implementation with ${plannerMode(config)}`);
  recordProgress(config, logger, {
    phase: "planning",
    phaseLabel: "계획 수립 중",
    detail: `${plannerMode(config)} planner가 최신 지시와 현재 로그를 보고 이번 cycle 작업을 고르는 중입니다.`
  });
  const planning = await createCyclePlan(config, context, "", { signal: forceSignal });
  const plan = prioritizeLatestInstruction(planning.plan, context.latestSessionInstruction);
  logger.log(`[ai-auto] plan: ${plan.shouldModify ? "modify workspace" : "no change"}`);
  recordProgress(config, logger, {
    phase: "plan_ready",
    phaseLabel: "계획 완료",
    detail: plan.cycleSummary || plan.codexPrompt || "",
    planSummary: plan.cycleSummary || "",
    shouldModify: plan.shouldModify
  });
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
    const result = writeForceShutdownLog(config, cycleLog, plan);
    recordProgress(config, logger, {
      running: false,
      phase: "force_shutdown",
      phaseLabel: "강제 종료됨",
      detail: "운영자가 강제 종료했습니다.",
      outcome: result.outcome,
      logPath: result.logPath
    });
    return result;
  }

  if (!plan.shouldModify) {
    cycleLog.finishedAt = new Date().toISOString();
    cycleLog.outcome = "no_change_requested";
    const logPath = writeJsonLog(config, "cycle", cycleLog);
    recordProgress(config, logger, {
      running: false,
      phase: "completed",
      phaseLabel: "변경 없음",
      detail: plan.cycleSummary || "변경할 작업이 없다고 판단했습니다.",
      outcome: cycleLog.outcome,
      logPath
    });
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
    recordProgress(config, logger, {
      running: true,
      phase: "implementation",
      phaseLabel: `Codex 구현 중 (${attempt}/${config.maxIterationsPerCycle})`,
      detail: plan.codexPrompt || plan.cycleSummary || "",
      attemptNumber: attempt
    });
    const codexResult = await runCodex(config, prompt, { signal: forceSignal });
    cycleLog.codex.push(codexResult);

    if (isForceShutdown(options)) {
      const result = writeForceShutdownLog(config, cycleLog, plan);
      recordProgress(config, logger, {
        running: false,
        phase: "force_shutdown",
        phaseLabel: "강제 종료됨",
        detail: "Codex 실행 중 운영자가 강제 종료했습니다.",
        outcome: result.outcome,
        logPath: result.logPath
      });
      return result;
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
    recordProgress(config, logger, {
      running: true,
      phase: "verification",
      phaseLabel: "검증 실행 중",
      detail: commands.length ? commands.join(" && ") : "실행할 검증 명령이 없습니다.",
      verificationCommandCount: commands.length
    });
    verificationResults = await runCommandList(commands, {
      cwd: config.workspace,
      timeoutMs: 30 * 60_000,
      signal: forceSignal
    });
    cycleLog.verification.push(verificationResults);

    if (isForceShutdown(options)) {
      const result = writeForceShutdownLog(config, cycleLog, plan);
      recordProgress(config, logger, {
        running: false,
        phase: "force_shutdown",
        phaseLabel: "강제 종료됨",
        detail: "검증 중 운영자가 강제 종료했습니다.",
        outcome: result.outcome,
        logPath: result.logPath
      });
      return result;
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
    recordProgress(config, logger, {
      running: false,
      phase: "failed",
      phaseLabel: cycleLog.outcome === "test_setup_missing" ? "테스트 셋업 미완료" : "검증 실패",
      detail: cycleLog.failureSummary,
      outcome: cycleLog.outcome,
      logPath
    });
    return { ok: false, outcome: cycleLog.outcome, logPath, plan };
  }

  if (config.autoCommit) {
    recordProgress(config, logger, {
      running: true,
      phase: "commit",
      phaseLabel: "커밋 생성 중",
      detail: plan.commitMessage
    });
    cycleLog.commit = await commitAll(config.workspace, plan.commitMessage, { signal: forceSignal });
    if (isForceShutdown(options)) {
      const result = writeForceShutdownLog(config, cycleLog, plan);
      recordProgress(config, logger, {
        running: false,
        phase: "force_shutdown",
        phaseLabel: "강제 종료됨",
        detail: "커밋 중 운영자가 강제 종료했습니다.",
        outcome: result.outcome,
        logPath: result.logPath
      });
      return result;
    }
  }

  if (config.deploy.enabled) {
    recordProgress(config, logger, {
      running: true,
      phase: "deploy",
      phaseLabel: "배포 확인/실행 중",
      detail: config.deploy.command || "deploy.command가 비어 있어 배포를 건너뛸지 확인 중입니다."
    });
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
      const result = writeForceShutdownLog(config, cycleLog, plan);
      recordProgress(config, logger, {
        running: false,
        phase: "force_shutdown",
        phaseLabel: "강제 종료됨",
        detail: "배포 중 운영자가 강제 종료했습니다.",
        outcome: result.outcome,
        logPath: result.logPath
      });
      return result;
    }
  }

  cycleLog.finishedAt = new Date().toISOString();
  cycleLog.outcome = "verified";
  const logPath = writeJsonLog(config, "cycle", cycleLog);
  recordProgress(config, logger, {
    running: false,
    phase: "completed",
    phaseLabel: "cycle 완료",
    detail: plan.cycleSummary || "",
    outcome: cycleLog.outcome,
    logPath
  });
  return { ok: true, outcome: cycleLog.outcome, logPath, plan };
}

async function sleepUntilNextCycle(config, sleepMs, logger, options = {}) {
  const deadline = Date.now() + sleepMs;
  const initialInstructionRevision = getInstructionRevision(config);
  recordProgress(config, logger, {
    running: false,
    phase: "sleeping",
    phaseLabel: "다음 cycle 대기 중",
    detail: `${Math.round(sleepMs / 1000)}초 뒤 다음 cycle을 시작합니다.`
  });

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
  recordProgress(config, logger, {
    running: false,
    runStartedAt: new Date(startedAt).toISOString(),
    phase: "starting",
    phaseLabel: "러너 시작 중",
    detail: "ai-auto run loop를 시작합니다.",
    cycleNumber: 0,
    outcome: "",
    logPath: ""
  });

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
      result = await runCycle(config, logger, { ...options, cycleNumber });
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
  recordProgress(config, logger, {
    running: false,
    phase: "complete",
    phaseLabel: "실행 창 종료",
    detail: "설정된 run window가 끝났습니다."
  });
}
