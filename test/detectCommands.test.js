import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectProjectCommands, resolveVerificationCommands } from "../src/detectCommands.js";

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-auto-detect-"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

test("detectProjectCommands finds Node test and verify scripts", () => {
  const workspace = tempWorkspace();
  writeJson(path.join(workspace, "package.json"), {
    scripts: {
      test: "node --test",
      lint: "eslint .",
      build: "vite build"
    }
  });

  const detected = detectProjectCommands(workspace);

  assert.deepEqual(detected.test, ["npm test"]);
  assert.deepEqual(detected.verify, ["npm run lint", "npm run build"]);
});

test("detectProjectCommands ignores placeholder npm test scripts", () => {
  const workspace = tempWorkspace();
  writeJson(path.join(workspace, "package.json"), {
    scripts: {
      test: "echo \"Error: no test specified\" && exit 1",
      check: "tsc --noEmit"
    }
  });

  const detected = detectProjectCommands(workspace);

  assert.deepEqual(detected.test, []);
  assert.deepEqual(detected.verify, ["npm run check"]);
});

test("detectProjectCommands uses package manager lockfiles", () => {
  const workspace = tempWorkspace();
  fs.writeFileSync(path.join(workspace, "pnpm-lock.yaml"), "");
  writeJson(path.join(workspace, "package.json"), {
    scripts: {
      test: "vitest",
      typecheck: "tsc --noEmit"
    }
  });

  const detected = detectProjectCommands(workspace);

  assert.deepEqual(detected.test, ["pnpm test"]);
  assert.deepEqual(detected.verify, ["pnpm run typecheck"]);
});

test("detectProjectCommands finds common non-Node projects", () => {
  const workspace = tempWorkspace();
  fs.writeFileSync(path.join(workspace, "go.mod"), "module example\n");

  const detected = detectProjectCommands(workspace);

  assert.deepEqual(detected.test, ["go test ./..."]);
  assert.deepEqual(detected.verify, ["go vet ./..."]);
});

test("resolveVerificationCommands prefers explicit config but falls back to auto", () => {
  const config = {
    workspace: tempWorkspace(),
    allowPlannerCommandOverride: false,
    commandDiscovery: { fallbackVerifyCommands: ["git diff --check"] },
    commands: {
      test: [],
      verify: ["custom verify"]
    }
  };
  const detected = {
    test: ["auto test"],
    verify: ["auto verify"],
    reasons: ["test"]
  };

  const resolved = resolveVerificationCommands(config, {}, detected);

  assert.deepEqual(resolved.test, ["auto test"]);
  assert.deepEqual(resolved.verify, ["custom verify", "git diff --check"]);
  assert.equal(resolved.needsTestCreation, false);
  assert.deepEqual(resolved.source, { test: "auto", verify: "config" });
});

test("resolveVerificationCommands marks missing runnable tests", () => {
  const config = {
    workspace: tempWorkspace(),
    allowPlannerCommandOverride: false,
    commandDiscovery: {
      requireTests: true,
      fallbackVerifyCommands: ["git diff --check"]
    },
    commands: {
      test: [],
      verify: []
    }
  };

  const resolved = resolveVerificationCommands(
    config,
    {},
    { test: [], verify: [], reasons: [] }
  );

  assert.equal(resolved.needsTestCreation, true);
  assert.deepEqual(resolved.test, []);
  assert.deepEqual(resolved.verify, ["git diff --check"]);
});
