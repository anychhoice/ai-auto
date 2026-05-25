import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CONFIG = {
  workspace: ".",
  model: process.env.AI_AUTO_MODEL || "gpt-5.5",
  reasoningEffort: "high",
  cycleInterval: "30m",
  maxRuntime: "24h",
  maxIterationsPerCycle: 3,
  discussionRounds: 2,
  logDir: ".ai-auto",
  instructionFile: ".ai-auto/instructions.md",
  operatorInstruction: "",
  goals: [
    "Actively improve the target project every cycle.",
    "First understand the architecture, tests, risks, and improvement opportunities.",
    "Make one concrete, small, tested, reviewable code or test change each normal cycle."
  ],
  rules: [
    "Avoid no-op analysis cycles unless the workspace is already cleanly complete or a safety concern blocks changes.",
    "Never change secrets, credentials, or deployment configuration unless explicitly requested."
  ],
  autoCommit: false,
  push: {
    enabled: false,
    command: "git push"
  },
  ciCheck: {
    enabled: false,
    command: "",
    required: false,
    timeoutMs: 30 * 60_000
  },
  restart: {
    cleanCycleLogs: true,
    archiveCycleLogs: true,
    stateFile: ".ai-auto/run-state.json"
  },
  progress: {
    stateFile: ".ai-auto/current-status.json"
  },
  allowPlannerCommandOverride: false,
  commandDiscovery: {
    enabled: true,
    requireTests: true,
    fallbackVerifyCommands: ["git diff --check"]
  },
  planner: {
    mode: "codex",
    fallbackToOpenAI: true,
    sandbox: "read-only",
    approvalPolicy: "never",
    timeoutMs: 1_200_000
  },
  codexConsultation: {
    enabled: true,
    questionSource: "openai",
    sandbox: "read-only",
    approvalPolicy: "never",
    timeoutMs: 1_200_000
  },
  commands: {
    test: [],
    verify: [],
    status: ["git status --short"]
  },
  codex: {
    command: "codex",
    model: process.env.AI_AUTO_CODEX_MODEL || "gpt-5.5",
    sandbox: "workspace-write",
    approvalPolicy: "never"
  },
  deploy: {
    enabled: false,
    command: "",
    requireCleanGit: true,
    requireCommand: false,
    required: false
  },
  telegram: {
    enabled: false,
    botTokenEnv: "TELEGRAM_BOT_TOKEN",
    chatIdEnv: "TELEGRAM_CHAT_ID",
    chatId: "",
    reportCycles: true,
    commands: {
      enabled: false,
      allowedChatIds: [],
      pollTimeoutSeconds: 25,
      stateFile: ".ai-auto/telegram-offset.json"
    }
  },
  slack: {
    enabled: false,
    botTokenEnv: "SLACK_BOT_TOKEN",
    appTokenEnv: "SLACK_APP_TOKEN",
    channelId: "",
    reportCycles: true,
    commands: {
      enabled: false,
      allowedUserIds: [],
      reconnectDelaySeconds: 5
    }
  },
  mission: ""
};

export function normalizeInstructionList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  return [];
}

function formatNumberedSection(title, items) {
  if (!items.length) {
    return "";
  }
  return [title, ...items.map((item, index) => `${index + 1}. ${item}`)].join("\n");
}

export function buildConfigInstructionContext(config) {
  const goals = normalizeInstructionList(config.goals);
  const rules = normalizeInstructionList(config.rules);
  const mission = String(config.mission || "").trim();
  const sections = [
    formatNumberedSection("Goals:", goals),
    mission ? `Legacy mission:\n${mission}` : "",
    formatNumberedSection("Must-follow rules:", rules)
  ].filter(Boolean);

  return {
    goals,
    rules,
    mission,
    text: sections.join("\n\n")
  };
}

export function buildConfigInstructionSnapshot(config) {
  const operatorInstruction = String(config.operatorInstruction || "").trim();
  if (operatorInstruction) {
    return {
      field: "operatorInstruction",
      text: operatorInstruction
    };
  }

  const context = buildConfigInstructionContext(config);
  if (!context.goals.length && !context.rules.length && context.mission) {
    return {
      field: "mission",
      text: context.mission
    };
  }

  const fields = [
    context.goals.length ? "goals" : "",
    context.mission ? "mission" : "",
    context.rules.length ? "rules" : ""
  ].filter(Boolean);

  return {
    field: fields.join("+") || "none",
    text: context.text
  };
}

export function parseDuration(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    throw new TypeError(`Duration must be a string or number, received ${typeof value}`);
  }

  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (!match) {
    throw new Error(`Invalid duration "${value}". Use values like 30m, 24h, or 2d.`);
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000
  };

  return amount * multipliers[unit];
}

export function resolveWorkspace(workspace, configDir = process.cwd()) {
  const base = path.isAbsolute(workspace) ? workspace : path.resolve(configDir, workspace);
  return fs.realpathSync(base);
}

export function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return override === undefined ? base : override;
  }

  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      output[key] = deepMerge(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function loadConfig(configPath = "config/ai-auto.json") {
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);
  let fileConfig = {};

  if (fs.existsSync(absoluteConfigPath)) {
    fileConfig = JSON.parse(fs.readFileSync(absoluteConfigPath, "utf8"));
  }

  const config = deepMerge(DEFAULT_CONFIG, fileConfig);
  const workspace = resolveWorkspace(config.workspace, process.cwd());
  const logDir = path.isAbsolute(config.logDir)
    ? config.logDir
    : path.resolve(workspace, config.logDir);
  const instructionFile = path.isAbsolute(config.instructionFile)
    ? config.instructionFile
    : path.resolve(workspace, config.instructionFile);

  return {
    ...config,
    workspace,
    logDir,
    instructionFile,
    maxRuntimeMs: parseDuration(config.maxRuntime),
    cycleIntervalMs: parseDuration(config.cycleInterval)
  };
}

export function loadDotEnv(envPath = ".env") {
  const absolutePath = path.resolve(process.cwd(), envPath);
  if (!fs.existsSync(absolutePath)) {
    return;
  }

  const lines = fs.readFileSync(absolutePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
