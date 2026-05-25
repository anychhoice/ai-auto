import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSlackCommand,
  parseSlackSlashCommand,
  slackCommandAllowed,
  slackCommandsEnabled,
  slackReportsEnabled
} from "../src/slack.js";

test("slackReportsEnabled requires enabled config, bot token, and channel id", () => {
  const base = { botTokenEnv: "__MISSING_SLACK_BOT__" };
  assert.equal(slackReportsEnabled({ slack: { ...base, enabled: false, botToken: "xoxb-token", channelId: "C1" } }), false);
  assert.equal(slackReportsEnabled({ slack: { ...base, enabled: true, botToken: "xoxb-token", channelId: "" } }), false);
  assert.equal(slackReportsEnabled({ slack: { ...base, enabled: true, botToken: "xoxb-token", channelId: "C1" } }), true);
});

test("slackCommandsEnabled requires bot token, app token, and config channel id", () => {
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
    false
  );
  assert.equal(
    slackCommandsEnabled({
      slack: { ...base, enabled: true, botToken: "xoxb-token", appToken: "xapp-token", channelId: "C1" }
    }),
    true
  );
});

test("slackCommandAllowed uses slack.channelId for command channel", () => {
  const config = {
    slack: {
      channelId: "C1",
      commands: { allowedUserIds: [] }
    }
  };
  assert.equal(slackCommandAllowed(config, { channelId: "C1", userId: "U1" }), true);
  assert.equal(slackCommandAllowed(config, { channelId: "C2", userId: "U1" }), false);
  assert.equal(slackCommandAllowed({ slack: { channelId: "", commands: {} } }, { channelId: "C1" }), false);
  assert.equal(
    slackCommandAllowed(
      { slack: { channelId: "C1", commands: { allowedUserIds: ["U2"] } } },
      { channelId: "C1", userId: "U1" }
    ),
    false
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
