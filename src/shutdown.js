function logWarning(logger, message) {
  if (typeof logger.warn === "function") {
    logger.warn(message);
    return;
  }
  logger.log(message);
}

export function createShutdownController(logger = console, options = {}) {
  const installSignalHandlers = options.installSignalHandlers !== false;
  const forceController = new AbortController();
  let gracefulRequested = false;
  let forceRequested = false;

  const request = (source = "manual") => {
    if (!gracefulRequested) {
      gracefulRequested = true;
      logWarning(
        logger,
        `[ai-auto] graceful shutdown requested (${source}). Finishing the current cycle, then stopping. Press Ctrl+C again to force active child processes to stop.`
      );
      return "graceful";
    }

    if (!forceRequested) {
      forceRequested = true;
      logWarning(
        logger,
        `[ai-auto] forced shutdown requested (${source}). Terminating active Codex/test/deploy processes.`
      );
      forceController.abort();
      return "force";
    }

    logWarning(logger, "[ai-auto] forced shutdown is already in progress.");
    return "force";
  };

  const handlers = [];
  if (installSignalHandlers) {
    for (const signalName of ["SIGINT", "SIGTERM"]) {
      const handler = () => request(signalName);
      process.on(signalName, handler);
      handlers.push([signalName, handler]);
    }
  }

  return {
    get gracefulRequested() {
      return gracefulRequested;
    },
    get forceRequested() {
      return forceRequested;
    },
    get forceSignal() {
      return forceController.signal;
    },
    request,
    dispose() {
      for (const [signalName, handler] of handlers) {
        process.off(signalName, handler);
      }
    }
  };
}
