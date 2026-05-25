#!/usr/bin/env node
import { loadConfig, loadDotEnv } from "../src/config.js";
import { runSlackCommandLoop } from "../src/slack.js";

function configPathFromArgs(argv) {
  const index = argv.findIndex((arg) => arg === "--config" || arg === "-c");
  return index === -1 ? undefined : argv[index + 1];
}

async function main() {
  loadDotEnv();
  const config = loadConfig(configPathFromArgs(process.argv.slice(2)));
  await runSlackCommandLoop(config);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
