import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_OUTPUT_LIMIT = 80_000;

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

export function runCommand(command, options = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = process.env,
    input,
    outputLimit = DEFAULT_OUTPUT_LIMIT
  } = options;

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const append = (current, chunk) => {
      const next = current + chunk.toString();
      if (next.length <= outputLimit) {
        return next;
      }
      return next.slice(next.length - outputLimit);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd,
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        timedOut
      });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd,
        exitCode,
        stdout,
        stderr,
        timedOut
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
    outputLimit = DEFAULT_OUTPUT_LIMIT
  } = options;

  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const append = (current, chunk) => {
      const next = current + chunk.toString();
      if (next.length <= outputLimit) {
        return next;
      }
      return next.slice(next.length - outputLimit);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        command: [file, ...args].join(" "),
        cwd,
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        timedOut
      });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        command: [file, ...args].join(" "),
        cwd,
        exitCode,
        stdout,
        stderr,
        timedOut
      });
    });

    writeStdinSafely(child.stdin, input);
  });
}

export async function runCommandList(commands, options = {}) {
  const results = [];
  for (const command of commands || []) {
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
    `exit: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`,
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
