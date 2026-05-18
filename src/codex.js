import { spawn } from "node:child_process";

const OUTPUT_LIMIT = 160_000;

function appendLimited(current, chunk) {
  const next = current + chunk.toString();
  if (next.length <= OUTPUT_LIMIT) {
    return next;
  }
  return next.slice(next.length - OUTPUT_LIMIT);
}

export function buildCodexArgs(config) {
  const args = [
    "exec",
    "-C",
    config.workspace,
    "--sandbox",
    config.codex.sandbox,
    "--ask-for-approval",
    config.codex.approvalPolicy,
    "--color",
    "never"
  ];

  if (config.codex.model) {
    args.push("-m", config.codex.model);
  }

  args.push("-");
  return args;
}

export function runCodex(config, prompt) {
  const args = buildCodexArgs(config);

  return new Promise((resolve) => {
    const child = spawn(config.codex.command, args, {
      cwd: config.workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    child.on("error", (error) => {
      resolve({
        command: `${config.codex.command} ${args.join(" ")}`,
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim()
      });
    });

    child.on("close", (exitCode) => {
      resolve({
        command: `${config.codex.command} ${args.join(" ")}`,
        exitCode,
        stdout,
        stderr
      });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
