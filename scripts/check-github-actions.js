#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_POLL_MS = 15_000;
const API_VERSION = "2022-11-28";

function usage() {
  return [
    "Usage: node scripts/check-github-actions.js [options]",
    "",
    "Options:",
    "  --repo owner/repo       GitHub repository. Defaults to git remote origin.",
    "  --remote name           Git remote name. Defaults to origin.",
    "  --branch name           Branch to inspect. Defaults to current branch.",
    "  --commit sha            Commit SHA to inspect. Defaults to HEAD.",
    "  --workflow name|file    Workflow name or file name to filter.",
    "  --event name            GitHub Actions event filter, for example push.",
    "  --timeout-ms ms         Total wait time. Defaults to 1800000.",
    "  --poll-ms ms            Poll interval. Defaults to 15000.",
    "  --help                  Show this help."
  ].join("\n");
}

function readValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return Math.floor(parsed);
}

function parseArgs(argv) {
  const options = {
    remote: "origin",
    repo: "",
    branch: "",
    commit: "",
    workflow: "",
    event: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--repo") {
      options.repo = readValue(argv, index, arg);
      index += 1;
    } else if (arg === "--remote") {
      options.remote = readValue(argv, index, arg);
      index += 1;
    } else if (arg === "--branch") {
      options.branch = readValue(argv, index, arg);
      index += 1;
    } else if (arg === "--commit") {
      options.commit = readValue(argv, index, arg);
      index += 1;
    } else if (arg === "--workflow") {
      options.workflow = readValue(argv, index, arg);
      index += 1;
    } else if (arg === "--event") {
      options.event = readValue(argv, index, arg);
      index += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(readValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === "--poll-ms") {
      options.pollMs = parsePositiveInteger(readValue(argv, index, arg), arg);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function gitOutput(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function parseGitHubRepo(remoteUrl) {
  const trimmed = String(remoteUrl || "").trim().replace(/\.git$/, "");
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") {
      return "";
    }
    const parts = url.pathname.replace(/^\/+/, "").split("/");
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
  } catch {
    return "";
  }

  return "";
}

function getGhToken() {
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

function getGitHubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || getGhToken();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workflowMatches(run, workflow) {
  if (!workflow) {
    return true;
  }
  const expected = workflow.toLowerCase();
  return (
    String(run.name || "").toLowerCase() === expected ||
    String(run.path || "").toLowerCase().endsWith(`/${expected}`)
  );
}

function sortNewestFirst(a, b) {
  return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
}

function formatRun(run) {
  const conclusion = run.conclusion || "pending";
  return `${run.name} #${run.run_number} ${run.status}/${conclusion} ${run.html_url || ""}`.trim();
}

async function fetchJson(url, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "ai-auto-ci-check"
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text };
  }
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${payload.message || response.statusText}`);
  }
  return payload;
}

async function listRuns(options, token) {
  const url = new URL(`https://api.github.com/repos/${options.repo}/actions/runs`);
  url.searchParams.set("per_page", "50");
  if (options.branch) {
    url.searchParams.set("branch", options.branch);
  }
  if (options.commit) {
    url.searchParams.set("head_sha", options.commit);
  }
  if (options.event) {
    url.searchParams.set("event", options.event);
  }

  const payload = await fetchJson(url, token);
  return (payload.workflow_runs || [])
    .filter((run) => workflowMatches(run, options.workflow))
    .filter((run) => !options.commit || run.head_sha === options.commit)
    .filter((run) => !options.branch || run.head_branch === options.branch)
    .sort(sortNewestFirst);
}

async function waitForGitHubActions(options) {
  const token = getGitHubToken();
  const deadline = Date.now() + options.timeoutMs;
  let lastNotice = "";

  if (!token) {
    console.error("No GITHUB_TOKEN, GH_TOKEN, or gh auth token found. Private repository checks may fail.");
  }

  while (Date.now() < deadline) {
    const runs = await listRuns(options, token);
    const watchedRuns = options.workflow ? runs.slice(0, 1) : runs;

    if (!watchedRuns.length) {
      const notice = `Waiting for GitHub Actions run for ${options.repo}@${options.commit || options.branch}.`;
      if (notice !== lastNotice) {
        console.error(notice);
        lastNotice = notice;
      }
      await sleep(options.pollMs);
      continue;
    }

    const pending = watchedRuns.filter((run) => run.status !== "completed");
    if (pending.length) {
      const notice = `Waiting for GitHub Actions: ${pending.map(formatRun).join("; ")}`;
      if (notice !== lastNotice) {
        console.error(notice);
        lastNotice = notice;
      }
      await sleep(options.pollMs);
      continue;
    }

    const failed = watchedRuns.filter((run) => run.conclusion !== "success");
    if (failed.length) {
      throw new Error(`GitHub Actions failed:\n${watchedRuns.map(formatRun).join("\n")}`);
    }

    console.log(`GitHub Actions passed:\n${watchedRuns.map(formatRun).join("\n")}`);
    return;
  }

  throw new Error(`Timed out waiting for GitHub Actions after ${options.timeoutMs}ms.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  if (!options.repo) {
    const remoteUrl = gitOutput(["remote", "get-url", options.remote]);
    options.repo = parseGitHubRepo(remoteUrl);
  }
  if (!options.repo) {
    throw new Error("Could not resolve a github.com owner/repo from git remote.");
  }

  options.branch ||= gitOutput(["branch", "--show-current"]);
  options.commit ||= gitOutput(["rev-parse", "HEAD"]);

  await waitForGitHubActions(options);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
