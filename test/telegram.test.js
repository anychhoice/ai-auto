import assert from "node:assert/strict";
import test from "node:test";
import { telegramCommandsEnabled, telegramReportsEnabled } from "../src/telegram.js";

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
