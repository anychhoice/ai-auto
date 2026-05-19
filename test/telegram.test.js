import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTelegramCommand,
  telegramCommandsEnabled,
  telegramReportsEnabled
} from "../src/telegram.js";

test("telegramCommandsEnabled requires global and command flags", () => {
  assert.equal(telegramCommandsEnabled({ telegram: { enabled: false, commands: { enabled: true } } }), false);
  assert.equal(telegramCommandsEnabled({ telegram: { enabled: true, commands: { enabled: false } } }), false);
  assert.equal(telegramCommandsEnabled({ telegram: { enabled: true, commands: { enabled: true } } }), true);
});

test("telegramReportsEnabled requires enabled config, token, and chat id", () => {
  assert.equal(telegramReportsEnabled({ telegram: { enabled: false, botToken: "token", chatId: "1" } }), false);
  assert.equal(telegramReportsEnabled({ telegram: { enabled: true, botToken: "token", chatId: "" } }), false);
  assert.equal(telegramReportsEnabled({ telegram: { enabled: true, botToken: "token", chatId: "1" } }), true);
});

test("parseTelegramCommand supports bot suffix and multiline args", () => {
  assert.deepEqual(parseTelegramCommand("/whatnow"), { command: "whatnow", args: "" });
  assert.deepEqual(parseTelegramCommand("/instruct@AiAutoBot fix tests"), {
    command: "instruct",
    args: "fix tests"
  });
  assert.deepEqual(parseTelegramCommand("/instruct first line\nsecond line"), {
    command: "instruct",
    args: "first line\nsecond line"
  });
  assert.deepEqual(parseTelegramCommand("plain text"), { command: "", args: "" });
});
