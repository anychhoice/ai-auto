import { runCodex } from "./codex.js";
import { createCodexConsultationQuestion } from "./openai.js";

const MAX_CONSULTATION_CHARS = 40_000;

function truncate(value, maxChars = MAX_CONSULTATION_CHARS) {
  if (!value || value.length <= maxChars) {
    return value || "";
  }
  return `${value.slice(0, 4_000)}\n\n...[truncated]...\n\n${value.slice(-maxChars + 4_200)}`;
}

export function buildCodexConsultationPrompt(config, context, openAiQuestion) {
  return [
    "You are Codex acting as a read-only project consultant for an OpenAI planning step.",
    "Answer the OpenAI planner's question below.",
    "",
    "Do not edit files. Do not install packages. Do not run destructive commands. Prefer reading files and project metadata.",
    "If Current orchestration context includes latestSessionInstruction, treat it as the operator's highest-priority live direction when recommending next work.",
    "If Current orchestration context includes newConfigInstruction, treat it as the highest-priority config direction when there is no newer session instruction.",
    "Goals are desired outcomes. Rules are mandatory constraints. Never recommend work that violates rules.",
    "If resumedFromCommit is present, treat that commit as already completed and focus on current config instructions plus any uncommitted git status.",
    "",
    "OpenAI planner question:",
    openAiQuestion,
    "",
    "Return concise, actionable guidance with these sections:",
    "1. Project understanding",
    "2. Important open questions for the operator",
    "3. Existing test and verification setup",
    "4. If no runnable tests exist, the smallest test setup you should be asked to add",
    "5. Safe commands that appear appropriate for this project",
    "6. Highest-leverage small improvement",
    "",
    "Current orchestration context:",
    JSON.stringify(
      {
        goals: context.goals || [],
        rules: context.rules || [],
        mission: context.mission,
        configInstructionText: context.configInstructionText || "",
        operatorInstruction: context.operatorInstruction,
        newConfigInstruction: context.runState?.newConfigInstruction || null,
        resumedFromCommit: context.runState?.resumedFromCommit || null,
        latestSessionInstruction: context.latestSessionInstruction || "",
        sessionInstructions: context.sessionInstructions,
        detectedCommands: context.detectedCommands,
        trackedFiles: context.trackedFiles,
        untrackedFiles: context.untrackedFiles,
        packageJson: context.packageJson
      },
      null,
      2
    )
  ].join("\n");
}

export async function consultCodex(config, context, options = {}) {
  if (!config.codexConsultation?.enabled) {
    return {
      enabled: false,
      ok: true,
      stdout: "",
      stderr: "",
      command: ""
    };
  }

  const questionResult =
    config.codexConsultation.questionSource === "local"
      ? {
          question:
            "Inspect this repository read-only. Explain its structure, existing or missing tests, safe verification commands, open questions for the operator, and the smallest useful next improvement."
        }
      : await createCodexConsultationQuestion(config, context, { signal: options.signal });
  const prompt = buildCodexConsultationPrompt(config, context, questionResult.question);
  const result = await runCodex(config, prompt, {
    sandbox: config.codexConsultation.sandbox || "read-only",
    approvalPolicy: config.codexConsultation.approvalPolicy || "never",
    timeoutMs: config.codexConsultation.timeoutMs || 20 * 60_000,
    ephemeral: true,
    signal: options.signal
  });

  return {
    enabled: true,
    ok: result.exitCode === 0 && !result.timedOut,
    question: questionResult.question,
    command: result.command,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr, 12_000),
    timedOut: Boolean(result.timedOut)
  };
}
