import fs from "node:fs";
import path from "node:path";

const MAX_INSTRUCTION_CHARS = 24_000;

function ensureInstructionDir(config) {
  fs.mkdirSync(path.dirname(config.instructionFile), { recursive: true });
}

export function appendInstruction(config, text) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Instruction text is empty.");
  }

  ensureInstructionDir(config);
  const entry = [`## ${new Date().toISOString()}`, "", trimmed, ""].join("\n");
  fs.appendFileSync(config.instructionFile, entry);

  return {
    filePath: config.instructionFile,
    text: trimmed
  };
}

export function readInstructions(config) {
  if (!fs.existsSync(config.instructionFile)) {
    return "";
  }

  const content = fs.readFileSync(config.instructionFile, "utf8").trim();
  if (content.length <= MAX_INSTRUCTION_CHARS) {
    return content;
  }

  return [
    "[Older instructions truncated. The most recent instructions are below.]",
    content.slice(content.length - MAX_INSTRUCTION_CHARS)
  ].join("\n\n");
}

export function readLatestInstruction(config) {
  if (!fs.existsSync(config.instructionFile)) {
    return "";
  }

  const content = fs.readFileSync(config.instructionFile, "utf8").trim();
  if (!content) {
    return "";
  }

  const entries = content
    .split(/^##\s+.+$/m)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries.at(-1) || content;
}

export function getInstructionRevision(config) {
  if (!fs.existsSync(config.instructionFile)) {
    return "missing";
  }

  const stat = fs.statSync(config.instructionFile);
  return `${stat.mtimeMs}:${stat.size}`;
}

export function clearInstructions(config) {
  if (!fs.existsSync(config.instructionFile)) {
    return {
      cleared: false,
      filePath: config.instructionFile,
      archivePath: ""
    };
  }

  ensureInstructionDir(config);
  const archivePath = path.join(
    path.dirname(config.instructionFile),
    `instructions-cleared-${new Date().toISOString().replace(/[:.]/g, "-")}.md`
  );

  fs.renameSync(config.instructionFile, archivePath);
  return {
    cleared: true,
    filePath: config.instructionFile,
    archivePath
  };
}
