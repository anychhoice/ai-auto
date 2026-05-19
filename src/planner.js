import { runCodex } from "./codex.js";
import { createCyclePlan as createOpenAiCyclePlan } from "./openai.js";

const REQUIRED_FIELDS = [
  "cycleSummary",
  "discussion",
  "shouldModify",
  "codexPrompt",
  "testIntent",
  "testCommands",
  "verifyCommands",
  "commitMessage",
  "deployRecommendation"
];

function truncate(value, maxChars = 80_000) {
  const text = String(value || "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, 8_000)}\n\n...[truncated]...\n\n${text.slice(-maxChars + 8_020)}`;
}

function stripJsonFence(text) {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : trimmed;
}

export function extractJsonObject(text) {
  const stripped = stripJsonFence(text);
  try {
    return JSON.parse(stripped);
  } catch {
    // Codex sometimes includes progress text around the JSON. Fall through and
    // recover the first complete object while respecting string literals.
  }

  for (
    let start = stripped.indexOf("{");
    start !== -1;
    start = stripped.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < stripped.length; index += 1) {
      const char = stripped[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(stripped.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error("Planner output did not include a parseable JSON object.");
}

function assertString(value, field) {
  if (typeof value !== "string") {
    throw new Error(`Planner field "${field}" must be a string.`);
  }
}

function assertStringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Planner field "${field}" must be an array of strings.`);
  }
}

export function normalizeCyclePlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Planner JSON must be an object.");
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in value)) {
      throw new Error(`Planner JSON is missing "${field}".`);
    }
  }

  assertString(value.cycleSummary, "cycleSummary");
  if (!Array.isArray(value.discussion) || value.discussion.length === 0) {
    throw new Error('Planner field "discussion" must be a non-empty array.');
  }
  for (const [index, item] of value.discussion.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Planner discussion item ${index} must be an object.`);
    }
    assertString(item.role, `discussion[${index}].role`);
    assertString(item.position, `discussion[${index}].position`);
    assertString(item.risk, `discussion[${index}].risk`);
  }
  if (typeof value.shouldModify !== "boolean") {
    throw new Error('Planner field "shouldModify" must be a boolean.');
  }
  assertString(value.codexPrompt, "codexPrompt");
  if (!value.testIntent || typeof value.testIntent !== "object" || Array.isArray(value.testIntent)) {
    throw new Error('Planner field "testIntent" must be an object.');
  }
  assertString(value.testIntent.mode, "testIntent.mode");
  assertString(value.testIntent.rationale, "testIntent.rationale");
  assertStringArray(value.testIntent.expectedTestAreas, "testIntent.expectedTestAreas");
  assertStringArray(value.testCommands, "testCommands");
  assertStringArray(value.verifyCommands, "verifyCommands");
  assertString(value.commitMessage, "commitMessage");
  assertString(value.deployRecommendation, "deployRecommendation");

  return {
    cycleSummary: value.cycleSummary,
    discussion: value.discussion.map((item) => ({
      role: item.role,
      position: item.position,
      risk: item.risk
    })),
    shouldModify: value.shouldModify,
    codexPrompt: value.codexPrompt,
    testIntent: {
      mode: value.testIntent.mode,
      rationale: value.testIntent.rationale,
      expectedTestAreas: value.testIntent.expectedTestAreas
    },
    testCommands: value.testCommands,
    verifyCommands: value.verifyCommands,
    commitMessage: value.commitMessage,
    deployRecommendation: value.deployRecommendation
  };
}

function buildCodexPlannerPrompt(config, context, previousFailure = "") {
  const planShape = {
    cycleSummary: "string",
    discussion: [{ role: "architect|implementer|reviewer|release-manager", position: "string", risk: "string" }],
    shouldModify: true,
    codexPrompt: "string",
    testIntent: {
      mode: "use-existing|write-tests|not-applicable",
      rationale: "string",
      expectedTestAreas: ["string"]
    },
    testCommands: ["string"],
    verifyCommands: ["string"],
    commitMessage: "string",
    deployRecommendation: "string"
  };

  return [
    "You are Codex acting as the read-only planner for an unattended development loop.",
    `Workspace: ${config.workspace}`,
    "",
    "Inspect the repository directly. Prefer reading current files, benchmark scripts, recent logs, reports, and git status before deciding.",
    "Do not edit files. Do not install packages. Do not run destructive commands. Do not modify secrets.",
    "",
    "Return ONLY one JSON object. Do not wrap it in Markdown fences. Do not include prose before or after it.",
    "",
    "Planning rules:",
    "- Current config instructions and active session instructions are direct operator intent.",
    "- If newConfigInstruction is present, it has priority over resume state and inferred continuation work.",
    "- If resumedFromCommit is present, treat that commit as already completed and do not repeat it.",
    "- Default to shouldModify=true unless the workspace is blocked or already complete.",
    "- Pick one concrete, reviewable implementation task for the next Codex worker.",
    "- Do not choose a test-only or benchmark-only task unless existing measurement genuinely cannot expose the requested behavior.",
    "- When quality infrastructure already exists, choose an existing low-scoring/failing fixture or report and ask the worker to improve algorithm/converter behavior.",
    "- codexPrompt must name target files or areas, the existing metric/report/fixture to inspect first, expected behavior, and verification commands.",
    "- codexPrompt must require before/after metric reporting when the task is a quality improvement.",
    "- Do not recommend deployment unless verification is expected to pass.",
    "",
    "Required JSON shape:",
    JSON.stringify(planShape, null, 2),
    "",
    "Current orchestration context:",
    JSON.stringify(
      {
        mission: context.mission,
        operatorInstruction: context.operatorInstruction,
        newConfigInstruction: context.runState?.newConfigInstruction || null,
        resumedFromCommit: context.runState?.resumedFromCommit || null,
        sessionInstructions: context.sessionInstructions,
        detectedCommands: context.detectedCommands,
        gitStatus: context.status,
        trackedFiles: context.trackedFiles,
        untrackedFiles: context.untrackedFiles,
        packageJson: context.packageJson,
        configuredTestCommands: config.commands.test,
        configuredVerifyCommands: config.commands.verify,
        previousFailure
      },
      null,
      2
    )
  ].join("\n");
}

async function createCodexCyclePlan(config, context, previousFailure, options) {
  const prompt = buildCodexPlannerPrompt(config, context, previousFailure);
  const result = await runCodex(config, prompt, {
    sandbox: config.planner?.sandbox || "read-only",
    approvalPolicy: config.planner?.approvalPolicy || "never",
    timeoutMs: config.planner?.timeoutMs || 20 * 60_000,
    ephemeral: true,
    signal: options.signal
  });

  if (result.exitCode !== 0 || result.timedOut || result.aborted) {
    throw new Error(`Codex planner failed: ${result.stderr || result.stdout || result.exitCode}`);
  }

  const parsed = extractJsonObject(result.stdout);
  return {
    plan: normalizeCyclePlan(parsed),
    planner: {
      mode: "codex",
      ok: true,
      command: result.command,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr, 12_000),
      timedOut: Boolean(result.timedOut)
    }
  };
}

async function createOpenAiPlanWithMeta(config, context, previousFailure, options, fallbackReason = "") {
  const plan = await createOpenAiCyclePlan(config, context, previousFailure, options);
  return {
    plan,
    planner: {
      mode: "openai",
      ok: true,
      fallbackReason
    }
  };
}

export async function createCyclePlan(config, context, previousFailure = "", options = {}) {
  const mode = config.planner?.mode || "codex";

  if (mode === "openai") {
    return createOpenAiPlanWithMeta(config, context, previousFailure, options);
  }

  if (mode !== "codex") {
    throw new Error(`Unknown planner.mode "${mode}". Use "codex" or "openai".`);
  }

  try {
    return await createCodexCyclePlan(config, context, previousFailure, options);
  } catch (error) {
    if (config.planner?.fallbackToOpenAI === false) {
      throw error;
    }
    const fallback = await createOpenAiPlanWithMeta(
      config,
      context,
      previousFailure,
      options,
      error.message
    );
    fallback.planner.codexFailure = error.message;
    return fallback;
  }
}
