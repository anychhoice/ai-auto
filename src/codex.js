import { spawn } from "node:child_process";

const OUTPUT_LIMIT = 160_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

function appendLimited(current, chunk) {
  const next = current + chunk.toString();
  if (next.length <= OUTPUT_LIMIT) {
    return next;
  }
  return next.slice(next.length - OUTPUT_LIMIT);
}

function writePromptSafely(stream, prompt) {
  stream.on("error", () => {
    // Codex may exit before stdin is fully written, for example after an auth
    // or configuration failure. Capture the process result instead of crashing.
  });

  try {
    stream.write(prompt);
    stream.end();
  } catch {
    // The close/error handlers below will report the failed Codex invocation.
  }
}

function terminateChild(child, signal) {
  if (!child.pid) {
    return;
  }

  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}

export function buildCodexArgs(config, options = {}) {
  const codex = {
    ...config.codex,
    ...options
  };
  const workspace = options.workspace || config.workspace;
  const args = [];

  if (codex.approvalPolicy) {
    args.push("-a", codex.approvalPolicy);
  }

  args.push(
    "exec",
    "-C",
    workspace,
    "--sandbox",
    codex.sandbox,
    "--color",
    "never"
  );

  if (codex.ephemeral) {
    args.push("--ephemeral");
  }

  if (codex.model) {
    args.push("-m", codex.model);
  }

  args.push("-");
  return args;
}

export function runCodex(config, prompt, options = {}) {
  const args = buildCodexArgs(config, options);
  const workspace = options.workspace || config.workspace;
  const timeoutMs = options.timeoutMs || config.codex.timeoutMs || 60 * 60_000;
  const signal = options.signal;
  const killGraceMs = options.killGraceMs || DEFAULT_KILL_GRACE_MS;
  const command = `${config.codex.command} ${args.join(" ")}`;

  if (signal?.aborted) {
    return Promise.resolve({
      command,
      exitCode: 130,
      stdout: "",
      stderr: "Aborted.",
      timedOut: false,
      aborted: true
    });
  }

  return new Promise((resolve) => {
    const child = spawn(config.codex.command, args, {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      detached: process.platform !== "win32"
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer = null;
    let terminating = false;

    const requestTermination = () => {
      if (terminating) {
        return;
      }
      terminating = true;
      terminateChild(child, "SIGTERM");
      killTimer = setTimeout(() => terminateChild(child, "SIGKILL"), killGraceMs);
    };

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortHandler);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, timeoutMs);

    const abortHandler = () => {
      aborted = true;
      requestTermination();
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    child.on("error", (error) => {
      finish({
        command,
        exitCode: aborted ? 130 : 1,
        stdout,
        stderr: aborted ? `${stderr}\nAborted.`.trim() : `${stderr}\n${error.message}`.trim(),
        timedOut,
        aborted
      });
    });

    child.on("close", (exitCode) => {
      finish({
        command,
        exitCode: aborted ? 130 : exitCode,
        stdout,
        stderr,
        timedOut,
        aborted
      });
    });

    writePromptSafely(child.stdin, prompt);
  });
}
