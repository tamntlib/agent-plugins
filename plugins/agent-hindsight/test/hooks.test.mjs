import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStarterProfileConfig, writeProfileConfigAtomic } from "../src/config.mjs";
import {
  handleRecallHook,
  handleRetainWorker,
  handleSessionStart,
  handleStopHook,
} from "../src/hooks.mjs";
import { createMcpProxy, parseMcpHttpResponse } from "../src/mcp.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hindsight-hooks-"));
}

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      handler(req, res, body);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test("SessionStart avoids duplicating Active Profile header when managed by agent-profiles", () => {
  const tmp = makeTempDir();
  try {
    const apCfg = path.join(tmp, "ap.json");
    fs.writeFileSync(
      apCfg,
      JSON.stringify({
        version: 1,
        defaultProfile: "default",
        profiles: { default: { paths: [], env: { AGENT_PROFILE: "default" } } },
      }),
      "utf8"
    );
    const outManaged = handleSessionStart(
      "agy",
      { conversationId: "c1", cwd: tmp },
      { configDir: tmp, env: { AGENT_PROFILES_CONFIG: apCfg } }
    );
    const managedMsg = outManaged.injectSteps[0].systemMessage.systemMessage;
    assert.match(managedMsg, /# Hindsight Bank \(profile:default\)/);
    assert.doesNotMatch(managedMsg, /# Active Profile:/);

    const outStandalone = handleSessionStart(
      "claude",
      { session_id: "s1", cwd: tmp },
      { configDir: tmp, disableAgentProfiles: true, env: {} }
    );
    assert.equal(outStandalone.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(outStandalone.hookSpecificOutput.additionalContext, /# Active Profile: default/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("PreInvocation/UserPromptSubmit recalls via HTTP, deduplicates, and Stop retains via worker", async () => {
  const tmp = makeTempDir();
  const received = [];
  const { server, url } = await startMockServer((req, res, body) => {
    received.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.endsWith("/memories/recall")) {
      res.end(JSON.stringify({ results: [{ text: "VPS uses rootless Docker." }] }));
    } else {
      res.end(JSON.stringify({ ok: true }));
    }
  });

  try {
    const cfgDir = path.join(tmp, "cfg");
    const stateDir = path.join(tmp, "state");
    writeProfileConfigAtomic(cfgDir, "work", createStarterProfileConfig("work", { apiUrl: url, bankId: "default" }));
    fs.writeFileSync(path.join(cfgDir, "work", ".env"), "HINDSIGHT_API_KEY=test-token\n", "utf8");

    const tr = path.join(tmp, "transcript.jsonl");
    fs.writeFileSync(
      tr,
      [
        JSON.stringify({ type: "USER_INPUT", step_index: 1, content: "How does Docker run?", created_at: "2026-01-01T00:00:00Z" }),
        JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 2, content: "It runs rootless." }),
      ].join("\n") + "\n",
      "utf8"
    );

    const opts = {
      configDir: cfgDir,
      stateDir,
      disableAgentProfiles: true,
      env: { AGENT_PROFILE: "work" },
    };

    // First recall hits mock server
    const first = await handleRecallHook(
      "agy",
      { conversationId: "conv-1", transcriptPath: tr, lastUserInput: "How does Docker run?" },
      opts
    );
    assert.match(first.injectSteps[0].systemMessage.systemMessage, /VPS uses rootless Docker\./);
    assert.equal(received.length, 1);
    assert.equal(received[0].auth, "Bearer test-token");
    assert.deepEqual(received[0].body.tags, ["profile:work"]);

    // Second recall for same step + query is deduplicated
    const dup = await handleRecallHook(
      "agy",
      { conversationId: "conv-1", transcriptPath: tr, lastUserInput: "How does Docker run?" },
      opts
    );
    assert.deepEqual(dup, {});
    assert.equal(received.length, 1);

    // Stop hook dispatches retain job and worker POSTs turns
    let capturedJob = null;
    handleStopHook(
      "agy",
      {
        conversationId: "conv-1",
        transcriptPath: tr,
        terminationReason: "NO_TOOL_CALL",
        fullyIdle: true,
      },
      { ...opts, dispatchWorker: (job) => { capturedJob = job; } }
    );
    assert.ok(capturedJob);
    assert.equal(capturedJob.turns.length, 1);

    const jobFile = path.join(tmp, "job.json");
    fs.writeFileSync(jobFile, JSON.stringify(capturedJob), "utf8");
    await handleRetainWorker(jobFile, opts);
    assert.equal(fs.existsSync(jobFile), false);
    assert.equal(received.length, 2);
    assert.equal(received[1].url, "/v1/default/banks/default/memories");
    assert.deepEqual(received[1].body.items[0].tags, ["profile:work", "session:agy-conv-1"]);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("MCP proxy forwards JSON-RPC over Streamable HTTP (JSON and SSE) with Bearer token and session ID", async () => {
  const tmp = makeTempDir();
  const seenHeaders = [];
  const { server, url } = await startMockServer((req, res, body) => {
    seenHeaders.push({ auth: req.headers.authorization, session: req.headers["mcp-session-id"] });
    const msg = JSON.parse(body);
    if (msg.method === "initialize") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Mcp-Session-Id": "sess-42",
      });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26" } }));
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } })}\n\n`);
    }
  });

  try {
    writeProfileConfigAtomic(tmp, "default", createStarterProfileConfig("default", { apiUrl: url }));
    fs.writeFileSync(path.join(tmp, "default", ".env"), "HINDSIGHT_API_KEY=mcp-secret\n", "utf8");

    const proxy = createMcpProxy({ configDir: tmp, disableAgentProfiles: true, env: {} });
    const r1 = await proxy.forward({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(r1[0].result.protocolVersion, "2025-03-26");

    const r2 = await proxy.forward({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(r2[0].result.tools, []);
    assert.equal(seenHeaders[0].auth, "Bearer mcp-secret");
    assert.equal(seenHeaders[1].session, "sess-42");

    // Direct SSE parser sanity check
    assert.equal(parseMcpHttpResponse("text/event-stream", "data: {\"a\":1}\n\n")[0].a, 1);

    // Fail-closed when active profile is invalid/unresolved (must NOT fall back to default or fetch)
    let fetchCalled = false;
    const blocked = createMcpProxy({
      configDir: tmp,
      disableAgentProfiles: true,
      env: { AGENT_PROFILE: "../invalid" },
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("should not be called");
      },
    });
    assert.equal(blocked.blocked, true);
    const errResp = await blocked.forward({ jsonrpc: "2.0", id: 9, method: "tools/list" });
    assert.equal(fetchCalled, false);
    assert.equal(errResp[0].error.code, -32002);
    assert.match(errResp[0].error.message, /fail-closed/i);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
