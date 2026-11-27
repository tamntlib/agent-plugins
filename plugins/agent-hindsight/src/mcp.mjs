import readline from "node:readline";
import { loadProfileConfig, resolveEffectiveBank } from "./config.mjs";
import { resolveHindsightProfile } from "./profile.mjs";

/**
 * Parse Streamable HTTP response body (either JSON or SSE `data:` frames) into JSON-RPC payloads.
 */
export function parseMcpHttpResponse(contentType, text) {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    return [];
  }
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("text/event-stream")) {
    const messages = [];
    let dataLines = [];
    const flush = () => {
      if (dataLines.length === 0) return;
      const joined = dataLines.join("\n").trim();
      dataLines = [];
      if (!joined || joined === "[DONE]") return;
      try {
        messages.push(JSON.parse(joined));
      } catch {
        // Ignore malformed SSE event chunk.
      }
    };
    for (const line of trimmed.split(/\r?\n/)) {
      if (line === "") {
        flush();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    flush();
    return messages;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/**
 * Zero-dependency MCP Stdio <-> Streamable HTTP proxy for Hindsight.
 * Reads connection URL and Bearer token from local profile config / .env at runtime,
 * keeping secrets completely out of mcp_config.json and plugin repositories.
 */
export function createMcpProxy(options = {}) {
  const cwd = options.cwd || process.cwd();
  const prof = resolveHindsightProfile({ cwd }, options);
  if (!prof.valid || !prof.profile) {
    const reason = prof.error || "Active profile is unresolved.";
    return {
      cfg: null,
      bankInfo: null,
      blocked: true,
      error: reason,
      async forward(message) {
        if (message?.id !== undefined) {
          return [
            {
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32002,
                message: `Hindsight MCP blocked (fail-closed): ${reason}`,
              },
            },
          ];
        }
        return [];
      },
    };
  }

  const cfg = loadProfileConfig(prof.profile, options);
  if (cfg.configError) {
    const reason = cfg.configError;
    return {
      cfg,
      bankInfo: null,
      blocked: true,
      error: reason,
      async forward(message) {
        if (message?.id !== undefined) {
          return [
            {
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32002,
                message: `Hindsight MCP blocked (config error): ${reason}`,
              },
            },
          ];
        }
        return [];
      },
    };
  }

  if (cfg.memoryMode === "context") {
    const reason = 'MCP tools are disabled while memoryMode="context".';
    return {
      cfg,
      bankInfo: resolveEffectiveBank(cfg, { cwd }, options),
      blocked: true,
      error: reason,
      async forward(message) {
        if (message?.id !== undefined) {
          return [
            {
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32002,
                message: `Hindsight MCP disabled: ${reason}`,
              },
            },
          ];
        }
        return [];
      },
    };
  }

  const bankInfo = resolveEffectiveBank(cfg, { cwd }, options);
  const mcpUrl = bankInfo.mcpUrl;
  const fetchImpl = options.fetchImpl ?? fetch;
  let sessionId = null;

  async function forward(message) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (cfg.apiKey) {
      headers.Authorization = `Bearer ${cfg.apiKey}`;
    }
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);
    try {
      const resp = await fetchImpl(mcpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      const nextSession = resp.headers?.get?.("mcp-session-id");
      if (nextSession) {
        sessionId = nextSession;
      }

      if (resp.status === 202 || resp.status === 204) {
        return [];
      }

      const bodyText = await resp.text();
      if (!resp.ok) {
        if (message.id !== undefined) {
          return [
            {
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32000,
                message: `Hindsight MCP HTTP ${resp.status}: ${bodyText.slice(0, 200)}`,
              },
            },
          ];
        }
        return [];
      }

      return parseMcpHttpResponse(resp.headers?.get?.("content-type") || "", bodyText);
    } catch (err) {
      if (message.id !== undefined) {
        return [
          {
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32001,
              message: `Hindsight MCP connection error (${mcpUrl}): ${err.message}`,
            },
          },
        ];
      }
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  return { cfg: { ...cfg, bankId: bankInfo.bankId, mcpUrl }, bankInfo, forward };
}

export async function runMcpStdio(options = {}) {
  const { forward } = createMcpProxy(options);
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const responses = await forward(message);
    for (const res of responses) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
    }
  }
}
