const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "cycleSummary",
    "discussion",
    "shouldModify",
    "codexPrompt",
    "testIntent",
    "testCommands",
    "verifyCommands",
    "commitMessage",
    "deployRecommendation"
  ],
  properties: {
    cycleSummary: { type: "string" },
    discussion: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "position", "risk"],
        properties: {
          role: { type: "string" },
          position: { type: "string" },
          risk: { type: "string" }
        }
      }
    },
    shouldModify: { type: "boolean" },
    codexPrompt: { type: "string" },
    testIntent: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "rationale", "expectedTestAreas"],
      properties: {
        mode: {
          type: "string",
          enum: ["use-existing", "write-tests", "not-applicable"]
        },
        rationale: { type: "string" },
        expectedTestAreas: {
          type: "array",
          items: { type: "string" }
        }
      }
    },
    testCommands: {
      type: "array",
      items: { type: "string" }
    },
    verifyCommands: {
      type: "array",
      items: { type: "string" }
    },
    commitMessage: { type: "string" },
    deployRecommendation: { type: "string" }
  }
};

const CONSULTATION_QUESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["question"],
  properties: {
    question: { type: "string" }
  }
};

export function extractOutputText(response) {
  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  const parts = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

async function createStructuredResponse(
  config,
  { systemPrompt, userPayload, schemaName, schema },
  options = {}
) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required. Add it to .env or export it in your shell.");
  }

  const body = {
    model: config.model,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemPrompt }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify(userPayload, null, 2) }]
      }
    ],
    reasoning: {
      effort: config.reasoningEffort
    },
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        schema,
        strict: true
      }
    }
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: options.signal
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error?.message || response.statusText;
    throw new Error(`OpenAI API request failed: ${message}`);
  }

  const outputText = extractOutputText(payload);
  if (!outputText) {
    throw new Error("OpenAI API response did not include output text.");
  }

  return JSON.parse(outputText);
}

export async function createCodexConsultationQuestion(config, context, options = {}) {
  return createStructuredResponse(config, {
    schemaName: "ai_auto_codex_consultation_question",
    schema: CONSULTATION_QUESTION_SCHEMA,
    systemPrompt: [
      "You are the OpenAI planning layer for a local OpenAI + Codex development loop.",
      "Before making a plan, write the exact read-only question that should be asked to Codex.",
      "The question should ask Codex to inspect the repo, identify how tests should be run, call out missing tests, name operator questions, and recommend one small next improvement.",
      "Do not ask Codex to edit files in this consultation step."
    ].join("\n"),
    userPayload: {
      mission: context.mission,
      workspace: context.workspace,
      sessionInstructions: context.sessionInstructions,
      detectedTestCommands: context.detectedCommands.test,
      detectedVerifyCommands: context.detectedCommands.verify,
      detectedCommandReasons: context.detectedCommands.reasons,
      gitStatus: context.status,
      trackedFiles: context.trackedFiles,
      untrackedFiles: context.untrackedFiles,
      packageJson: context.packageJson
    }
  }, options);
}

export async function createCyclePlan(config, context, previousFailure = "", options = {}) {
  return createStructuredResponse(config, {
    schemaName: "ai_auto_cycle_plan",
    schema: PLAN_SCHEMA,
    systemPrompt: [
      "You are the planning council for a local autonomous development loop.",
      "Discuss the workspace from multiple roles: architect, implementer, reviewer, and release manager.",
      "Return only the JSON object requested by the schema.",
      "Default to shouldModify=true. A no-op plan is allowed only when the workspace is already complete, blocked by safety, or there is truly no reviewable improvement left.",
      "If there is no narrow user instruction, identify the highest-leverage small implementation or test improvement and ask Codex to make it now.",
      "Use the read-only Codex consultation as the most repo-grounded signal for what Codex should do next.",
      "If Codex or command detection says no runnable tests exist, the codexPrompt must ask Codex to add a minimal test setup before unrelated implementation work.",
      "Prefer small, tested, reversible improvements, but require a concrete file change in normal cycles.",
      "The codexPrompt must contain explicit file or area targets, expected behavior, and verification expectations.",
      "Do not request secret changes. Do not recommend deployment unless tests and verification are expected to pass."
    ].join("\n"),
    userPayload: {
      mission: context.mission,
      discussionRounds: config.discussionRounds,
      workspace: context.workspace,
      sessionInstructions: context.sessionInstructions,
      detectedTestCommands: context.detectedCommands.test,
      detectedVerifyCommands: context.detectedCommands.verify,
      detectedCommandReasons: context.detectedCommands.reasons,
      codexConsultation: context.codexConsultation,
      gitStatus: context.status,
      trackedFiles: context.trackedFiles,
      untrackedFiles: context.untrackedFiles,
      packageJson: context.packageJson,
      configuredTestCommands: config.commands.test,
      configuredVerifyCommands: config.commands.verify,
      previousFailure
    }
  }, options);
}
