import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_OUTPUT_LIMIT = 80_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

function writeStdinSafely(stream, input) {
  stream.on("error", () => {
    // Some short-lived commands close stdin before Node finishes writing.
    // Treat that as command output, not as an unhandled process crash.
  });

  try {
    if (input) {
      stream.write(input);
    }
    stream.end();
  } catch {
    // The child process result still carries the useful stdout/stderr.
  }
}

function abortedResult(command, cwd) {
  return {
    command,
    cwd,
    exitCode: 130,
    stdout: "",
    stderr: "Aborted.",
    timedOut: false,
    aborted: true
  };
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

export function runCommand(command, options = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = process.env,
    input,
    outputLimit = DEFAULT_OUTPUT_LIMIT,
    signal,
    killGraceMs = DEFAULT_KILL_GRACE_MS
  } = options;

  if (signal?.aborted) {
    return Promise.resolve(abortedResult(command, cwd));
  }

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
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

    const append = (current, chunk) => {
      const next = current + chunk.toString();
      if (next.length <= outputLimit) {
        return next;
      }
      return next.slice(next.length - outputLimit);
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
      stdout = append(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortHandler);
      resolve({
        command,
        cwd,
        exitCode: aborted ? 130 : 1,
        stdout,
        stderr: aborted ? `${stderr}\nAborted.`.trim() : `${stderr}\n${error.message}`.trim(),
        timedOut,
        aborted
      });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortHandler);
      resolve({
        command,
        cwd,
        exitCode: aborted ? 130 : exitCode,
        stdout,
        stderr,
        timedOut,
        aborted
      });
    });

    writeStdinSafely(child.stdin, input);
  });
}

export function runProcess(file, args = [], options = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = process.env,
    input,
    outputLimit = DEFAULT_OUTPUT_LIMIT,
    signal,
    killGraceMs = DEFAULT_KILL_GRACE_MS
  } = options;

  const command = [file, ...args].join(" ");
  if (signal?.aborted) {
    return Promise.resolve(abortedResult(command, cwd));
  }

  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
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

    const append = (current, chunk) => {
      const next = current + chunk.toString();
      if (next.length <= outputLimit) {
        return next;
      }
      return next.slice(next.length - outputLimit);
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
      stdout = append(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortHandler);
      resolve({
        command,
        cwd,
        exitCode: aborted ? 130 : 1,
        stdout,
        stderr: aborted ? `${stderr}\nAborted.`.trim() : `${stderr}\n${error.message}`.trim(),
        timedOut,
        aborted
      });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortHandler);
      resolve({
        command,
        cwd,
        exitCode: aborted ? 130 : exitCode,
        stdout,
        stderr,
        timedOut,
        aborted
      });
    });

    writeStdinSafely(child.stdin, input);
  });
}

export async function runCommandList(commands, options = {}) {
  const results = [];
  for (const command of commands || []) {
    if (options.signal?.aborted) {
      break;
    }
    const result = await runCommand(command, options);
    results.push(result);
    if (result.exitCode !== 0 || result.timedOut) {
      break;
    }
  }
  return results;
}

export function summarizeCommandResult(result, maxChars = 12_000) {
  const output = [
    `$ ${result.command}`,
    `exit: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}${result.aborted ? " (aborted)" : ""}`,
    result.stdout ? `stdout:\n${result.stdout}` : "",
    result.stderr ? `stderr:\n${result.stderr}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  if (output.length <= maxChars) {
    return output;
  }
  return `${output.slice(0, 2_000)}\n\n...[truncated]...\n\n${output.slice(-maxChars + 2_200)}`;
}
