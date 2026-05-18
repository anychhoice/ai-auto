import { spawn } from "node:child_process";

const OUTPUT_LIMIT = 160_000;

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

  return new Promise((resolve) => {
    const child = spawn(config.codex.command, args, {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    child.on("error", (error) => {
      finish({
        command: `${config.codex.command} ${args.join(" ")}`,
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        timedOut
      });
    });

    child.on("close", (exitCode) => {
      finish({
        command: `${config.codex.command} ${args.join(" ")}`,
        exitCode,
        stdout,
        stderr,
        timedOut
      });
    });

    writePromptSafely(child.stdin, prompt);
  });
}
