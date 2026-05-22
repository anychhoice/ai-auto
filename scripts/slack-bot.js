#!/usr/bin/env node
import { loadConfig, loadDotEnv } from "../src/config.js";
import { runSlackCommandLoop } from "../src/slack.js";

async function main() {
  loadDotEnv();
  const config = loadConfig();
  await runSlackCommandLoop(config);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
