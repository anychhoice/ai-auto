import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexArgs } from "../src/codex.js";

const config = {
  workspace: "/tmp/project",
  codex: {
    command: "codex",
    model: "gpt-5.5",
    sandbox: "workspace-write",
    approvalPolicy: "never"
  }
};

test("buildCodexArgs places approval policy before exec subcommand", () => {
  const args = buildCodexArgs(config);

  assert.deepEqual(args.slice(0, 3), ["-a", "never", "exec"]);
  assert.equal(args.includes("--ask-for-approval"), false);
  assert.equal(args.at(-1), "-");
});

test("buildCodexArgs supports read-only consultation overrides", () => {
  const args = buildCodexArgs(config, {
    sandbox: "read-only",
    ephemeral: true
  });

  assert.equal(args.includes("read-only"), true);
  assert.equal(args.includes("--ephemeral"), true);
});
