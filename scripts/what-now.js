#!/usr/bin/env node
import { loadConfig, loadDotEnv } from "../src/config.js";
import { buildWhatNowSummary } from "../src/statusSummary.js";

function configPathFromArgs(argv) {
  const index = argv.findIndex((arg) => arg === "--config" || arg === "-c");
  return index === -1 ? undefined : argv[index + 1];
}

async function main() {
  loadDotEnv();
  const config = loadConfig(configPathFromArgs(process.argv.slice(2)));
  console.log(await buildWhatNowSummary(config));
}

main().catch((error) => {
  console.error(`요약 실패: ${error.message}`);
  process.exitCode = 1;
});
