import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getConvState, setRecalledKey, setRetainedStep } from "../src/state.mjs";
import { extractNewTurns, latestUserStepIndex } from "../src/transcript.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hindsight-tr-"));
}

test("state store tracks recalled keys and monotonic retained steps per conversation", () => {
  const tmp = makeTempDir();
  try {
    assert.deepEqual(getConvState(tmp, "conv-1"), { lastRecalledKey: "", lastRetainedStep: -1 });
    setRecalledKey(tmp, "conv-1", "3:abcdef");
    setRetainedStep(tmp, "conv-1", 5);
    setRetainedStep(tmp, "conv-1", 2); // must not regress
    assert.deepEqual(getConvState(tmp, "conv-1"), {
      lastRecalledKey: "3:abcdef",
      lastRetainedStep: 5,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("transcript parser extracts Antigravity JSONL turns accurately", () => {
  const tmp = makeTempDir();
  try {
    const tr = path.join(tmp, "agy.jsonl");
    fs.writeFileSync(
      tr,
      [
        JSON.stringify({ type: "USER_INPUT", step_index: 1, content: "First question", created_at: "2026-01-01T00:00:00Z" }),
        JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 2, content: "First answer" }),
        JSON.stringify({ type: "USER_INPUT", step_index: 5, content: "Second question", created_at: "2026-01-01T00:01:00Z" }),
        JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 6, content: "Intermediate" }),
        JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 7, content: "Final answer" }),
      ].join("\n") + "\n",
      "utf8"
    );

    assert.equal(latestUserStepIndex(tr), 5);
    const all = extractNewTurns(tr, -1);
    assert.equal(all.length, 2);
    assert.equal(all[0].user, "First question");
    assert.equal(all[1].assistant, "Final answer");

    const incremental = extractNewTurns(tr, 1);
    assert.equal(incremental.length, 1);
    assert.equal(incremental[0].step, 5);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("transcript parser extracts Claude Code JSONL turns with text blocks", () => {
  const tmp = makeTempDir();
  try {
    const tr = path.join(tmp, "claude.jsonl");
    fs.writeFileSync(
      tr,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "Explain profiles" }, timestamp: "2026-01-01T00:00:00Z" }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Profiles isolate credentials." }] },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    const turns = extractNewTurns(tr, -1);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].user, "Explain profiles");
    assert.equal(turns[0].assistant, "Profiles isolate credentials.");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
