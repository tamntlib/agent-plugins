import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverTrustedRepoBankId, parseBankIdFromToml } from "../src/banks.mjs";
import { runCli } from "../src/cli.mjs";
import {
  isAppendWithoutDocumentTextError,
  isPermanentRetainError,
  recallMemories,
  reflectMemory,
  retainTurns,
} from "../src/client.mjs";
import {
  createStarterProfileConfig,
  loadProfileConfig,
  resolveEffectiveBank,
  writeProfileConfigAtomic,
} from "../src/config.mjs";
import {
  handleRecallHook,
  handleRetainWorker,
  handleSessionStart,
  handleStopHook,
} from "../src/hooks.mjs";
import { createMcpProxy } from "../src/mcp.mjs";
import { listRetryJobs } from "../src/state.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hindsight-parity-"));
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

test("parseBankIdFromToml and trustedProjectDirs enforce Hermes 1.2.4 repo-config discovery & worktree trust", () => {
  assert.equal(parseBankIdFromToml('\uFEFF# comment\nbank_id = "team-backend" # inline\n'), "team-backend");
  assert.equal(parseBankIdFromToml("bank_id = 'single-quoted'\n"), "single-quoted");
  assert.equal(parseBankIdFromToml("[other]\nbank_id = \"spoofed\"\n"), null);
  assert.equal(parseBankIdFromToml("bank_id = 123\n"), null);

  const tmp = makeTempDir();
  try {
    const home = path.join(tmp, "home");
    const trustedBase = path.join(home, "trusted");
    const untrustedBase = path.join(home, "untrusted");

    const trustedRepo = path.join(trustedBase, "payments-api");
    const trustedSub = path.join(trustedRepo, "services", "billing");
    fs.mkdirSync(path.join(trustedRepo, ".git", "worktrees", "wt1"), { recursive: true });
    fs.mkdirSync(path.join(trustedRepo, ".hindsight"), { recursive: true });
    fs.mkdirSync(path.join(trustedSub, ".hindsight"), { recursive: true });
    fs.writeFileSync(path.join(trustedRepo, ".hindsight", "config.toml"), 'bank_id = "repo-payments"\n', "utf8");
    fs.writeFileSync(path.join(trustedSub, ".hindsight", "config.toml"), 'bank_id = "sub-billing"\n', "utf8");

    const untrustedRepo = path.join(untrustedBase, "foreign-repo");
    fs.mkdirSync(path.join(untrustedRepo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(untrustedRepo, ".hindsight"), { recursive: true });
    fs.writeFileSync(path.join(untrustedRepo, ".hindsight", "config.toml"), 'bank_id = "evil-bank"\n', "utf8");

    // Linked worktree physically located OUTSIDE trustedBase, pointing at trustedRepo's gitdir
    const untrustedWt = path.join(untrustedBase, "payments-wt");
    fs.mkdirSync(path.join(untrustedWt, ".hindsight"), { recursive: true });
    fs.writeFileSync(
      path.join(untrustedWt, ".git"),
      `gitdir: ${path.join(trustedRepo, ".git", "worktrees", "wt1")}\n`,
      "utf8"
    );
    fs.writeFileSync(path.join(trustedRepo, ".git", "worktrees", "wt1", "commondir"), "../..\n", "utf8");
    fs.writeFileSync(path.join(untrustedWt, ".hindsight", "config.toml"), 'bank_id = "wt-spoof"\n', "utf8");

    // Relative trusted dirs must be ignored
    assert.equal(discoverTrustedRepoBankId(trustedRepo, trustedRepo, ["./trusted"], { homeDir: home }), null);

    // Subdir gets nearest .hindsight/config.toml; repo root gets root config
    assert.equal(
      discoverTrustedRepoBankId(trustedSub, trustedRepo, [trustedBase], { homeDir: home }),
      "sub-billing"
    );
    assert.equal(
      discoverTrustedRepoBankId(trustedRepo, trustedRepo, [trustedBase], { homeDir: home }),
      "repo-payments"
    );

    // Untrusted repo and untrusted linked worktree must be ignored
    assert.equal(
      discoverTrustedRepoBankId(untrustedRepo, untrustedRepo, [trustedBase], { homeDir: home }),
      null
    );
    assert.equal(
      discoverTrustedRepoBankId(untrustedWt, untrustedWt, [trustedBase], { homeDir: home }),
      null
    );

    // Precedence via resolveEffectiveBank: repo config > bankIdTemplate > static bankId
    const cfgDir = path.join(tmp, "cfg");
    writeProfileConfigAtomic(
      cfgDir,
      "workspace",
      createStarterProfileConfig("workspace", {
        bankId: "workspace",
        bankIdTemplate: "workspace-{project}",
        trustedProjectDirs: [trustedBase],
        mirrorToOwnBank: true,
        additionalBanks: ["team-shared"],
        recallAdditionalBanks: ["team-shared", "readonly-kb"],
      })
    );
    const cfg = loadProfileConfig("workspace", { configDir: cfgDir, env: {} });

    const trustedResolved = resolveEffectiveBank(cfg, { cwd: trustedRepo }, { homeDir: home });
    assert.equal(trustedResolved.bankId, "repo-payments");
    assert.equal(trustedResolved.bankSource, "repository config");
    assert.deepEqual(trustedResolved.writeBanks, ["repo-payments", "workspace", "team-shared"]);
    assert.deepEqual(trustedResolved.extraWriteBanks, ["workspace", "team-shared"]);
    // recallBanks puts write set first, then recall-only extras deduped
    assert.deepEqual(trustedResolved.recallBanks, [
      "repo-payments",
      "workspace",
      "team-shared",
      "readonly-kb",
    ]);

    const untrustedResolved = resolveEffectiveBank(cfg, { cwd: untrustedRepo }, { homeDir: home });
    assert.equal(untrustedResolved.bankId, "workspace-foreign-repo");
    assert.equal(untrustedResolved.bankSource, "template");

    const wtResolved = resolveEffectiveBank(cfg, { cwd: untrustedWt }, { homeDir: home });
    // Worktree still maps {project} to main repo name, but does NOT trust .hindsight/config.toml
    assert.equal(wtResolved.bankId, "workspace-payments-api");
    assert.equal(wtResolved.bankSource, "template");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("multi-bank write fan-out and separate recall/retain cooldowns match Hermes 1.2.4", async () => {
  const tmp = makeTempDir();
  const stateDir = path.join(tmp, "state");
  const requests = [];
  let failPrimaryRetain = false;
  let failExtraRetain = false;
  let failExtraRecall = false;

  const { server, url } = await startMockServer((req, res, body) => {
    const parsed = body ? JSON.parse(body) : null;
    requests.push({ url: req.url, body: parsed });

    if (req.url === "/v1/default/banks/primary-bank/memories") {
      if (failPrimaryRetain) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "primary down" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/v1/default/banks/extra-bank/memories") {
      if (failExtraRetain) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "extra write down" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/v1/default/banks/primary-bank/memories/recall") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [{ text: "Primary fact" }] }));
      return;
    }
    if (req.url === "/v1/default/banks/extra-bank/memories/recall") {
      if (failExtraRecall) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "extra recall down" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [{ text: "Extra fact" }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const cfg = {
      profile: "workspace",
      apiUrl: url,
      apiKey: "",
      bankId: "primary-bank",
      budget: "mid",
      maxTokens: 2048,
      recallMaxInputChars: 800,
      recallTags: [],
      retainTags: [],
      observationScopes: "shared",
      retainAsync: true,
      recallTimeoutMs: 3000,
      retainTimeoutMs: 3000,
    };

    const turns = [{ step: 1, user: "hi", assistant: "hello", timestamp: "2026-01-01T00:00:00Z" }];
    const t0 = 1_700_000_000_000;

    // 1. Primary failure stops immediately before extra bank is touched
    failPrimaryRetain = true;
    await assert.rejects(
      () =>
        retainTurns(cfg, {
          conversationId: "c1",
          turns,
          writeBanks: ["primary-bank", "extra-bank"],
          operationId: "11111111-1111-4111-8111-111111111111",
          stateDir,
          nowMs: t0,
          cooldownMs: 300_000,
        }),
      /HTTP 503/
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/default/banks/primary-bank/memories");

    // 2. Primary succeeds, extra write fails -> extra enters retain cooldown ONLY (recall still works!)
    failPrimaryRetain = false;
    failExtraRetain = true;
    requests.length = 0;
    await retainTurns(cfg, {
      conversationId: "c1",
      turns,
      writeBanks: ["primary-bank", "extra-bank"],
      operationId: "11111111-1111-4111-8111-111111111111",
      stateDir,
      nowMs: t0,
      cooldownMs: 300_000,
    });
    assert.equal(requests.length, 2);
    // Distinct valid UUID operation_ids per bank
    const opPrimary = requests[0].body.operation_id;
    const opExtra = requests[1].body.operation_id;
    assert.ok(opPrimary && opExtra && opPrimary !== opExtra);
    assert.match(opExtra, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Recall against extra-bank still runs while retain is in cooldown (separate keys)
    requests.length = 0;
    const recalled = await recallMemories(cfg, "hello", {
      recallBanks: ["primary-bank", "extra-bank"],
      stateDir,
      nowMs: t0 + 10_000,
      cooldownMs: 300_000,
    });
    assert.deepEqual(
      recalled.results.map((r) => r.text),
      ["Primary fact", "Extra fact"]
    );

    // 3. Another retain within cooldown skips extra-bank entirely
    requests.length = 0;
    await retainTurns(cfg, {
      conversationId: "c1",
      turns,
      writeBanks: ["primary-bank", "extra-bank"],
      stateDir,
      nowMs: t0 + 60_000,
      cooldownMs: 300_000,
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/default/banks/primary-bank/memories");

    // 4. After cooldown expires and extra recovers, retain writes to extra again & logs recovery
    failExtraRetain = false;
    requests.length = 0;
    await retainTurns(cfg, {
      conversationId: "c1",
      turns,
      writeBanks: ["primary-bank", "extra-bank"],
      stateDir,
      nowMs: t0 + 301_000,
      cooldownMs: 300_000,
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, "/v1/default/banks/extra-bank/memories");
    const logText = fs.readFileSync(path.join(stateDir, "hooks.log"), "utf8");
    assert.match(logText, /Retain extra bank extra-bank failed/);
    assert.match(logText, /Retain extra bank extra-bank recovered/);

    // 5. Recall cooldown isolates failing extra bank without failing primary
    failExtraRecall = true;
    requests.length = 0;
    const r1 = await recallMemories(cfg, "hello", {
      recallBanks: ["primary-bank", "extra-bank"],
      stateDir,
      nowMs: t0 + 400_000,
      cooldownMs: 300_000,
    });
    assert.deepEqual(
      r1.results.map((r) => r.text),
      ["Primary fact"]
    );
    assert.equal(requests.length, 2);

    // Next recall during cooldown skips extra-bank completely
    requests.length = 0;
    await recallMemories(cfg, "hello", {
      recallBanks: ["primary-bank", "extra-bank"],
      stateDir,
      nowMs: t0 + 410_000,
      cooldownMs: 300_000,
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/default/banks/primary-bank/memories/recall");
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("memoryMode, autoRecall, autoRetain, recallMaxInputChars, preamble, reflect prefetch, and CLI reflect", async () => {
  const tmp = makeTempDir();
  const seen = [];
  const { server, url } = await startMockServer((req, res, body) => {
    seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.endsWith("/reflect")) {
      res.end(JSON.stringify({ text: "Synthesized architecture summary." }));
    } else {
      res.end(JSON.stringify({ results: [{ text: "Recalled bullet." }] }));
    }
  });

  try {
    const cfgDir = path.join(tmp, "cfg");
    const stateDir = path.join(tmp, "state");
    const tr = path.join(tmp, "tr.jsonl");
    fs.writeFileSync(
      tr,
      [
        JSON.stringify({ type: "USER_INPUT", step_index: 1, content: "hi", created_at: "2026-01-01T00:00:00Z" }),
        JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 2, content: "ok" }),
      ].join("\n") + "\n",
      "utf8"
    );

    const opts = {
      configDir: cfgDir,
      stateDir,
      disableAgentProfiles: true,
      env: { AGENT_PROFILE: "demo" },
    };

    // 1. memoryMode="tools" disables auto-recall, allows MCP
    writeProfileConfigAtomic(
      cfgDir,
      "demo",
      createStarterProfileConfig("demo", { apiUrl: url, bankId: "demo-bank", memoryMode: "tools" })
    );
    const toolsRecall = await handleRecallHook(
      "agy",
      { conversationId: "m1", transcriptPath: tr, lastUserInput: "query in tools mode" },
      opts
    );
    assert.deepEqual(toolsRecall, {});
    assert.equal(seen.length, 0);
    const toolsProxy = createMcpProxy(opts);
    assert.equal(Boolean(toolsProxy.blocked), false);

    // 2. memoryMode="context" allows auto-recall, blocks MCP (-32002), and notes disabled MCP in SessionStart
    writeProfileConfigAtomic(
      cfgDir,
      "demo",
      createStarterProfileConfig("demo", {
        apiUrl: url,
        bankId: "demo-bank",
        memoryMode: "context",
        recallMaxInputChars: 12,
        recallPromptPreamble: "## Custom Memory Header",
        autoRetain: false,
      })
    );
    const ctxStart = handleSessionStart("agy", { conversationId: "m2", cwd: tmp }, opts);
    assert.match(ctxStart.injectSteps[0].systemMessage.systemMessage, /MCP tools disabled/);

    const ctxProxy = createMcpProxy(opts);
    assert.equal(ctxProxy.blocked, true);
    const blockedRes = await ctxProxy.forward({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    assert.equal(blockedRes[0].error.code, -32002);

    const longInput = "0123456789abcdefghijklmnopqrstuvwxyz";
    const ctxRecall = await handleRecallHook(
      "agy",
      { conversationId: "m2", transcriptPath: tr, lastUserInput: longInput },
      opts
    );
    const ctxMsg = ctxRecall.injectSteps[0].systemMessage.systemMessage;
    assert.match(ctxMsg, /^## Custom Memory Header\n\n- Recalled bullet\.$/);
    assert.equal(seen[0].body.query, "0123456789ab");

    // autoRetain=false prevents Stop hook dispatch
    let dispatched = false;
    handleStopHook(
      "agy",
      { conversationId: "m2", transcriptPath: tr, terminationReason: "NO_TOOL_CALL", fullyIdle: true },
      { ...opts, dispatchWorker: () => { dispatched = true; } }
    );
    assert.equal(dispatched, false);

    // 3. recallPrefetchMethod="reflect" + reflectTags/reflectTagsMatch + CLI reflect & status --json
    seen.length = 0;
    writeProfileConfigAtomic(
      cfgDir,
      "demo",
      createStarterProfileConfig("demo", {
        apiUrl: url,
        bankId: "demo-bank",
        recallPrefetchMethod: "reflect",
        reflectTags: ["scope:arch"],
        reflectTagsMatch: "all_strict",
        recallMaxInputChars: 0, // unlimited
      })
    );
    const reflectOut = await handleRecallHook(
      "agy",
      { conversationId: "m3", transcriptPath: tr, lastUserInput: longInput },
      opts
    );
    assert.match(
      reflectOut.injectSteps[0].systemMessage.systemMessage,
      /Synthesized architecture summary\./
    );
    assert.equal(seen[0].url, "/v1/default/banks/demo-bank/reflect");
    assert.equal(seen[0].body.query, longInput);
    assert.deepEqual(seen[0].body.tags, ["scope:arch"]);
    assert.equal(seen[0].body.tags_match, "all_strict");

    // Shared-bank safety: default bank omits explicit reflectTags -> inherits profile tag instead of leaking
    writeProfileConfigAtomic(cfgDir, "sharedprof", createStarterProfileConfig("sharedprof", { apiUrl: url }));
    const sharedCfg = loadProfileConfig("sharedprof", { configDir: cfgDir, env: {} });
    assert.deepEqual(sharedCfg.reflectTags, ["profile:sharedprof"]);
    assert.equal(sharedCfg.reflectTagsMatch, "any_strict");
    seen.length = 0;
    await reflectMemory(sharedCfg, "what did we decide?");
    assert.deepEqual(seen[0].body.tags, ["profile:sharedprof"]);
    assert.equal(seen[0].body.tags_match, "any_strict");

    // CLI reflect and status --json
    let out = "";
    const rcReflect = await runCli(
      ["reflect", "architecture?", "--profile", "demo", "--config-dir", cfgDir],
      { stdout: (s) => { out += s; }, stderr: () => {}, disableAgentProfiles: true, env: {} }
    );
    assert.equal(rcReflect, 0);
    assert.equal(out.trim(), "Synthesized architecture summary.");

    let statusOut = "";
    const rcStatus = await runCli(
      ["status", "--json", "--profile", "demo", "--config-dir", cfgDir, "--cwd", tmp],
      { stdout: (s) => { statusOut += s; }, stderr: () => {}, disableAgentProfiles: true, env: {} }
    );
    assert.equal(rcStatus, 0);
    const statusJson = JSON.parse(statusOut);
    assert.equal(statusJson.recallPrefetchMethod, "reflect");
    assert.equal(statusJson.recallMaxInputChars, 0);
    assert.equal(statusJson.memoryMode, "hybrid");
    assert.equal(statusJson.bankSource, "bank_id");
    assert.deepEqual(statusJson.reflectTags, ["scope:arch"]);

    // autoRecall=false disables recall even in hybrid mode
    writeProfileConfigAtomic(
      cfgDir,
      "demo",
      createStarterProfileConfig("demo", { apiUrl: url, bankId: "demo-bank", autoRecall: false })
    );
    seen.length = 0;
    const offOut = await handleRecallHook(
      "agy",
      { conversationId: "m4", transcriptPath: tr, lastUserInput: "should not recall" },
      opts
    );
    assert.deepEqual(offOut, {});
    assert.equal(seen.length, 0);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("retainEveryNTurns, flat message array, custom prefixes/context/strategy, #6241 metadata, and #5599 fallback", async () => {
  const tmp = makeTempDir();
  const requests = [];
  let rejectAppendForDocText = false;

  const { server, url } = await startMockServer((req, res, body) => {
    const parsed = body ? JSON.parse(body) : null;
    requests.push({ url: req.url, body: parsed });

    if (rejectAppendForDocText && parsed?.items?.[0]?.update_mode === "append") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "update_mode=append requires document text storage to be enabled" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    const cfgDir = path.join(tmp, "cfg");
    const stateDir = path.join(tmp, "state");
    writeProfileConfigAtomic(
      cfgDir,
      "demo",
      createStarterProfileConfig("demo", {
        apiUrl: url,
        bankId: "demo-bank",
        retainEveryNTurns: 2,
        retainAsync: true,
        retainContext: "pair programming session",
        retainStrategy: "coding-agent",
        retainUserPrefix: "Dev",
        retainAssistantPrefix: "Bot",
      })
    );

    const opts = {
      configDir: cfgDir,
      stateDir,
      disableAgentProfiles: true,
      env: { AGENT_PROFILE: "demo" },
    };

    const tr = path.join(tmp, "tr.jsonl");
    fs.writeFileSync(
      tr,
      [
        JSON.stringify({ type: "USER_INPUT", step_index: 1, content: "turn one Q", created_at: "2026-01-01T00:00:00Z" }),
        JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 2, content: "turn one A" }),
      ].join("\n") + "\n",
      "utf8"
    );

    // Turn 1: buffered because retainEveryNTurns=2
    let job = null;
    handleStopHook(
      "agy",
      { conversationId: "cad-1", transcriptPath: tr, terminationReason: "NO_TOOL_CALL", fullyIdle: true },
      { ...opts, dispatchWorker: (j) => { job = j; } }
    );
    assert.equal(job, null);

    // Turn 2: both turns dispatched together
    fs.appendFileSync(
      tr,
      [
        JSON.stringify({ type: "USER_INPUT", step_index: 3, content: "turn two Q", created_at: "2026-01-01T00:01:00Z" }),
        JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 4, content: "turn two A" }),
      ].join("\n") + "\n",
      "utf8"
    );
    handleStopHook(
      "agy",
      { conversationId: "cad-1", transcriptPath: tr, terminationReason: "NO_TOOL_CALL", fullyIdle: true },
      { ...opts, dispatchWorker: (j) => { job = j; } }
    );
    assert.ok(job);
    assert.equal(job.turns.length, 2);

    const jobFile = path.join(tmp, "job1.json");
    fs.writeFileSync(jobFile, JSON.stringify(job), "utf8");
    await handleRetainWorker(jobFile, opts);

    assert.equal(requests.length, 1);
    const reqBody = requests[0].body;
    assert.equal(reqBody.async, true);
    assert.equal(reqBody.operation_id, job.operationId);

    const item = reqBody.items[0];
    assert.equal(item.update_mode, "append");
    assert.equal(item.document_id, "agy-cad-1");
    assert.equal(item.context, "pair programming session");
    assert.equal(item.strategy, "coding-agent");
    // #6241: omit volatile metadata on append
    assert.equal("retained_at" in item.metadata, false);
    assert.equal("message_count" in item.metadata, false);
    assert.equal(item.metadata.conversation_id, "cad-1");
    // Flat message array [u1, a1, u2, a2] with custom prefixes
    const parsedMsgs = JSON.parse(item.content);
    assert.equal(parsedMsgs.length, 4);
    assert.equal(parsedMsgs[0].role, "user");
    assert.equal(parsedMsgs[0].content, "Dev: turn one Q");
    assert.equal(parsedMsgs[1].role, "assistant");
    assert.equal(parsedMsgs[1].content, "Bot: turn one A");
    assert.equal(parsedMsgs[2].content, "Dev: turn two Q");
    assert.equal(parsedMsgs[3].content, "Bot: turn two A");

    // #5599 fallback when server rejects append due to store_document_text=false
    rejectAppendForDocText = true;
    requests.length = 0;
    const jobFile2 = path.join(tmp, "job2.json");
    fs.writeFileSync(jobFile2, JSON.stringify(job), "utf8");
    await handleRetainWorker(jobFile2, opts);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.items[0].update_mode, "append");
    assert.equal("update_mode" in requests[1].body.items[0], false);
    assert.equal(requests[1].body.items[0].document_id, job.fallbackDocumentId);
    // Same operation_id reused on fallback because rejected append was never queued
    assert.equal(requests[1].body.operation_id, job.operationId);
    assert.ok(requests[1].body.items[0].metadata.retained_at);
    assert.equal(requests[1].body.items[0].metadata.message_count, "4");

    // retainAsync=false omits operation_id and sends async: false
    rejectAppendForDocText = false;
    requests.length = 0;
    writeProfileConfigAtomic(
      cfgDir,
      "demo",
      createStarterProfileConfig("demo", { apiUrl: url, bankId: "demo-bank", retainAsync: false })
    );
    const syncJobFile = path.join(tmp, "job-sync.json");
    fs.writeFileSync(syncJobFile, JSON.stringify(job), "utf8");
    await handleRetainWorker(syncJobFile, opts);
    assert.equal(requests[0].body.async, false);
    assert.equal("operation_id" in requests[0].body, false);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("handleRetainWorker queues transient failures FIFO with preserved operation_id and drops permanent 4xx", async () => {
  assert.equal(isPermanentRetainError({ status: 400 }), true);
  assert.equal(isPermanentRetainError({ status: 422 }), true);
  assert.equal(isPermanentRetainError({ status: 408 }), false);
  assert.equal(isPermanentRetainError({ status: 429 }), false);
  assert.equal(isPermanentRetainError({ status: 503 }), false);
  assert.equal(
    isAppendWithoutDocumentTextError({ status: 400, message: "HTTP 400: requires document text storage" }),
    true
  );

  const tmp = makeTempDir();
  const received = [];
  let mode = "fail-503";

  const { server, url } = await startMockServer((req, res, body) => {
    const parsed = body ? JSON.parse(body) : null;
    received.push({ url: req.url, body: parsed });
    if (mode === "fail-503") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "temporarily unavailable" }));
      return;
    }
    if (mode === "fail-422") {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "invalid schema" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    const cfgDir = path.join(tmp, "cfg");
    const stateDir = path.join(tmp, "state");
    writeProfileConfigAtomic(
      cfgDir,
      "demo",
      createStarterProfileConfig("demo", { apiUrl: url, bankId: "demo-bank" })
    );
    const opts = { configDir: cfgDir, stateDir, disableAgentProfiles: true, env: {} };

    const makeJob = (id, createdAt, text) => ({
      agent: "agy",
      profile: "demo",
      bankId: "demo-bank",
      writeBanks: ["demo-bank"],
      conversationId: "rq-1",
      configDir: cfgDir,
      stateDir,
      turns: [{ step: 1, user: text, assistant: "ack", timestamp: createdAt }],
      operationId: id,
      operationIds: { "demo-bank": id },
      fallbackDocumentId: `agy-rq-1-${id.slice(0, 6)}`,
      attempts: 0,
      maxAttempts: 5,
      createdAt,
    });

    const op1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const op2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const op3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    // 1. Job 1 fails transiently -> queued in retry-queue/ with attempts=1
    const f1 = path.join(tmp, "j1.json");
    fs.writeFileSync(f1, JSON.stringify(makeJob(op1, "2026-01-01T00:00:01.000Z", "first")), "utf8");
    await handleRetainWorker(f1, opts);
    assert.equal(listRetryJobs(stateDir).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(listRetryJobs(stateDir)[0], "utf8")).attempts, 1);

    // 2. Job 2 arrives while server is still 503 -> Job 1 retries (attempts=2), Job 2 deferred with attempts=0!
    const f2 = path.join(tmp, "j2.json");
    fs.writeFileSync(f2, JSON.stringify(makeJob(op2, "2026-01-01T00:00:02.000Z", "second")), "utf8");
    await handleRetainWorker(f2, opts);
    const queuedAfter2 = listRetryJobs(stateDir).map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
    assert.equal(queuedAfter2.length, 2);
    assert.equal(queuedAfter2[0].operationId, op1);
    assert.equal(queuedAfter2[0].attempts, 2);
    assert.equal(queuedAfter2[1].operationId, op2);
    assert.equal(queuedAfter2[1].attempts, 0);

    // 3. Server recovers -> Job 3 triggers FIFO drain: op1 -> op2 -> op3!
    mode = "ok";
    received.length = 0;
    const f3 = path.join(tmp, "j3.json");
    fs.writeFileSync(f3, JSON.stringify(makeJob(op3, "2026-01-01T00:00:03.000Z", "third")), "utf8");
    await handleRetainWorker(f3, opts);
    assert.equal(listRetryJobs(stateDir).length, 0);
    assert.deepEqual(
      received.map((r) => r.body.operation_id),
      [op1, op2, op3]
    );

    // 4. Permanent 422 is NOT re-queued
    mode = "fail-422";
    const f4 = path.join(tmp, "j4.json");
    fs.writeFileSync(
      f4,
      JSON.stringify(makeJob("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "2026-01-01T00:00:04.000Z", "bad")),
      "utf8"
    );
    await handleRetainWorker(f4, opts);
    assert.equal(listRetryJobs(stateDir).length, 0);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
