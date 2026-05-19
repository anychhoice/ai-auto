#!/usr/bin/env node
import { loadConfig, loadDotEnv } from "../src/config.js";
import { runTelegramCommandLoop } from "../src/telegram.js";

async function main() {
  loadDotEnv();
  const config = loadConfig();
  await runTelegramCommandLoop(config);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
