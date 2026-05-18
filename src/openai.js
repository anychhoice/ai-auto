const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "cycleSummary",
    "discussion",
    "shouldModify",
    "codexPrompt",
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

export async function createCyclePlan(config, context, previousFailure = "") {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required. Add it to .env or export it in your shell.");
  }

  const systemPrompt = [
    "You are the planning council for a local autonomous development loop.",
    "Discuss the workspace from multiple roles: architect, implementer, reviewer, and release manager.",
    "Return only the JSON object requested by the schema.",
    "Prefer small, tested, reversible improvements.",
    "Do not request secret changes. Do not recommend deployment unless tests and verification are expected to pass."
  ].join("\n");

  const userPrompt = JSON.stringify(
    {
      mission: context.mission,
      discussionRounds: config.discussionRounds,
      workspace: context.workspace,
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
  );

  const body = {
    model: config.model,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemPrompt }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: userPrompt }]
      }
    ],
    reasoning: {
      effort: config.reasoningEffort
    },
    text: {
      format: {
        type: "json_schema",
        name: "ai_auto_cycle_plan",
        schema: PLAN_SCHEMA,
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
    body: JSON.stringify(body)
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
