import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearsMinScores,
  findRepositoryRoot,
  normalizeMinScores,
  normalizeObservationScopes,
  normalizeStringList,
  renderBankIdTemplate,
  resolveMainRepositoryName,
  resolveProjectName,
  sanitizeBankSegment,
} from "../src/banks.mjs";
import { recallMemories } from "../src/client.mjs";
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

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hindsight-banks-"));
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

test("sanitizeBankSegment and renderBankIdTemplate match Hermes hindsight 1.2.4 semantics", () => {
  assert.equal(sanitizeBankSegment("agent-plugins"), "agent-plugins");
  assert.equal(sanitizeBankSegment("My Repo / v2.0!"), "My-Repo-v2-0");
  assert.equal(sanitizeBankSegment(""), "");

  // Inside repo -> workspace-agent-plugins; outside repo (empty project) -> workspace
  assert.equal(
    renderBankIdTemplate("workspace-{project}", "default", { project: "agent-plugins" }),
    "workspace-agent-plugins"
  );
  assert.equal(
    renderBankIdTemplate("workspace-{project}", "default", { project: "" }),
    "workspace"
  );
  // Unknown placeholder falls back cleanly
  assert.equal(
    renderBankIdTemplate("workspace-{unknown}", "default", { project: "x" }),
    "default"
  );
});

test("resolveProjectName handles normal git repo, linked worktree, symlink, and non-repo dirs", () => {
  const tmp = makeTempDir();
  try {
    const home = path.join(tmp, "home");
    const repo = path.join(home, "projects", "my-repo");
    const subdir = path.join(repo, "packages", "core");
    fs.mkdirSync(path.join(repo, ".git", "worktrees", "wt1"), { recursive: true });
    fs.mkdirSync(subdir, { recursive: true });

    // Linked worktree pointing to repo/.git/worktrees/wt1 -> commondir ../..
    const wt = path.join(home, "worktrees", "my-repo-feature");
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(
      path.join(wt, ".git"),
      `gitdir: ${path.join(repo, ".git", "worktrees", "wt1")}\n`,
      "utf8"
    );
    fs.writeFileSync(path.join(repo, ".git", "worktrees", "wt1", "commondir"), "../..\n", "utf8");

    // Symlink/junction outside repo pointing into subdir inside repo
    const linkPath = path.join(home, "linked-core");
    fs.symlinkSync(subdir, linkPath, process.platform === "win32" ? "junction" : "dir");

    // Non-repo directory under home
    const nonRepo = path.join(home, "scratch");
    fs.mkdirSync(nonRepo, { recursive: true });

    assert.equal(findRepositoryRoot(subdir, { homeDir: home }), fs.realpathSync(repo));
    assert.equal(resolveMainRepositoryName(fs.realpathSync(repo)), "my-repo");
    assert.equal(resolveProjectName(subdir, { homeDir: home }), "my-repo");
    assert.equal(resolveProjectName(wt, { homeDir: home }), "my-repo");
    assert.equal(resolveProjectName(linkPath, { homeDir: home }), "my-repo");
    assert.equal(resolveProjectName(nonRepo, { homeDir: home }), "");
    assert.equal(resolveProjectName(home, { homeDir: home }), "");
    assert.equal(
      resolveProjectName({ cwd: nonRepo, workspacePaths: [linkPath] }, { homeDir: home }),
      "my-repo"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("normalizeMinScores, normalizeStringList, and clearsMinScores enforce stage floors accurately", () => {
  assert.deepEqual(normalizeStringList("workspace, default, workspace"), ["workspace", "default"]);
  assert.deepEqual(normalizeStringList('["workspace", "default"]'), ["workspace", "default"]);
  assert.deepEqual(normalizeMinScores({ semantic: 0.7, bad: true, nan: Number.NaN }), {
    semantic: 0.7,
  });
  assert.equal(normalizeMinScores({}), null);

  const floor = { semantic: 0.7 };
  assert.equal(clearsMinScores({ text: "ok", scores: { semantic: 0.72, final: 1.0 } }, floor), true);
  assert.equal(clearsMinScores({ text: "low", scores: { semantic: 0.65, final: 1.0 } }, floor), false);
  // Missing semantic stage (graph/bm25-only hit) is rejected when semantic floor is active
  assert.equal(clearsMinScores({ text: "graph-only", scores: { semantic: null, final: 1.0 } }, floor), false);
  // Older server returning no scores object at all passes through
  assert.equal(clearsMinScores({ text: "legacy" }, floor), true);
});

test("multi-bank recall merges primary + additional banks with dedup, min_scores filtering, and graceful 404/error handling", async () => {
  const requests = [];
  const { server, url } = await startMockServer((req, res, body) => {
    const parsed = body ? JSON.parse(body) : null;
    requests.push({ url: req.url, body: parsed });

    if (req.url === "/v1/default/banks/workspace-my-repo/memories/recall") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            { text: "Project fact A", scores: { semantic: 0.81, final: 1.0 } },
            { text: "Shared fact", scores: { semantic: 0.75, final: 0.9 } },
            { text: "Graph noise", scores: { semantic: null, final: 0.95 } },
          ],
        })
      );
      return;
    }
    if (req.url === "/v1/default/banks/workspace/memories/recall") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            { text: "Shared fact", scores: { semantic: 0.79, final: 1.0 } },
            { text: "Global host pref", scores: { semantic: 0.73, final: 0.9 } },
            { text: "Below floor", scores: { semantic: 0.62, final: 0.8 } },
          ],
        })
      );
      return;
    }
    if (req.url === "/v1/default/banks/broken-extra/memories/recall") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "boom" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: "not found" }));
  });

  try {
    const cfg = {
      apiUrl: url,
      apiKey: "tok",
      bankId: "default",
      budget: "low",
      maxTokens: 2048,
      recallTags: ["profile:workspace"],
      recallTagsMatch: "any_strict",
      recallTypes: ["observation"],
      recallAdditionalBanks: ["workspace", "broken-extra"],
      recallMinScores: { semantic: 0.7 },
      recallTimeoutMs: 5000,
    };

    const res = await recallMemories(cfg, "how does docker run?", {
      bankId: "workspace-my-repo",
      recallBanks: ["workspace-my-repo", "workspace", "broken-extra"],
    });
    assert.deepEqual(
      res.results.map((r) => r.text),
      ["Project fact A", "Shared fact", "Global host pref"]
    );
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[0].body.min_scores, { semantic: 0.7 });
    assert.equal(requests[0].body.budget, "low");
    assert.equal(requests[0].body.max_tokens, 2048);

    // Brand-new primary bank returning 404 still returns additional bank results cleanly
    const cold = await recallMemories(cfg, "global pref", {
      bankId: "workspace-brand-new",
      recallBanks: ["workspace-brand-new", "workspace"],
    });
    assert.deepEqual(
      cold.results.map((r) => r.text),
      ["Shared fact", "Global host pref"]
    );
  } finally {
    server.close();
  }
});

test("hooks and MCP proxy route dynamically by bankIdTemplate for repo vs outside-repo workspaces", async () => {
  const tmp = makeTempDir();
  const seen = [];
  const { server, url } = await startMockServer((req, res, body) => {
    seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.endsWith("/memories/recall")) {
      res.end(JSON.stringify({ results: [{ text: "Repo rule", scores: { semantic: 0.85 } }] }));
    } else {
      res.end(JSON.stringify({ ok: true }));
    }
  });

  try {
    const home = path.join(tmp, "home");
    const repo = path.join(home, "projects", "demo-app");
    const outside = path.join(home, "notes");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    const cfgDir = path.join(tmp, "cfg");
    const stateDir = path.join(tmp, "state");
    writeProfileConfigAtomic(
      cfgDir,
      "workspace",
      createStarterProfileConfig("workspace", {
        apiUrl: url,
        bankId: "default",
        bankIdTemplate: "workspace-{project}",
        recallAdditionalBanks: ["workspace"],
        recallMinScores: { semantic: 0.7 },
        budget: "low",
        maxTokens: 2048,
        recallTags: ["profile:workspace"],
        retainTags: ["profile:workspace"],
      })
    );

    const cfg = loadProfileConfig("workspace", { configDir: cfgDir, env: {} });
    const repoBank = resolveEffectiveBank(cfg, { cwd: repo }, { homeDir: home });
    assert.equal(repoBank.bankId, "workspace-demo-app");
    assert.deepEqual(repoBank.recallBanks, ["workspace-demo-app", "workspace"]);
    assert.equal(repoBank.mcpUrl, `${url}/mcp/workspace-demo-app/`);

    const outsideBank = resolveEffectiveBank(cfg, { cwd: outside }, { homeDir: home });
    assert.equal(outsideBank.bankId, "workspace");
    // Dedupes additional bank when primary bank IS already "workspace"
    assert.deepEqual(outsideBank.recallBanks, ["workspace"]);

    const opts = {
      configDir: cfgDir,
      stateDir,
      homeDir: home,
      disableAgentProfiles: true,
      env: { AGENT_PROFILE: "workspace" },
    };

    const startOut = handleSessionStart("agy", { conversationId: "c1", cwd: repo }, opts);
    assert.match(
      startOut.injectSteps[0].systemMessage.systemMessage,
      /Hindsight bank: `workspace-demo-app` \(additional read-only: `workspace`\)/
    );

    const tr = path.join(tmp, "tr.jsonl");
    fs.writeFileSync(
      tr,
      [
        JSON.stringify({ type: "USER_INPUT", step_index: 1, content: "demo rule?", created_at: "2026-01-01T00:00:00Z" }),
        JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 2, content: "ok" }),
      ].join("\n") + "\n",
      "utf8"
    );

    const recallOut = await handleRecallHook(
      "agy",
      { conversationId: "c1", cwd: repo, transcriptPath: tr, lastUserInput: "demo rule?" },
      opts
    );
    assert.match(recallOut.injectSteps[0].systemMessage.systemMessage, /bank:workspace-demo-app/);
    assert.equal(seen[0].url, "/v1/default/banks/workspace-demo-app/memories/recall");
    assert.equal(seen[1].url, "/v1/default/banks/workspace/memories/recall");

    let job = null;
    handleStopHook(
      "agy",
      { conversationId: "c1", cwd: repo, transcriptPath: tr, terminationReason: "NO_TOOL_CALL", fullyIdle: true },
      { ...opts, dispatchWorker: (j) => { job = j; } }
    );
    assert.equal(job.bankId, "workspace-demo-app");
    const jobFile = path.join(tmp, "job.json");
    fs.writeFileSync(jobFile, JSON.stringify(job), "utf8");
    await handleRetainWorker(jobFile, opts);
    assert.equal(seen[2].url, "/v1/default/banks/workspace-demo-app/memories");

    const proxy = createMcpProxy({ ...opts, cwd: repo });
    assert.equal(proxy.cfg.bankId, "workspace-demo-app");
    assert.equal(proxy.cfg.mcpUrl, `${url}/mcp/workspace-demo-app/`);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pure bank-isolated mode supports observationScopes='shared' and omits tags/tags_match when empty", async () => {
  assert.equal(normalizeObservationScopes("shared"), "shared");
  assert.equal(normalizeObservationScopes("combined"), "combined");
  assert.deepEqual(normalizeObservationScopes(["a", "b"]), [["a", "b"]]);
  assert.deepEqual(normalizeObservationScopes('[["x"]]'), [["x"]]);
  assert.equal(normalizeObservationScopes("invalid_mode"), null);

  const tmp = makeTempDir();
  const seen = [];
  const { server, url } = await startMockServer((req, res, body) => {
    seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.endsWith("/memories/recall")) {
      res.end(JSON.stringify({ results: [{ text: "Bank-only fact", scores: { semantic: 0.88 } }] }));
    } else {
      res.end(JSON.stringify({ ok: true }));
    }
  });

  try {
    const home = path.join(tmp, "home");
    const repo = path.join(home, "projects", "clean-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

    const cfgDir = path.join(tmp, "cfg");
    const stateDir = path.join(tmp, "state");
    // Pure minimal config: no recallTags, retainTags, or observationScopes keys needed
    const minimalCfg = createStarterProfileConfig("workspace", {
      apiUrl: url,
      bankId: "workspace",
      bankIdTemplate: "workspace-{project}",
      recallAdditionalBanks: ["workspace"],
      maxTokens: 2048,
      recallMinScores: { semantic: 0.69 },
    });
    assert.equal("recallTags" in minimalCfg, false);
    assert.equal("retainTags" in minimalCfg, false);
    assert.equal("observationScopes" in minimalCfg, false);
    writeProfileConfigAtomic(cfgDir, "workspace", minimalCfg);

    const cfg = loadProfileConfig("workspace", { configDir: cfgDir, env: {} });
    assert.deepEqual(cfg.recallTags, []);
    assert.deepEqual(cfg.retainTags, []);
    assert.equal(cfg.observationScopes, "shared");

    const opts = {
      configDir: cfgDir,
      stateDir,
      homeDir: home,
      disableAgentProfiles: true,
      env: { AGENT_PROFILE: "workspace" },
    };

    const startOut = handleSessionStart("agy", { conversationId: "c2", cwd: repo }, opts);
    const startText = startOut.injectSteps[0].systemMessage.systemMessage;
    assert.match(startText, /Hindsight bank: `workspace-clean-repo` \(additional read-only: `workspace`\) \(bank-isolated; no profile tags required\)/);
    assert.doesNotMatch(startText, /tags_match/);

    const tr = path.join(tmp, "tr.jsonl");
    fs.writeFileSync(
      tr,
      [
        JSON.stringify({ type: "USER_INPUT", step_index: 1, content: "clean repo fact?", created_at: "2026-01-01T00:00:00Z" }),
        JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 2, content: "done" }),
      ].join("\n") + "\n",
      "utf8"
    );

    const recallOut = await handleRecallHook(
      "agy",
      { conversationId: "c2", cwd: repo, transcriptPath: tr, lastUserInput: "clean repo fact?" },
      opts
    );
    assert.match(
      recallOut.injectSteps[0].systemMessage.systemMessage,
      /# Hindsight Memory \(bank:workspace-clean-repo, workspace — /
    );
    assert.equal("tags" in seen[0].body, false);
    assert.equal("tags_match" in seen[0].body, false);

    let job = null;
    handleStopHook(
      "agy",
      { conversationId: "c2", cwd: repo, transcriptPath: tr, terminationReason: "NO_TOOL_CALL", fullyIdle: true },
      { ...opts, dispatchWorker: (j) => { job = j; } }
    );
    const jobFile = path.join(tmp, "job.json");
    fs.writeFileSync(jobFile, JSON.stringify(job), "utf8");
    await handleRetainWorker(jobFile, opts);

    const retainItem = seen[2].body.items[0];
    assert.deepEqual(retainItem.tags, ["session:agy-c2"]);
    assert.equal(retainItem.observation_scopes, "shared");
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
