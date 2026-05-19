import assert from "node:assert/strict";
import test from "node:test";
import { createShutdownController } from "../src/shutdown.js";

test("shutdown controller escalates from graceful to force", () => {
  const messages = [];
  const shutdown = createShutdownController(
    { warn: (message) => messages.push(message), log: (message) => messages.push(message) },
    { installSignalHandlers: false }
  );

  assert.equal(shutdown.gracefulRequested, false);
  assert.equal(shutdown.forceRequested, false);
  assert.equal(shutdown.forceSignal.aborted, false);

  assert.equal(shutdown.request("test"), "graceful");
  assert.equal(shutdown.gracefulRequested, true);
  assert.equal(shutdown.forceRequested, false);
  assert.equal(shutdown.forceSignal.aborted, false);

  assert.equal(shutdown.request("test"), "force");
  assert.equal(shutdown.gracefulRequested, true);
  assert.equal(shutdown.forceRequested, true);
  assert.equal(shutdown.forceSignal.aborted, true);
  assert.equal(messages.length, 2);
});
