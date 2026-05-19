import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function logDir(config) {
  return config.logDir;
}

function stateFilePath(config) {
  const stateFile = config.restart?.stateFile || ".ai-auto/run-state.json";
  return path.isAbsolute(stateFile) ? stateFile : path.resolve(config.workspace, stateFile);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runGit(workspace, args) {
  const result = spawnSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  return result.status === 0 ? result.stdout.trim() : "";
}

export function findCycleLogFiles(config) {
  const dir = logDir(config);
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith("-cycle.json"))
    .map((file) => path.join(dir, file))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

export function extractCommitHashFromOutput(output) {
  const match = String(output || "").match(/\[[^\s\]]+\s+([0-9a-f]{7,40})\]/i);
  return match?.[1] || "";
}

export function extractFinalCommitFromCycleLog(log) {
  const commitResults = Array.isArray(log?.commit) ? log.commit : [];
  for (let index = commitResults.length - 1; index >= 0; index -= 1) {
    const result = commitResults[index];
    if (result?.exitCode !== 0) {
      continue;
    }

    const hash = extractCommitHashFromOutput(`${result.stdout || ""}\n${result.stderr || ""}`);
    if (hash) {
      return {
        hash,
        command: result.command || "",
        output: `${result.stdout || ""}${result.stderr || ""}`.trim()
      };
    }
  }

  return null;
}

function archiveCycleLogs(cycleLogFiles, archiveDir) {
  if (!cycleLogFiles.length) {
    return [];
  }

  fs.mkdirSync(archiveDir, { recursive: true });
  return cycleLogFiles.map((filePath) => {
    const target = path.join(archiveDir, path.basename(filePath));
    fs.renameSync(filePath, target);
    return target;
  });
}

function removeCycleLogs(cycleLogFiles) {
  for (const filePath of cycleLogFiles) {
    fs.rmSync(filePath, { force: true });
  }
}

export function readRunState(config) {
  const filePath = stateFilePath(config);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJson(filePath);
}

export function writeRunState(config, state) {
  const filePath = stateFilePath(config);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
  return filePath;
}

export function prepareRunSession(config, logger = console) {
  let previousState = null;
  try {
    previousState = readRunState(config);
  } catch (error) {
    logger.warn?.(`[ai-auto] failed to inspect previous run state: ${error.message}`);
  }
  const cycleLogFiles = findCycleLogFiles(config);
  const latestLogPath = cycleLogFiles.at(-1) || "";
  let latestLog = null;
  let finalLogCommit = null;

  if (latestLogPath) {
    try {
      latestLog = readJson(latestLogPath);
      finalLogCommit = extractFinalCommitFromCycleLog(latestLog);
    } catch (error) {
      logger.warn?.(`[ai-auto] failed to inspect previous cycle log: ${error.message}`);
    }
  }

  const head = runGit(config.workspace, ["rev-parse", "HEAD"]);
  const headSubject = runGit(config.workspace, ["log", "-1", "--pretty=%s"]);
  const matchesHead = Boolean(finalLogCommit?.hash && head.startsWith(finalLogCommit.hash));
  const configInstructionText = config.operatorInstruction || config.mission || "";
  const configInstructionField = config.operatorInstruction ? "operatorInstruction" : "mission";
  const previousConfigInstructionText = previousState?.configInstruction?.text || "";
  const configInstructionChanged = configInstructionText !== previousConfigInstructionText;
  const shouldClean = config.restart?.cleanCycleLogs !== false;
  const shouldArchive = config.restart?.archiveCycleLogs !== false;
  const archiveDir =
    shouldClean && shouldArchive && cycleLogFiles.length
      ? path.join(logDir(config), "archive", timestamp())
      : "";
  const archivedFiles =
    shouldClean && shouldArchive
      ? archiveCycleLogs(cycleLogFiles, archiveDir)
      : [];

  if (shouldClean && !shouldArchive) {
    removeCycleLogs(cycleLogFiles);
  }

  const state = {
    startedAt: new Date().toISOString(),
    workspace: config.workspace,
    cleanedCycleLogCount: shouldClean ? cycleLogFiles.length : 0,
    archivedCycleLogCount: archivedFiles.length,
    archiveDir,
    previousLatestLog: latestLogPath ? path.basename(latestLogPath) : "",
    previousLatestOutcome: latestLog?.outcome || "",
    previousLatestFinishedAt: latestLog?.finishedAt || "",
    previousFinalLogCommit: finalLogCommit,
    currentHead: head,
    currentHeadSubject: headSubject,
    configInstruction: {
      field: configInstructionField,
      text: configInstructionText,
      changedSincePreviousRun: configInstructionChanged
    },
    newConfigInstruction: configInstructionChanged
      ? {
          field: configInstructionField,
          text: configInstructionText,
          previousText: previousConfigInstructionText
        }
      : null,
    resumedFromCommit: matchesHead
      ? {
          hash: head,
          shortHash: finalLogCommit.hash,
          subject: headSubject,
          logFile: path.basename(latestLogPath)
        }
      : null
  };

  const statePath = writeRunState(config, state);
  if (cycleLogFiles.length && shouldClean) {
    logger.log(
      `[ai-auto] cleared ${cycleLogFiles.length} previous cycle log(s)${
        archiveDir ? ` into ${archiveDir}` : ""
      }`
    );
  }
  if (state.resumedFromCommit) {
    logger.log(
      `[ai-auto] resuming after committed cycle ${state.resumedFromCommit.shortHash}: ${state.resumedFromCommit.subject}`
    );
  }
  logger.log(`[ai-auto] run state: ${statePath}`);

  return state;
}
