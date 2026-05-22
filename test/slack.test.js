import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSlackCommand,
  parseSlackSlashCommand,
  slackCommandsEnabled,
  slackReportsEnabled
} from "../src/slack.js";

test("slackReportsEnabled requires enabled config, bot token, and channel id", () => {
  const base = { botTokenEnv: "__MISSING_SLACK_BOT__", channelIdEnv: "__MISSING_SLACK_CHANNEL__" };
  assert.equal(slackReportsEnabled({ slack: { ...base, enabled: false, botToken: "xoxb-token", channelId: "C1" } }), false);
  assert.equal(slackReportsEnabled({ slack: { ...base, enabled: true, botToken: "xoxb-token", channelId: "" } }), false);
  assert.equal(slackReportsEnabled({ slack: { ...base, enabled: true, botToken: "xoxb-token", channelId: "C1" } }), true);
});

test("slackCommandsEnabled requires bot token and app token", () => {
  const base = {
    botTokenEnv: "__MISSING_SLACK_BOT__",
    appTokenEnv: "__MISSING_SLACK_APP__",
    commands: { enabled: true }
  };
  assert.equal(
    slackCommandsEnabled({
      slack: { ...base, enabled: true, botToken: "xoxb-token" }
    }),
    false
  );
  assert.equal(
    slackCommandsEnabled({
      slack: { ...base, enabled: true, appToken: "xapp-token" }
    }),
    false
  );
  assert.equal(
    slackCommandsEnabled({
      slack: { ...base, enabled: true, botToken: "xoxb-token", appToken: "xapp-token" }
    }),
    true
  );
});

test("parseSlackCommand supports mentions, slash-style commands, and multiline args", () => {
  assert.deepEqual(parseSlackCommand("whatnow"), { command: "whatnow", args: "" });
  assert.deepEqual(parseSlackCommand("<@U12345> status"), { command: "status", args: "" });
  assert.deepEqual(parseSlackCommand("/instruct fix tests"), {
    command: "instruct",
    args: "fix tests"
  });
  assert.deepEqual(parseSlackCommand("instruct first line\nsecond line"), {
    command: "instruct",
    args: "first line\nsecond line"
  });
  assert.deepEqual(parseSlackCommand("plain text"), { command: "", args: "" });
});

test("parseSlackSlashCommand supports one /ai-auto command and direct command names", () => {
  assert.deepEqual(parseSlackSlashCommand({ command: "/ai-auto", text: "whatnow" }), {
    command: "whatnow",
    args: ""
  });
  assert.deepEqual(parseSlackSlashCommand({ command: "/ai-auto", text: "instruct fix v2" }), {
    command: "instruct",
    args: "fix v2"
  });
  assert.deepEqual(parseSlackSlashCommand({ command: "/instruct", text: "fix v2" }), {
    command: "instruct",
    args: "fix v2"
  });
});
