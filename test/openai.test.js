import assert from "node:assert/strict";
import test from "node:test";
import { extractOutputText } from "../src/openai.js";

test("extractOutputText reads convenience output_text", () => {
  assert.equal(extractOutputText({ output_text: "hello" }), "hello");
});

test("extractOutputText aggregates response content text", () => {
  const response = {
    output: [
      {
        content: [{ text: "hello" }, { text: "world" }]
      }
    ]
  };

  assert.equal(extractOutputText(response), "hello\nworld");
});
